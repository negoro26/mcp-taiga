import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import axios from 'axios';
import { z } from 'zod';
import { apiBaseUrl, get, del, request } from '../api.js';
import { isNumericId, resolveProjectId, resolveItem, itemType } from '../taiga.js';
import { createSuccessResponse, guard } from '../utils.js';
import { attachmentLine, details, listing } from '../format.js';
import { MAX_ATTACHMENT_BYTES } from '../constants.js';
import type { CallToolResult, ItemTypeKey, RegisteredTool, TaigaAttachment, TaigaWikiPage, TaigaWorkItem, ToolAnnotations } from '../types.js';

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  rtf: 'application/rtf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  yaml: 'text/yaml',
  yml: 'text/yaml',
} satisfies Record<string, string>;

function detectMimeType(fileName?: string): string {
  if (!fileName) return 'application/octet-stream';
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext && ext in MIME_TYPES) {
    // SAFETY: `in` check proves `ext` is a valid key of MIME_TYPES
    return MIME_TYPES[ext as keyof typeof MIME_TYPES];
  }
  return 'application/octet-stream';
}

async function resolveTargetItem(
  type: ItemTypeKey,
  item: string | number,
  project?: string | number,
): Promise<TaigaWorkItem | TaigaWikiPage> {
  if (type === 'wiki') {
    const raw = String(item).trim();
    if (isNumericId(raw)) {
      return get<TaigaWikiPage>(`/wiki/${raw}`);
    }
    if (!project) {
      throw new Error('Project ID or slug is required when resolving a wiki page by slug.');
    }
    const projectId = await resolveProjectId(project);
    return get<TaigaWikiPage>('/wiki/by_slug', { slug: raw, project: projectId });
  }
  return resolveItem(type, item, project);
}

const inputSchema = {
  op: z.enum(['list', 'upload', 'download', 'delete']).describe('Operation to perform: list, upload, download, delete'),
  type: z.enum(['issue', 'story', 'user_story', 'task', 'epic', 'wiki']).optional().describe('Target item type (issue, story, task, epic, wiki)'),
  item: z.union([z.string(), z.number()]).optional().describe('Item numeric ID, #ref, or wiki slug'),
  project: z.union([z.string(), z.number()]).optional().describe('Project ID or slug (required for #ref or wiki slug)'),
  attachmentId: z.union([z.string(), z.number()]).optional().describe('Attachment ID for download or delete'),
  filePath: z.string().optional().describe('Local file path on the machine running this server to upload to the Taiga host (the omp harness resolves local:// URIs to filesystem paths before invoking this tool)'),
  fileContent: z.string().optional().describe('Base64-encoded file content to upload'),
  fileName: z.string().optional().describe('File name including extension'),
  mimeType: z.string().optional().describe('MIME type of uploaded file'),
  description: z.string().optional().describe('Attachment description text'),
  savePath: z.string().optional().describe('Local filesystem path to save downloaded file'),
};

type Args = z.output<z.ZodObject<typeof inputSchema>>;

const description = `List, upload, download, or delete attachments across work items and wiki pages.

| op | required args | optional args | notes |
|---|---|---|---|
| list | type, item | project | List attachments on a work item or wiki page |
| upload | type, item, filePath OR fileContent | project, fileName, mimeType, description | Upload file to Taiga host from local path (harness resolves local:// URIs) or base64 |
| download | type, attachmentId | savePath | Fetch metadata and bytes; writes to savePath when given |
| delete | type, attachmentId | | Delete attachment by ID |`;

const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const handler = async ({
  op,
  type,
  item,
  project,
  attachmentId,
  filePath,
  fileContent,
  fileName,
  mimeType,
  description,
  savePath,
}: Args): Promise<CallToolResult> => {
      if (op === 'list') {
        if (!type) throw new Error('type is required for op "list" (issue, story, task, epic, wiki).');
        if (!item) throw new Error('item is required for op "list" (numeric ID, #ref, or wiki slug).');

        const targetType: ItemTypeKey = type === 'story' ? 'user_story' : type;
        const meta = itemType(targetType);
        const target = await resolveTargetItem(targetType, item, project);
        const attachments = await get<TaigaAttachment[]>(meta.attachments, {
          object_id: target.id,
          project: target.project,
        });

        const targetLabel = ('ref' in target && target.ref)
          ? `#${target.ref}`
          : (('slug' in target && target.slug) || `id=${target.id}`);
        const title = `attachments for ${meta.label.toLowerCase()} ${targetLabel}`;
        const rows = (attachments || []).map(attachmentLine);
        return createSuccessResponse(listing(title, rows));
      }

      if (op === 'upload') {
        if (!type) throw new Error('type is required for op "upload" (issue, story, task, epic, wiki).');
        if (!item) throw new Error('item is required for op "upload" (numeric ID, #ref, or wiki slug).');

        const hasFilePath = Boolean(filePath?.trim());
        const hasFileContent = Boolean(fileContent?.trim());
        if ((hasFilePath && hasFileContent) || (!hasFilePath && !hasFileContent)) {
          throw new Error('Exactly one of filePath or fileContent must be provided for op "upload".');
        }

        let buffer: Buffer;
        let resolvedFileName = fileName?.trim();

        if (hasFilePath) {
          const trimmedPath = filePath ? filePath.trim() : '';
          buffer = await readFile(trimmedPath);
          if (!resolvedFileName) {
            resolvedFileName = basename(trimmedPath);
          }
        } else {
          const content = fileContent ? fileContent.trim() : '';
          buffer = Buffer.from(content, 'base64');
          if (buffer.length === 0 && content.length > 0) {
            throw new Error('Failed to decode base64 fileContent: invalid base64 data.');
          }
          if (!resolvedFileName) {
            throw new Error('fileName is required when uploading using fileContent.');
          }
        }

        if (buffer.length > MAX_ATTACHMENT_BYTES) {
          const maxMb = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
          const actualMb = (buffer.length / (1024 * 1024)).toFixed(2);
          throw new Error(`Attachment size (${actualMb} MB) exceeds the maximum allowed size of ${maxMb} MB.`);
        }

        const targetType: ItemTypeKey = type === 'story' ? 'user_story' : type;
        const meta = itemType(targetType);
        const target = await resolveTargetItem(targetType, item, project);
        const resolvedMimeType = mimeType?.trim() || detectMimeType(resolvedFileName);
        const blob = new Blob([Uint8Array.from(buffer)], { type: resolvedMimeType });

        const form = new FormData();
        form.append('object_id', String(target.id));
        form.append('project', String(target.project));
        form.append('attached_file', blob, resolvedFileName);
        if (description?.trim()) {
          form.append('description', description.trim());
        }

        const attachment = await request<TaigaAttachment>('POST', meta.attachments, { data: form });
        const targetLabel = ('ref' in target && target.ref)
          ? `#${target.ref}`
          : (('slug' in target && target.slug) || `id=${target.id}`);
        return createSuccessResponse(`Uploaded ${attachmentLine(attachment)} to ${meta.label.toLowerCase()} ${targetLabel}`);
      }

      if (op === 'download') {
        if (!type) throw new Error('type is required for op "download" (issue, story, task, epic, wiki).');
        if (!attachmentId) throw new Error('attachmentId is required for op "download".');

        const id = Number(attachmentId);
        if (!id || Number.isNaN(id)) {
          throw new Error(`Invalid attachment ID "${attachmentId}".`);
        }

        const targetType: ItemTypeKey = type === 'story' ? 'user_story' : type;
        const meta = itemType(targetType);
        const attachment = await get<TaigaAttachment>(`${meta.attachments}/${id}`);
        if (!attachment?.url) {
          throw new Error(`Attachment ${id} does not contain a download URL.`);
        }

        const downloadUrl = new URL(attachment.url);
        if (downloadUrl.protocol !== 'http:' && downloadUrl.protocol !== 'https:') {
          throw new Error(`Refusing to download attachment: unsupported protocol "${downloadUrl.protocol}" (must be http: or https:).`);
        }

        const taigaUrl = new URL(apiBaseUrl());
        if (downloadUrl.hostname !== taigaUrl.hostname) {
          throw new Error(`Refusing to download attachment from host "${downloadUrl.hostname}": does not match Taiga host "${taigaUrl.hostname}".`);
        }

        // Bare axios call is used so the media host does not receive the Taiga bearer token.
        const { data } = await axios.get<ArrayBuffer>(downloadUrl.toString(), {
          responseType: 'arraybuffer',
          maxRedirects: 0,
          timeout: 30000,
          maxContentLength: MAX_ATTACHMENT_BYTES,
          maxBodyLength: MAX_ATTACHMENT_BYTES,
        });
        const buffer = Buffer.from(data);
        const base64 = buffer.toString('base64');
        const detectedMime = detectMimeType(attachment.name || '');

        let text: string;
        if (savePath?.trim()) {
          const dest = resolve(savePath.trim());
          let exists = false;
          try {
            await access(dest);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) {
            throw new Error(`File already exists at "${dest}". Refusing to overwrite existing file; please choose another path.`);
          }
          await writeFile(dest, buffer);
          text = `Saved attachment ${attachment.id} (${attachment.name || 'unnamed'}, ${buffer.length} bytes) to ${dest}`;
        } else {
          const sizeStr = attachment.size !== undefined && attachment.size !== null
            ? `${attachment.size} bytes`
            : `${buffer.length} bytes`;
          text = details([
            ['Attachment', attachment.id],
            ['Name', attachment.name || '-'],
            ['Size', sizeStr],
            ['MIME', detectedMime],
            ['URL', attachment.url],
            ['Note', 'Provide savePath to write bytes to a file.'],
          ]);
        }

        return {
          content: [
            {
              type: 'resource',
              resource: {
                uri: attachment.url,
                mimeType: detectedMime,
                blob: base64,
              },
            },
            {
              type: 'text',
              text,
            },
          ],
        };
      }

      if (op === 'delete') {
        if (!type) throw new Error('type is required for op "delete" (issue, story, task, epic, wiki).');
        if (!attachmentId) throw new Error('attachmentId is required for op "delete".');

        const id = Number(attachmentId);
        if (!id || Number.isNaN(id)) {
          throw new Error(`Invalid attachment ID "${attachmentId}".`);
        }

        const targetType: ItemTypeKey = type === 'story' ? 'user_story' : type;
        const meta = itemType(targetType);
        await del(`${meta.attachments}/${id}`);
        return createSuccessResponse(`Deleted attachment ${id}`);
      }

      throw new Error(`Unknown op: "${op}". Valid ops: list, upload, download, delete`);
};

export const tools: RegisteredTool[] = [
  {
    name: 'attachments',
    title: 'Attachments',
    description,
    inputSchema,
    annotations,
    register(server) {
      server.registerTool('attachments', { title: 'Attachments', description, inputSchema, annotations }, guard(handler));
    },
  },
];
