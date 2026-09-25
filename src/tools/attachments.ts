import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { apiBaseUrl, get, del, request } from '../api.js';
import { resolveItem, itemType, resolveWikiPage } from '../taiga.js';
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
    return MIME_TYPES[ext as keyof typeof MIME_TYPES];
  }
  return 'application/octet-stream';
}

const attachmentSizeError = (size: number): Error => {
  const maxMb = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
  const actualMb = (size / (1024 * 1024)).toFixed(2);
  return new Error(`Attachment size (${actualMb} MB) exceeds the maximum allowed size of ${maxMb} MB.`);
};

async function resolveTargetItem(
  type: ItemTypeKey,
  item: string | number,
  project?: string | number,
): Promise<TaigaWorkItem | TaigaWikiPage> {
  if (type === 'wiki') {
    return resolveWikiPage(item, project);
  }
  return resolveItem(type, item, project);
}

const inputSchema = z.object({
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
  includeContent: z.boolean().optional().describe('Include file bytes in the response (default false; use savePath to write a file)'),
});

type Args = z.output<typeof inputSchema>;

const description = `List, upload, download, or delete attachments across work items and wiki pages.

| op | required args | optional args | notes |
|---|---|---|---|
| list | type, item | project | List attachments on a work item or wiki page |
| upload | type, item, filePath OR fileContent | project, fileName, mimeType, description | Upload file to Taiga host from local path (harness resolves local:// URIs) or base64 |
| download | type, attachmentId | savePath, includeContent | Metadata by default; set includeContent true to return bytes, or savePath to write them to disk |
| delete | type, attachmentId | | Delete attachment by ID |`;
const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

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
  includeContent,
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
          throw attachmentSizeError(buffer.length);
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

        let buffer: Buffer;
        const response = await globalThis.fetch(downloadUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(response.statusText || `Request failed with status code ${response.status}`);
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_BYTES) {
          throw attachmentSizeError(contentLength);
        }
        if (response.body !== null) {
          const reader = response.body.getReader();
          const chunks: Buffer[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_ATTACHMENT_BYTES) {
                await reader.cancel();
                throw attachmentSizeError(size);
              }
              chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
            }
          } finally {
            reader.releaseLock();
          }
          buffer = Buffer.concat(chunks, size);
        } else {
          buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
            throw attachmentSizeError(buffer.byteLength);
          }
        }
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
            ['Note', 'Provide savePath to write bytes to a file, or set includeContent true to return them.'],
          ]);
        }

        const content: CallToolResult['content'] = [];
        if (includeContent === true) {
          content.push({
            type: 'resource',
            resource: {
              uri: attachment.url,
              mimeType: detectedMime,
              blob: buffer.toString('base64'),
            },
          });
        }
        content.push({ type: 'text', text });
        return { content };
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
