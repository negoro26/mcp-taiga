import { z } from 'zod';
import type {
  CallToolResult,
  RegisteredTool,
  TaigaMilestone,
  TaigaMilestoneStats,
  TaigaSprintClosePreview,
  TaigaSprintReview,
  TaigaWorkItem,
  ToolAnnotations,
} from '../types.js';
import { get, post } from '../api.js';
import { API_ENDPOINTS } from '../constants.js';
import { isNumericId, projectUserNames, resolveProjectId, resolveSprintId } from '../taiga.js';
import { sprintLine, workLine, details, listing, day, pointsSum } from '../format.js';
import { calculateCompletionPercentage, createSuccessResponse, guard } from '../utils.js';

const inputSchema = z.object({
  op: z.enum(['list', 'get', 'create', 'stats', 'review', 'close_preview']).describe('Operation to perform'),
  project: z.string().optional().describe('Project ID or slug'),
  sprint: z.string().optional().describe('Sprint ID or name (for get, stats)'),
  name: z.string().optional().describe('Sprint name (for create)'),
  start: z.string().optional().describe('Start date YYYY-MM-DD (for create)'),
  finish: z.string().optional().describe('Finish date YYYY-MM-DD (for create)'),
});

type Args = z.output<typeof inputSchema>;

const description = `Manage Taiga sprints (milestones).

| op | required |
|---|---|
| list | project |
| get, stats, review, close_preview | sprint |
| create | project, name |

project is required when sprint is a name.

Sprint deletion is not exposed: removing a milestone detaches every story and task on it. Delete work items with the work tool instead.`;

const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

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

        case 'review': {
          if (!sprint) {
            throw new Error('Sprint ID or name is required for op "review".');
          }

          let sprintId: number | null;

          if (isNumericId(sprint)) {
            sprintId = Number(sprint);
          } else {
            if (!project) {
              throw new Error('Project ID or slug is required for op "review".');
            }

            sprintId = await resolveSprintId(project, sprint);
          }

          const review = await get<TaigaSprintReview>(API_ENDPOINTS.SPRINT_REVIEW, { milestone: sprintId });

          const summary = details([
            ['sprint', review.milestone.name],
            ['status', review.milestone.closed ? 'closed' : 'open'],
            ['stories closed', `${review.totals.stories_closed}/${review.totals.stories_total}`],
            ['tasks closed', `${review.totals.tasks_closed}/${review.totals.tasks_total}`],
            ['points closed', review.totals.points_closed],
            ['unestimated closed', review.totals.unestimated_count],
          ]);

          const memberRows = review.members.map(
            (m) => `${m.full_name} (${m.username}) | ${m.points_closed}pts | ${m.closed_stories.length} stories | ${m.closed_tasks.length} tasks`,
          );

          return createSuccessResponse(`${summary}\n${listing('members', memberRows)}`);
        }

        case 'close_preview': {
          if (!sprint) {
            throw new Error('Sprint ID or name is required for op "close_preview".');
          }

          let sprintId: number | null;

          if (isNumericId(sprint)) {
            sprintId = Number(sprint);
          } else {
            if (!project) {
              throw new Error('Project ID or slug is required for op "close_preview".');
            }

            sprintId = await resolveSprintId(project, sprint);
          }

          const preview = await get<TaigaSprintClosePreview>(API_ENDPOINTS.SPRINT_CLOSE, { milestone: sprintId });

          const summary = details([
            ['sprint', preview.milestone.name],
            ['will close', preview.will_close ? 'yes' : 'no'],
            ['next sprint', preview.suggested_sprint ? `${preview.suggested_sprint.name} (${preview.suggested_sprint.estimated_start}..${preview.suggested_sprint.estimated_finish})` : null],
            ['split stories', preview.split.length],
            ['moved stories', preview.moved.length],
            ['left open stories', preview.left_open.length],
            ['open loose tasks', preview.tasks_without_story],
            ['open issues', preview.issues],
          ]);

          return createSuccessResponse(summary);
        }

        default:
          throw new Error(`Unknown op "${op}". Supported ops: list, get, create, stats, review, close_preview.`);
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
