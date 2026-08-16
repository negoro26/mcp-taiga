import { z } from 'zod';
import { get, post, del } from '../api.js';
import { isNumericId, resolveProjectId, patchItem, projectUserNames } from '../taiga.js';
import { API_ENDPOINTS } from '../constants.js';
import { createSuccessResponse, guard } from '../utils.js';
import { day, details, listing, wikiLine } from '../format.js';
import type { CallToolResult, RegisteredTool, TaigaWikiPage, ToolAnnotations } from '../types.js';

/**
 * Resolve a wiki page by database ID or slug.
 * @param page wiki page ID or slug
 * @param project required when page is a slug
 */
async function resolveWikiPage(page: string | number | undefined | null, project?: string | number): Promise<TaigaWikiPage> {
  if (page === undefined || page === null || page === '') {
    throw new Error('Wiki page ID or slug is required.');
  }
  const raw = String(page).trim();
  if (isNumericId(raw)) {
    return get<TaigaWikiPage>(`${API_ENDPOINTS.WIKI}/${raw}`);
  }
  if (!project) {
    throw new Error('Project ID or slug is required when resolving a wiki page by slug.');
  }
  const projectId = await resolveProjectId(project);
  return get<TaigaWikiPage>(`${API_ENDPOINTS.WIKI}/by_slug`, { slug: raw, project: projectId });
}

const inputSchema = {
  op: z.enum(['list', 'get', 'create', 'update', 'delete', 'watch']).describe('Operation to perform: list, get, create, update, delete, watch'),
  project: z.string().optional().describe('Project ID or slug'),
  page: z.string().optional().describe('Wiki page ID or slug'),
  content: z.string().optional().describe('Wiki page content in Markdown'),
  watch: z.boolean().optional().describe('True to watch, false to unwatch (default true)'),
};

type Args = z.output<z.ZodObject<typeof inputSchema>>;

const description = `Create, inspect, update, delete, or watch wiki pages in a project.

| op | required args | optional args | notes |
|---|---|---|---|
| list | project | | List all wiki pages in project |
| get | page | project | Inspect wiki page metadata and content; project needed if page is slug |
| create | project, page | content | Create wiki page; page is the slug |
| update | page, content | project | Update wiki page content (OCC versioned); project needed if page is slug |
| delete | page | project | Delete wiki page permanently; project needed if page is slug |
| watch | page | project, watch | Watch (default) or unwatch wiki page; project needed if page is slug |`;

const annotations: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const handler = async ({ op, project, page, content, watch }: Args): Promise<CallToolResult> => {
      if (op === 'list') {
        if (!project) {
          throw new Error('Project ID or slug is required for op "list".');
        }
        const projectId = await resolveProjectId(project);
        const [pages, namesById] = await Promise.all([
          get<TaigaWikiPage[]>(API_ENDPOINTS.WIKI, { project: projectId }),
          projectUserNames(projectId),
        ]);
        return createSuccessResponse(
          listing(`wiki pages in ${project}`, pages.map((p) => wikiLine(p, namesById))),
        );
      }

      if (op === 'get') {
        if (!page) {
          throw new Error('Wiki page ID or slug is required for op "get".');
        }
        const wikiPage = await resolveWikiPage(page, project);
        const namesById = wikiPage.project ? await projectUserNames(wikiPage.project) : new Map<number, string>();
        const owner = wikiPage.owner ? (namesById.get(wikiPage.owner) || `user ${wikiPage.owner}`) : null;
        const lastModifier = wikiPage.last_modifier ? (namesById.get(wikiPage.last_modifier) || `user ${wikiPage.last_modifier}`) : null;
        const watcherCount = Array.isArray(wikiPage.watchers)
          ? wikiPage.watchers.length
          : (Number.isFinite(wikiPage.total_watchers) ? wikiPage.total_watchers : null);

        const text = details([
          ['ID', wikiPage.id],
          ['Slug', wikiPage.slug],
          ['Version', wikiPage.version ? `v${wikiPage.version}` : null],
          ['Owner', owner],
          ['Last modifier', lastModifier],
          ['Created', day(wikiPage.created_date)],
          ['Modified', day(wikiPage.modified_date)],
          ['Watchers', watcherCount],
          ['Content', wikiPage.content || '(empty)'],
        ]);
        return createSuccessResponse(text);
      }

      if (op === 'create') {
        if (!project) {
          throw new Error('Project ID or slug is required for op "create".');
        }
        if (!page) {
          throw new Error('Wiki page slug is required in "page" for op "create".');
        }
        const projectId = await resolveProjectId(project);
        const wikiPage = await post<TaigaWikiPage>(API_ENDPOINTS.WIKI, {
          project: projectId,
          slug: page,
          content: content ?? '',
        });
        const text = details([
          ['ID', wikiPage.id],
          ['Slug', wikiPage.slug],
          ['Project', project],
          ['Version', wikiPage.version ? `v${wikiPage.version}` : null],
          ['Created', day(wikiPage.created_date)],
          ['Content length', wikiPage.content ? wikiPage.content.length : 0],
        ]);
        return createSuccessResponse(text);
      }

      if (op === 'update') {
        if (!page) {
          throw new Error('Wiki page ID or slug is required for op "update".');
        }
        if (content === undefined) {
          throw new Error('Content is required for op "update".');
        }
        const wikiPage = await resolveWikiPage(page, project);
        const result = await patchItem<TaigaWikiPage>('wiki', wikiPage, { content });
        const text = details([
          ['ID', result.id],
          ['Slug', result.slug],
          ['Version', result.version ? `v${result.version}` : null],
          ['Modified', day(result.modified_date)],
          ['Content length', result.content ? result.content.length : 0],
        ]);
        return createSuccessResponse(text);
      }

      if (op === 'delete') {
        if (!page) {
          throw new Error('Wiki page ID or slug is required for op "delete".');
        }
        const wikiPage = await resolveWikiPage(page, project);
        await del(`${API_ENDPOINTS.WIKI}/${wikiPage.id}`);
        const text = details([
          ['Deleted', `${wikiPage.id} ${wikiPage.slug}`],
        ]);
        return createSuccessResponse(text);
      }

      if (op === 'watch') {
        if (!page) {
          throw new Error('Wiki page ID or slug is required for op "watch".');
        }
        const wikiPage = await resolveWikiPage(page, project);
        const shouldWatch = watch !== false;
        const actionPath = shouldWatch
          ? `${API_ENDPOINTS.WIKI}/${wikiPage.id}/watch`
          : `${API_ENDPOINTS.WIKI}/${wikiPage.id}/unwatch`;
        await post(actionPath);
        const text = details([
          ['ID', wikiPage.id],
          ['Slug', wikiPage.slug],
          ['Watching', shouldWatch ? 'yes' : 'no'],
        ]);
        return createSuccessResponse(text);
      }

      throw new Error(`Unknown op: "${op}". Valid ops: list, get, create, update, delete, watch`);
};

export const tools: RegisteredTool[] = [
  {
    name: 'wiki',
    title: 'Wiki',
    description,
    inputSchema,
    annotations,
    register(server) {
      server.registerTool('wiki', { title: 'Wiki', description, inputSchema, annotations }, guard(handler));
    },
  },
];
