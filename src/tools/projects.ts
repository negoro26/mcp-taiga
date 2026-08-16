import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, RegisteredTool, TaigaProject, TaigaUser, ToolAnnotations } from '../types.js';
import { get } from '../api.js';
import { resolveProject } from '../taiga.js';
import { API_ENDPOINTS } from '../constants.js';
import { createSuccessResponse, guard } from '../utils.js';
import { details, listing, projectLine, userName } from '../format.js';

const inputSchema = {
  op: z.enum(['list', 'get', 'whoami']).describe('Operation to perform: list, get, or whoami'),
  project: z.string().optional().describe('Project ID or slug (required for get)'),
};

type Args = z.output<z.ZodObject<typeof inputSchema>>;

const description = `List or inspect Taiga projects and verify credentials.

Credentials come from TAIGA_USERNAME and TAIGA_PASSWORD in the environment; the server authenticates on first use. Use whoami to verify them.

| op | required args | optional args | notes |
|---|---|---|---|
| list | | | List projects where authenticated user is member |
| get | project | | Inspect project metadata, owner, member count, active modules |
| whoami | | | Verify credentials and show current user info |`;

const annotations: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

const handler = async ({ op, project }: Args): Promise<CallToolResult> => {
  if (op === 'list') {
    const me = await get<TaigaUser>(API_ENDPOINTS.USERS_ME);
    const projects = await get<TaigaProject[]>(API_ENDPOINTS.PROJECTS, { member: me.id });
    return createSuccessResponse(listing('projects', projects.map(projectLine)));
  }

  if (op === 'get') {
    if (!project) {
      throw new Error('Project ID or slug is required for op "get".');
    }
    const p = await resolveProject(project);
    const modules = [
      p.is_epics_activated && 'epics',
      p.is_backlog_activated && 'backlog',
      p.is_kanban_activated && 'kanban',
      p.is_wiki_activated && 'wiki',
      p.is_issues_activated && 'issues',
    ].filter(Boolean).join(', ');

    const memberCount = p.total_memberships
      ?? (Array.isArray(p.members) ? p.members.length : null);

    const text = details([
      ['Name', p.name],
      ['ID', p.id],
      ['Slug', p.slug],
      ['Description', p.description],
      ['Owner', userName(p.owner) || (p.owner ? String(p.owner) : null)],
      ['Members', memberCount],
      ['Private', p.is_private ? 'yes' : 'no'],
      ['Modules', modules || 'none'],
    ]);

    return createSuccessResponse(text);
  }

  if (op === 'whoami') {
    const me = await get<TaigaUser>(API_ENDPOINTS.USERS_ME);
    const text = [me.id, me.username, me.full_name_display || me.full_name, me.email]
      .filter(Boolean)
      .join(' ');
    return createSuccessResponse(text);
  }

  throw new Error(`Unknown op: "${op}". Valid ops: list, get, whoami`);
};

export const tools: RegisteredTool[] = [
  {
    name: 'projects',
    title: 'Projects',
    description,
    inputSchema,
    annotations,
    register(server: McpServer) {
      server.registerTool('projects', { title: 'Projects', description, inputSchema, annotations }, guard(handler));
    },
  },
];
