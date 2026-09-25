import { z } from 'zod';
import type { CallToolResult, ItemTypeKey, RegisteredTool, TaigaHistoryEntry, TaigaWikiPage, TaigaWorkItem, ToolAnnotations } from '../types.js';
import { get, post } from '../api.js';
import { itemType, patchItem, resolveItem, resolveWikiPage } from '../taiga.js';
import { commentLine, listing } from '../format.js';
import { createSuccessResponse, guard } from '../utils.js';
import { SUCCESS_MESSAGES } from '../constants.js';

const inputSchema = z.object({
  op: z.enum(['list', 'add', 'edit', 'delete']).describe('Operation to perform'),
  type: z.enum(['issue', 'story', 'user_story', 'task', 'epic', 'wiki']).optional().describe('Item type'),
  item: z.union([z.number(), z.string()]).optional().describe('Item ID, #reference, or wiki slug'),
  project: z.string().optional().describe('Project ID or slug (required for #ref or wiki slug)'),
  text: z.string().optional().describe('Comment markdown text (add, edit)'),
  commentId: z.string().optional().describe('Comment UUID (edit, delete)'),
  includeDeleted: z.boolean().optional().describe('Include soft-deleted comments (list)'),
});

type Args = z.output<typeof inputSchema>;

const description = `List, add, edit, or delete comments on issues, user stories, tasks, epics, and wiki pages. Note: Taiga soft-deletes comments on delete.

| op | required args | optional args |
| list | type, item | project, includeDeleted |
| add | type, item, text | project |
| edit | type, item, commentId, text | project |
| delete | type, item, commentId | project |`;
const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const handler = async ({ op, type, item, project, text, commentId, includeDeleted }: Args): Promise<CallToolResult> => {
      if (!type) {
        throw new Error(`Item type is required for op "${op}". Expected one of: issue, story, task, epic, wiki`);
      }
      if (item === undefined || item === null || item === '') {
        throw new Error(`Item identifier is required for op "${op}".`);
      }
      const normalizedType: ItemTypeKey = type === 'story' ? 'user_story' : type;
      const meta = itemType(normalizedType);
      let targetId: number;
      let targetVersion: number | undefined;
      let ref: string;

      if (normalizedType === 'wiki') {
        const target = await resolveWikiPage(item, project);
        targetId = target.id;
        targetVersion = target.version;
        ref = target.slug || `#${target.id}`;
      } else {
        const target = await resolveItem(normalizedType, item, project);
        targetId = target.id;
        targetVersion = target.version;
        ref = target.ref ? `#${target.ref}` : `#${target.id}`;
      }
      switch (op) {
        case 'list': {
          const history = await get<TaigaHistoryEntry[]>(`/history/${meta.history}/${targetId}`, { type: 'comment' });
          const rawEntries = Array.isArray(history) ? history : [];
          const entries = includeDeleted
            ? rawEntries
            : rawEntries.filter((e) => !e.delete_comment_date);
          entries.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
          return createSuccessResponse(
            listing(`comments on ${meta.label} ${ref}`, entries.map(commentLine)),
          );
        }

        case 'add': {
          if (!text) {
            throw new Error('Comment text is required for op "add".');
          }
          await patchItem<TaigaWorkItem | TaigaWikiPage>(normalizedType, { id: targetId, version: targetVersion }, { comment: text });
          return createSuccessResponse(`${SUCCESS_MESSAGES.COMMENT_ADDED} on ${meta.label} ${ref}.\n\n${text}`);
        }

        case 'edit': {
          if (!commentId) {
            throw new Error('commentId (UUID) is required for op "edit".');
          }
          if (!text) {
            throw new Error('Comment text is required for op "edit".');
          }
          await post<TaigaHistoryEntry>(`/history/${meta.history}/${targetId}/edit_comment?id=${encodeURIComponent(commentId)}`, { comment: text });
          return createSuccessResponse(`${SUCCESS_MESSAGES.COMMENT_EDITED} on ${meta.label} ${ref} (comment: ${commentId}).\n\n${text}`);
        }

        case 'delete': {
          if (!commentId) {
            throw new Error('commentId (UUID) is required for op "delete".');
          }
          await post<TaigaHistoryEntry>(`/history/${meta.history}/${targetId}/delete_comment?id=${encodeURIComponent(commentId)}`);
          return createSuccessResponse(`${SUCCESS_MESSAGES.COMMENT_DELETED} on ${meta.label} ${ref} (comment: ${commentId}).`);
        }

        default:
          throw new Error(`Unknown operation "${op}".`);
      }
};

export const tools: RegisteredTool[] = [
  {
    name: 'comments',
    title: 'Comments',
    description,
    inputSchema,
    annotations,
    register(server) {
      server.registerTool('comments', { title: 'Comments', description, inputSchema, annotations }, guard(handler));
    },
  },
];
