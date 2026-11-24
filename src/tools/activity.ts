import { z } from 'zod';
import type {
  ActivityEntry,
  ActivityOpenItem,
  ActivitySummary,
  ActivityTarget,
  ActivityTitledKind,
  ActivityToday,
  CallToolResult,
  JsonBody,
  RegisteredTool,
  ToolAnnotations,
} from '../types.js';
import { del, get, post } from '../api.js';
import { API_ENDPOINTS } from '../constants.js';
import { isNumericId, resolveItem, resolveProjectId } from '../taiga.js';
import { activityItemLine, activityLine, activityMemberLine, details, listing } from '../format.js';
import { createSuccessResponse, guard } from '../utils.js';

const KINDS = ['learning', 'research', 'administrative', 'meetings', 'tasks'] as const;

const inputSchema = z.object({
  op: z.enum(['today', 'summary', 'log', 'delete']).describe('Operation to perform'),
  project: z.string().optional().describe('Project ID or slug'),
  view: z.enum(['day', 'week', 'sprint']).optional().describe('Default week'),
  at: z.string().optional().describe('Date or sprint ID'),
  minutes: z.number().min(1).optional().describe('Minutes'),
  kind: z.enum(KINDS).optional().describe('Default tasks with task or issue'),
  task: z.string().optional().describe('Task ID or #ref'),
  issue: z.string().optional().describe('Issue ID or #ref'),
  title: z.string().optional().describe('What you did (not tasks)'),
  place: z.enum(['remote', 'onsite']).optional().describe('Default onsite'),
  overtime: z.boolean().optional().describe('Overtime'),
  entry: z.string().optional().describe('Entry ID'),
});

type Args = z.output<typeof inputSchema>;

type TargetArgs = Pick<Args, 'kind' | 'task' | 'issue' | 'title'>;

type TargetDraft =
  | { kind: 'tasks'; type: 'task' | 'issue'; identifier: string }
  | { kind: ActivityTitledKind; title: string };

const description = `Log and audit working time.

| op | required |
|---|---|
| today, summary | project |
| log | project, minutes, task/issue or kind+title |
| delete | entry |

Log time after task or issue work. Run today before finishing.`;

const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function draftTarget({ kind, task, issue, title }: TargetArgs): TargetDraft {
  const resolvedKind = kind ?? (task !== undefined || issue !== undefined ? 'tasks' : undefined);

  if (resolvedKind === undefined) {
    throw new Error('kind is required for op "log" unless task or issue is given.');
  }

  if (resolvedKind === 'tasks') {
    if (title) {
      throw new Error('kind "tasks" takes a task or issue, not a title.');
    }

    if (task !== undefined && issue === undefined) {
      return { kind: 'tasks', type: 'task', identifier: task };
    }

    if (issue !== undefined && task === undefined) {
      return { kind: 'tasks', type: 'issue', identifier: issue };
    }

    throw new Error('kind "tasks" needs exactly one of task or issue.');
  }

  if (task !== undefined || issue !== undefined) {
    throw new Error(`kind "${resolvedKind}" takes a title, not a task or issue.`);
  }

  const text = title?.trim();

  if (!text) {
    throw new Error(`A title is required for kind "${resolvedKind}".`);
  }

  return { kind: resolvedKind, title: text };
}

async function resolveTarget(draft: TargetDraft, project: string): Promise<ActivityTarget> {
  if (draft.kind !== 'tasks') {
    return draft;
  }

  const item = await resolveItem(draft.type, draft.identifier, project);

  return { kind: 'tasks', item: { type: draft.type, id: item.id } };
}

function openAssigned(items: ActivityOpenItem[]): string[] {
  const rows: string[] = [];

  for (const item of items) {
    if (item.mine && !item.closed) rows.push(activityItemLine(item));
  }

  return rows;
}

function entryId(entry: Args['entry']): number {
  if (entry === undefined || !isNumericId(entry)) {
    throw new Error('A numeric entry ID is required for op "delete".');
  }

  return Number(entry);
}

function todayText({ today, can_log: canLog, mine, tasks, issues }: ActivityToday): string {
  const total = mine.reduce((sum, entry) => sum + entry.minutes, 0);
  const headline = total === 0 ? `Nothing logged today (${today}).` : `Logged today: ${total}m (${today}).`;

  return [
    headline,
    canLog ? null : 'can_log: false',
    listing('my entries', mine.map(activityLine)),
    listing('open tasks assigned to me', openAssigned(tasks)),
    listing('open issues assigned to me', openAssigned(issues)),
  ].filter((part) => part !== null).join('\n');
}

function summaryText({ view, period, prev, next, rows }: ActivitySummary): string {
  const logged: string[] = [];
  const idle: string[] = [];

  for (const row of rows) {
    if (row.total > 0) {
      logged.push(activityMemberLine(row));
    } else if (row.member) {
      idle.push(row.user.name);
    }
  }

  const header = details([
    ['view', view],
    ['period', `${period.label} (${period.start}..${period.end})`],
    ['prev', prev],
    ['next', next],
  ]);

  return `${header}\n${listing('logged', logged)}\n${listing('not logged', idle)}`;
}

function entryBody(project: number, minutes: number, place: NonNullable<Args['place']>, overtime: boolean, target: ActivityTarget): JsonBody {
  const link = target.kind === 'tasks' ? target.item : null;

  return {
    project,
    minutes,
    place,
    overtime,
    kind: target.kind,
    task: link?.type === 'task' ? link.id : null,
    issue: link?.type === 'issue' ? link.id : null,
    title: target.kind === 'tasks' ? '' : target.title,
  };
}

const handler = async ({ op, project, view, at, minutes, kind, task, issue, title, place, overtime, entry }: Args): Promise<CallToolResult> => {
  switch (op) {
    case 'today': {
      if (!project) {
        throw new Error('Project ID or slug is required for op "today".');
      }

      const projectId = await resolveProjectId(project);

      return createSuccessResponse(todayText(await get<ActivityToday>(API_ENDPOINTS.ACTIVITY_TODAY, { project: projectId })));
    }

    case 'summary': {
      if (!project) {
        throw new Error('Project ID or slug is required for op "summary".');
      }

      const projectId = await resolveProjectId(project);
      const summary = await get<ActivitySummary>(API_ENDPOINTS.ACTIVITY_SUMMARY, { project: projectId, view: view ?? 'week', at });

      return createSuccessResponse(summaryText(summary));
    }

    case 'log': {
      if (!project) {
        throw new Error('Project ID or slug is required for op "log".');
      }

      if (minutes === undefined || !Number.isInteger(minutes)) {
        throw new Error('A whole number of minutes is required for op "log".');
      }

      const draft = draftTarget({ kind, task, issue, title });
      const projectId = await resolveProjectId(project);
      const target = await resolveTarget(draft, project);

      const created = await post<ActivityEntry>(
        API_ENDPOINTS.ACTIVITY_ENTRIES,
        entryBody(projectId, minutes, place ?? 'onsite', overtime ?? false, target),
      );

      return createSuccessResponse(`Logged:\n${activityLine(created)}`);
    }

    case 'delete': {
      const id = entryId(entry);

      await del(`${API_ENDPOINTS.ACTIVITY_ENTRIES}/${id}`);

      return createSuccessResponse(`Deleted activity entry ${id}.`);
    }

    default:
      throw new Error(`Unknown op "${op}". Supported ops: today, summary, log, delete.`);
  }
};

export const tools: RegisteredTool[] = [
  {
    name: 'activity',
    title: 'Activity',
    description,
    inputSchema,
    annotations,
    register(server) {
      server.registerTool('activity', { title: 'Activity', description, inputSchema, annotations }, guard(handler));
    },
  },
];
