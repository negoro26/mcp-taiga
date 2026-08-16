import { z } from 'zod';
import { del, get, post } from '../api.js';
import { API_ENDPOINTS, ERROR_MESSAGES, MAX_BATCH_SIZE } from '../constants.js';
import { assignees, day, details, listing, workLine } from '../format.js';
import {
  findIdByName,
  ITEM_TYPES,
  itemType,
  listTaxonomy,
  patchItem,
  projectUserNames,
  resolveItem,
  resolveMemberId,
  resolveProjectId,
  resolvePointsPayload,
  resolveSprintId,
  resolveTaxonomyId,
} from '../taiga.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ItemTypeKey,
  JsonBody,
  JsonValue,
  QueryParams,
  RegisteredTool,
  TaigaTaxonomyItem,
  TaigaWorkItem,
  TaxonomyKind,
  ToolAnnotations,
} from '../types.js';
import { createSuccessResponse, guard } from '../utils.js';

type WorkType = 'issue' | 'story' | 'task' | 'epic';

const TYPE_MAP = {
  issue: 'issue',
  story: 'user_story',
  task: 'task',
  epic: 'epic',
} satisfies Record<WorkType, ItemTypeKey>;

const TYPE_PLURAL = {
  issue: 'issues',
  story: 'user stories',
  task: 'tasks',
  epic: 'epics',
} satisfies Record<WorkType, string>;

const STATUS_KIND = {
  issue: 'issue_status',
  story: 'user_story_status',
  task: 'task_status',
  epic: 'epic_status',
} satisfies Record<WorkType, TaxonomyKind>;

const TYPE_FIELDS = {
  issue: new Set(['subject', 'description', 'status', 'assignee', 'sprint', 'tags', 'priority', 'severity', 'issueType']),
  story: new Set(['subject', 'description', 'status', 'assignee', 'sprint', 'tags', 'points']),
  task: new Set(['subject', 'description', 'status', 'assignee', 'sprint', 'tags', 'parent']),
  epic: new Set(['subject', 'description', 'status', 'assignee', 'tags', 'color']),
} satisfies Record<WorkType, Set<string>>;

interface FilterOptions {
  assignee?: string;
  watcher?: string;
  sprint?: number | string;
  status?: string;
  tags?: string[] | string;
  closed?: boolean;
  q?: string;
  orderBy?: string;
  parent?: number | string;
}

async function buildFilters(type: WorkType, projectId: number, filters: FilterOptions): Promise<QueryParams> {
  const params: QueryParams = { project: projectId };

  if (filters.assignee !== undefined) {
    const memberId = await resolveMemberId(projectId, filters.assignee);
    if (type === 'story') {
      params.assigned_users = memberId;
    } else {
      params.assigned_to = memberId;
    }
  }

  if (filters.watcher !== undefined) {
    params.watchers = await resolveMemberId(projectId, filters.watcher);
  }

  if (filters.sprint !== undefined) {
    params.milestone = await resolveSprintId(projectId, filters.sprint);
  }

  if (filters.status !== undefined) {
    params.status = await resolveTaxonomyId(STATUS_KIND[type], projectId, filters.status);
  }

  if (filters.tags !== undefined) {
    params.tags = Array.isArray(filters.tags) ? filters.tags.join(',') : filters.tags;
  }

  if (filters.closed !== undefined) {
    if (type === 'story') {
      params.is_closed = filters.closed;
    } else {
      params.status__is_closed = filters.closed;
    }
  }

  if (filters.q) params.q = filters.q;
  if (filters.orderBy) params.order_by = filters.orderBy;

  if (filters.parent !== undefined) {
    if (type === 'task') {
      const story = await resolveItem('user_story', filters.parent, projectId);
      params.user_story = story.id;
    } else if (type === 'story') {
      const epic = await resolveItem('epic', filters.parent, projectId);
      params.epic = epic.id;
    }
  }

  return params;
}

interface TaxonomyCache {
  types?: TaigaTaxonomyItem[];
  priorities?: TaigaTaxonomyItem[];
  severities?: TaigaTaxonomyItem[];
  statuses?: TaigaTaxonomyItem[];
}

interface WorkItemInputFields {
  subject?: string;
  description?: string;
  status?: string;
  assignee?: string;
  sprint?: number | string;
  tags?: string[];
  priority?: string;
  severity?: string;
  issueType?: string;
  points?: number | string;
  color?: string;
  parent?: number | string | null;
  [key: string]: JsonValue | undefined;
}

interface BatchItemFailure {
  item: WorkItemInputFields;
  error: string;
}

async function buildPayload(
  type: WorkType,
  projectId: number,
  fields: WorkItemInputFields,
  taxonomyCache: TaxonomyCache | null = null,
  storyCache: Map<string, TaigaWorkItem> | null = null,
  defaultParent: number | string | null = null,
): Promise<JsonBody> {
  const allowed = TYPE_FIELDS[type];
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined || allowed.has(key)) continue;
    if (key === 'parent' && type === 'story') {
      // Epic membership is a relation, not a field on the story: PATCHing an `epic` key is
      // silently ignored by Taiga, so point the caller at the ops that actually work.
      throw new Error('A story\'s epic cannot be set with update. Use op "link" or "unlink" with parent set to the epic.');
    }
    throw new Error(`Field "${key}" is not supported for ${type}.`);
  }

  const payload: JsonBody = {};
  if (fields.subject !== undefined) payload.subject = fields.subject;
  if (fields.description !== undefined) payload.description = fields.description;
  if (fields.tags !== undefined) payload.tags = fields.tags;
  if (fields.points !== undefined) {
    payload.points = await resolvePointsPayload(projectId, fields.points);
  }
  if (fields.color !== undefined) payload.color = fields.color;

  if (fields.status !== undefined) {
    if (taxonomyCache?.statuses) {
      const id = findIdByName(taxonomyCache.statuses, fields.status);
      if (id === undefined) {
        throw new Error(`No status named "${fields.status}" in this project. Available: ${taxonomyCache.statuses.map((s) => s.name).join(', ')}`);
      }
      payload.status = id;
    } else {
      payload.status = await resolveTaxonomyId(STATUS_KIND[type], projectId, fields.status);
    }
  }

  if (fields.priority !== undefined) {
    if (taxonomyCache?.priorities) {
      const id = findIdByName(taxonomyCache.priorities, fields.priority);
      if (id === undefined) {
        throw new Error(`No priority named "${fields.priority}" in this project. Available: ${taxonomyCache.priorities.map((p) => p.name).join(', ')}`);
      }
      payload.priority = id;
    } else {
      payload.priority = await resolveTaxonomyId('priority', projectId, fields.priority);
    }
  }

  if (fields.severity !== undefined) {
    if (taxonomyCache?.severities) {
      const id = findIdByName(taxonomyCache.severities, fields.severity);
      if (id === undefined) {
        throw new Error(`No severity named "${fields.severity}" in this project. Available: ${taxonomyCache.severities.map((s) => s.name).join(', ')}`);
      }
      payload.severity = id;
    } else {
      payload.severity = await resolveTaxonomyId('severity', projectId, fields.severity);
    }
  }

  if (fields.issueType !== undefined) {
    if (taxonomyCache?.types) {
      const id = findIdByName(taxonomyCache.types, fields.issueType);
      if (id === undefined) {
        throw new Error(`No issue type named "${fields.issueType}" in this project. Available: ${taxonomyCache.types.map((t) => t.name).join(', ')}`);
      }
      payload.type = id;
    } else {
      payload.type = await resolveTaxonomyId('issue_type', projectId, fields.issueType);
    }
  }

  if (fields.assignee !== undefined) {
    payload.assigned_to = await resolveMemberId(projectId, fields.assignee);
  }

  if (fields.sprint !== undefined) {
    payload.milestone = await resolveSprintId(projectId, fields.sprint);
  }

  if (type === 'task') {
    const parentIdent = fields.parent ?? defaultParent;
    if (parentIdent !== undefined && parentIdent !== null) {
      const cacheKey = String(parentIdent);
      let story = storyCache?.get(cacheKey);
      if (!story) {
        story = await resolveItem('user_story', parentIdent, projectId);
        if (storyCache) storyCache.set(cacheKey, story);
      }
      payload.user_story = story.id;
    }
  }

  return payload;
}

function renderDetail(item: TaigaWorkItem, namesById?: Map<number, string>): string {
  let desc = item.description;
  if (desc && desc.length > 2000) {
    desc = `${desc.slice(0, 2000)}…(truncated)`;
  }
  const tagStr = Array.isArray(item.tags)
    ? item.tags.map((t) => (Array.isArray(t) ? t[0] : t)).join(', ')
    : item.tags;

  return details([
    ['ref', `#${item.ref}`],
    ['id', item.id],
    ['subject', item.subject],
    ['status', item.status_extra_info?.name],
    ['sprint', item.milestone_name || item.milestone_extra_info?.name],
    ['assignees', assignees(item, namesById)],
    ['priority', item.priority_extra_info?.name],
    ['severity', item.severity_extra_info?.name],
    ['type', item.type_extra_info?.name],
    ['points', item.total_points !== undefined && item.total_points !== null ? `${item.total_points}pts` : null],
    ['parent story', item.user_story_extra_info ? `#${item.user_story_extra_info.ref} ${item.user_story_extra_info.subject}` : null],
    ['epic', item.epics?.[0] ? `#${item.epics[0].ref} ${item.epics[0].subject}` : (item.epic_extra_info ? `#${item.epic_extra_info.ref} ${item.epic_extra_info.subject}` : null)],
    ['tags', tagStr || null],
    ['watchers', item.total_watchers ?? (item.watchers?.length ? item.watchers.length : null)],
    ['created', day(item.created_date)],
    ['modified', day(item.modified_date)],
    ['description', desc || null],
  ]);
}

const inputSchema = {
  op: z.enum(['list', 'get', 'create', 'update', 'link', 'unlink', 'delete']).describe('Operation to perform'),
  type: z.enum(['issue', 'story', 'task', 'epic']).describe('Work item type'),
  project: z.string().optional().describe('Project ID or slug'),
  item: z.union([z.number().int(), z.string()]).optional().describe('Item numeric ID or #ref'),
  subject: z.string().optional().describe('Item subject or title'),
  description: z.string().optional().describe('Item description markdown'),
  status: z.string().optional().describe('Status name'),
  assignee: z.string().optional().describe('Assignee username, email, full name, ID, or "me"'),
  sprint: z.union([z.number().int(), z.string()]).optional().describe('Sprint ID or name ("none" to clear)'),
  tags: z.array(z.string()).optional().describe('Tags array'),
  priority: z.string().optional().describe('Priority name (issues only)'),
  severity: z.string().optional().describe('Severity name (issues only)'),
  issueType: z.string().optional().describe('Issue type name (issues only)'),
  points: z
    .union([z.number(), z.string()])
    .optional()
    .describe('Points value matching project point deck (e.g. 1, 3, 5, or "?" for unestimated; stories only)'),
  parent: z.union([z.number().int(), z.string()]).optional().describe('Parent story (tasks) or epic (link/unlink)'),
  items: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])))
    .optional()
    .describe('Batch create items array (max 20)'),
  watcher: z.string().optional().describe('Filter by watcher username, email, or "me"'),
  closed: z.boolean().optional().describe('Filter by closed state'),
  q: z.string().optional().describe('Full-text search query'),
  orderBy: z.string().optional().describe('Order by field, prefix "-" for desc'),
  limit: z.number().int().positive().optional().describe('Maximum number of items to return'),
};

type Args = z.output<z.ZodObject<typeof inputSchema>>;

const description = `Manage Taiga work items (issues, user stories, tasks, epics).

Operations:
- list: List items with optional filters (project required).
- get: Get details for a single item (item required).
- create: Create one item or batch items (project and subject/items required).
- update: Modify fields on an item (item required).
- link: Link a user story to an epic (type: story, item: story, parent: epic required).
- unlink: Remove a user story from an epic (type: story, item: story, parent: epic required).
- delete: Permanently delete ONE item (item required). Taiga has no trash for work items, so this cannot be
  undone. Batch is deliberately create-only: up to 20 items can be created in a call, exactly one can be
  deleted, so a mistaken call cannot clear a board.`;

// destructiveHint covers the whole tool because MCP annotations are per-tool, not per-op:
// `delete` can destroy, so the tool must declare it even though list/get/create cannot.
const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const handler = async ({
  op,
  type,
  project,
  item,
  subject,
  description,
  status,
  assignee,
  sprint,
  tags,
  priority,
  severity,
  issueType,
  points,
  parent,
  items,
  watcher,
  closed,
  q,
  orderBy,
  limit,
}: Args): Promise<CallToolResult> => {
  const internalKey = TYPE_MAP[type];

  if (op === 'list') {
    if (!project) throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
    const projectId = await resolveProjectId(project);
    const params = await buildFilters(type, projectId, { assignee, watcher, sprint, status, tags, closed, q, orderBy, parent });
    const all = await get<TaigaWorkItem[]>(ITEM_TYPES[internalKey].path, params);
    const rows = limit ? all.slice(0, limit) : all;
    const hasMulti = rows.some((r) => Array.isArray(r.assigned_users) && r.assigned_users.length > 1);
    const namesById = hasMulti ? await projectUserNames(projectId) : undefined;
    return createSuccessResponse(
      listing(`${TYPE_PLURAL[type]} in ${project}`, rows.map((r) => workLine(r, namesById)), all.length),
    );
  }

  if (op === 'get') {
    if (!item) throw new Error('Item identifier is required for get operation.');
    const record = await resolveItem(internalKey, item, project);
    let namesById: Map<number, string> | undefined;
    if (Array.isArray(record.assigned_users) && record.assigned_users.length > 1 && record.project) {
      namesById = await projectUserNames(record.project);
    }
    return createSuccessResponse(renderDetail(record, namesById));
  }

  if (op === 'create') {
    if (items) {
      if (!items.length) throw new Error(ERROR_MESSAGES.EMPTY_BATCH);
      if (items.length > MAX_BATCH_SIZE) throw new Error(`${ERROR_MESSAGES.BATCH_TOO_LARGE} ${MAX_BATCH_SIZE}`);
      if (!project) throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
      const projectId = await resolveProjectId(project);

      const taxPromises: Promise<TaigaTaxonomyItem[]>[] = [];
      if (type === 'issue') {
        taxPromises.push(
          listTaxonomy('issue_type', projectId),
          listTaxonomy('priority', projectId),
          listTaxonomy('severity', projectId),
          listTaxonomy('issue_status', projectId),
        );
      } else if (type === 'story') {
        taxPromises.push(listTaxonomy('user_story_status', projectId));
      } else if (type === 'task') {
        taxPromises.push(listTaxonomy('task_status', projectId));
      } else if (type === 'epic') {
        taxPromises.push(listTaxonomy('epic_status', projectId));
      }
      const taxResults = await Promise.all(taxPromises);
      const taxonomyCache: TaxonomyCache = {};
      if (type === 'issue') {
        [taxonomyCache.types, taxonomyCache.priorities, taxonomyCache.severities, taxonomyCache.statuses] = taxResults;
      } else {
        [taxonomyCache.statuses] = taxResults;
      }

      const storyCache = new Map<string, TaigaWorkItem>();
      const createdList: TaigaWorkItem[] = [];
      const failedList: BatchItemFailure[] = [];

      for (const it of items) {
        try {
          const payload = await buildPayload(type, projectId, it, taxonomyCache, storyCache, parent);
          payload.project = projectId;
          if (!payload.subject) throw new Error('Subject is required');
          if (type === 'task' && !payload.user_story) throw new Error('Parent user story is required');
          const created = await post<TaigaWorkItem>(ITEM_TYPES[internalKey].path, payload);
          createdList.push(created);
        } catch (err) {
          failedList.push({ item: it, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (createdList.length === 0) {
        const errDetails = failedList.map((f) => `- ${f.item.subject || 'item'}: ${f.error}`).join('\n');
        throw new Error(`All ${items.length} ${TYPE_PLURAL[type]} failed to create:\n${errDetails}`);
      }

      const lines = [`Batch created ${createdList.length} ${TYPE_PLURAL[type]} (${failedList.length} failed):`];
      for (const c of createdList) {
        lines.push(workLine(c));
      }
      if (failedList.length > 0) {
        lines.push('Failed:');
        for (const f of failedList) {
          lines.push(`- ${f.item.subject || 'item'}: ${f.error}`);
        }
      }
      return createSuccessResponse(lines.join('\n'));
    }

    if (!project) throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
    const projectId = await resolveProjectId(project);
    if (!subject) throw new Error('Subject is required to create a work item.');
    if (type === 'task' && !parent) throw new Error('Parent user story is required to create a task.');

    const payload = await buildPayload(type, projectId, {
      subject,
      description,
      status,
      assignee,
      sprint,
      tags,
      priority,
      severity,
      issueType,
      points,
      parent,
    });
    payload.project = projectId;
    const created = await post<TaigaWorkItem>(ITEM_TYPES[internalKey].path, payload);
    return createSuccessResponse(`Created ${itemType(internalKey).label.toLowerCase()}:\n${workLine(created)}`);
  }

  if (op === 'update') {
    if (!item) throw new Error('Item identifier is required for update operation.');
    const existing = await resolveItem(internalKey, item, project);
    const projectId = existing.project;
    if (projectId === undefined) throw new Error('Work item has no project ID.');
    const payload = await buildPayload(type, projectId, {
      subject,
      description,
      status,
      assignee,
      sprint,
      tags,
      priority,
      severity,
      issueType,
      points,
      // Was omitted, so a task reparent was accepted, dropped, and reported as success.
      parent,
    });
    if (Object.keys(payload).length === 0) throw new Error('No fields provided to update.');
    const updated = await patchItem<TaigaWorkItem>(internalKey, existing, payload);
    return createSuccessResponse(`Updated ${itemType(internalKey).label.toLowerCase()}:\n${workLine(updated)}`);
  }

  if (op === 'link') {
    if (type !== 'story') throw new Error('Link operation requires type: "story" (linking story to an epic).');
    if (!item) throw new Error('Item (user story) is required for link operation.');
    if (!parent) throw new Error('Parent (epic) is required for link operation.');
    const story = await resolveItem('user_story', item, project);
    const epic = await resolveItem('epic', parent, project || story.project);
    await post<TaigaWorkItem>(`${API_ENDPOINTS.EPICS}/${epic.id}/related_userstories`, { epic: epic.id, user_story: story.id });
    return createSuccessResponse(`Linked user story #${story.ref} "${story.subject}" to epic #${epic.ref} "${epic.subject}"`);
  }

  if (op === 'unlink') {
    if (type !== 'story') throw new Error('Unlink operation requires type: "story" (unlinking story from an epic).');
    if (!item) throw new Error('Item (user story) is required for unlink operation.');
    if (!parent) throw new Error('Parent (epic) is required for unlink operation.');
    const story = await resolveItem('user_story', item, project);
    const epic = await resolveItem('epic', parent, project || story.project);
    await del<void>(`${API_ENDPOINTS.EPICS}/${epic.id}/related_userstories/${story.id}`);
    return createSuccessResponse(`Unlinked user story #${story.ref} "${story.subject}" from epic #${epic.ref} "${epic.subject}"`);
  }

  if (op === 'delete') {
    if (!item) throw new Error('Item numeric ID or #ref is required for delete operation.');
    if (items) {
      throw new Error('Delete takes exactly one item. Batch is create-only, so a single mistaken call cannot clear a board.');
    }
    // Read first, so the confirmation names what is gone: Taiga keeps no trash for work items.
    const doomed = await resolveItem(internalKey, item, project);
    await del<void>(`${ITEM_TYPES[internalKey].path}/${doomed.id}`);
    return createSuccessResponse(
      `Deleted ${itemType(internalKey).label.toLowerCase()} #${doomed.ref} "${doomed.subject}" (id=${doomed.id}). This is permanent.`,
    );
  }

  throw new Error(`Unknown operation: ${op}`);
};

export const tools: RegisteredTool[] = [
  {
    name: 'work',
    title: 'Work items',
    description,
    inputSchema,
    annotations,
    register(server: McpServer) {
      server.registerTool('work', { title: 'Work items', description, inputSchema, annotations }, guard(handler));
    },
  },
];
