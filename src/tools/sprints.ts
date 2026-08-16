import { z } from 'zod';
import type { CallToolResult, RegisteredTool, TaigaMilestone, TaigaMilestoneStats, TaigaWorkItem, ToolAnnotations } from '../types.js';
import { get, post } from '../api.js';
import { API_ENDPOINTS } from '../constants.js';
import { isNumericId, projectUserNames, resolveProjectId, resolveSprintId } from '../taiga.js';
import { sprintLine, workLine, details, listing, day, pointsSum } from '../format.js';
import { calculateCompletionPercentage, createSuccessResponse, guard } from '../utils.js';

const inputSchema = {
  op: z.enum(['list', 'get', 'create', 'stats']).describe('Operation to perform'),
  project: z.string().optional().describe('Project ID or slug'),
  sprint: z.string().optional().describe('Sprint ID or name (for get, stats)'),
  name: z.string().optional().describe('Sprint name (for create)'),
  start: z.string().optional().describe('Start date YYYY-MM-DD (for create)'),
  finish: z.string().optional().describe('Finish date YYYY-MM-DD (for create)'),
};

type Args = z.output<z.ZodObject<typeof inputSchema>>;

const description = `Manage Taiga sprints (milestones): list, inspect, create, or fetch statistics.

Operations:
- list: List sprints in a project. Requires project.
- get: Get sprint details and assigned stories. Requires sprint (ID or name); project required if sprint is a name.
- stats: Get sprint progress statistics and metrics. Requires sprint; project required if sprint is a name.

Sprint deletion is intentionally not exposed: removing a milestone detaches every story and task on it, so it
is a board-wide edit that belongs in the Taiga UI. Delete individual work items with the work tool instead.`;

const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const handler = async ({ op, project, sprint, name, start, finish }: Args): Promise<CallToolResult> => {
      switch (op) {
        case 'list': {
          if (!project) {
            throw new Error('Project ID or slug is required for op "list".');
          }
          const projectId = await resolveProjectId(project);
          const sprints = await get<TaigaMilestone[]>('/milestones', { project: projectId });
          return createSuccessResponse(listing(`sprints in ${project}`, sprints.map(sprintLine)));
        }

        case 'get': {
          if (!sprint) {
            throw new Error('Sprint ID or name is required for op "get".');
          }
          let sprintId: number | null;
          if (isNumericId(sprint)) {
            sprintId = Number(sprint);
          } else {
            if (!project) {
              throw new Error('Project ID or slug is required for op "get".');
            }
            sprintId = await resolveSprintId(project, sprint);
          }
          const milestone = await get<TaigaMilestone>(`/milestones/${sprintId}`);
          const info = details([
            ['id', milestone.id],
            ['name', milestone.name],
            ['slug', milestone.slug],
            ['project', milestone.project_extra_info?.name || milestone.project],
            ['status', milestone.closed ? 'closed' : 'open'],
            ['dates', `${day(milestone.estimated_start)}..${day(milestone.estimated_finish)}`],
            ['points', milestone.total_points !== undefined ? `${pointsSum(milestone.closed_points)}/${pointsSum(milestone.total_points)}` : null],
            ['description', milestone.description],
          ]);
          // The milestone payload's nested `user_stories` omit `assigned_users`, so rendering them
          // shows only the primary assignee and hides co-assignees. Fetch the real records instead.
          const stories = await get<TaigaWorkItem[]>(API_ENDPOINTS.USER_STORIES, { project: milestone.project, milestone: sprintId });
          const namesById = stories.some((s) => (s.assigned_users?.length ?? 0) > 1) && milestone.project !== undefined
            ? await projectUserNames(milestone.project)
            : undefined;
          const storiesBlock = `\n${listing('user stories', stories.map((s) => workLine(s, namesById, { sprint: false })))}`;
          return createSuccessResponse(`${info}${storiesBlock}`);
        }

        case 'create': {
          if (!project) {
            throw new Error('Project ID or slug is required for op "create".');
          }
          if (!name) {
            throw new Error('Sprint name is required for op "create".');
          }
          const projectId = await resolveProjectId(project);
          const milestoneData = {
            project: projectId,
            name,
            estimated_start: start || undefined,
            estimated_finish: finish || undefined,
          };
          const created = await post<TaigaMilestone>('/milestones', milestoneData);
          return createSuccessResponse(sprintLine(created));
        }

        case 'stats': {
          if (!sprint) {
            throw new Error('Sprint ID or name is required for op "stats".');
          }
          let sprintId: number | null;
          if (isNumericId(sprint)) {
            sprintId = Number(sprint);
          } else {
            if (!project) {
              throw new Error('Project ID or slug is required for op "stats".');
            }
            sprintId = await resolveSprintId(project, sprint);
          }
          const stats = await get<TaigaMilestoneStats>(`/milestones/${sprintId}/stats`);
          // Points arrive as a role-keyed object and an array here, unlike everywhere else.
          const donePoints = pointsSum(stats.completed_points);
          const allPoints = pointsSum(stats.total_points);
          const pointsPct = calculateCompletionPercentage(donePoints, allPoints);
          const storiesPct = calculateCompletionPercentage(stats.completed_userstories ?? 0, stats.total_userstories ?? 0);
          const tasksPct = calculateCompletionPercentage(stats.completed_tasks ?? 0, stats.total_tasks ?? 0);
          const info = details([
            ['sprint', stats.name || sprintId],
            ['points', `${donePoints}/${allPoints} (${pointsPct}%)`],
            ['stories', `${stats.completed_userstories ?? 0}/${stats.total_userstories ?? 0} (${storiesPct}%)`],
            ['tasks', `${stats.completed_tasks ?? 0}/${stats.total_tasks ?? 0} (${tasksPct}%)`],
            ['hours', stats.total_hours !== undefined && stats.total_hours !== null ? `${pointsSum(stats.completed_hours)}/${pointsSum(stats.total_hours)}` : null],
          ]);
          return createSuccessResponse(info);
        }

        default:
          throw new Error(`Unknown op "${op}". Supported ops: list, get, create, stats.`);
      }
};

export const tools: RegisteredTool[] = [
  {
    name: 'sprints',
    title: 'Sprints',
    description,
    inputSchema,
    annotations,
    register(server) {
      server.registerTool('sprints', { title: 'Sprints', description, inputSchema, annotations }, guard(handler));
    },
  },
];
