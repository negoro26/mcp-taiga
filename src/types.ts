/**
 * Taiga payload contracts and the tool-definition type.
 *
 * These interfaces describe what the Taiga REST API actually returns, verified against a live
 * instance. Fields are optional where Taiga genuinely omits them per endpoint — the milestone
 * payload's nested user stories, for example, carry no `assigned_users` — so the optionality is
 * evidence, not defensiveness.
 *
 * Every interface is `interface`, never an alias to a broad type: the vendored anti-slop lint rules
 * reject `unknown`/`any`/`object` in contracts, and they are correct to. Parse at the boundary,
 * then work with named records.
 */

import type { ZodType } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** A user reference embedded in another record. Taiga sends `full_name_display`, never `full_name` here. */
export interface UserRef {
  id?: number;
  username?: string;
  full_name?: string;
  full_name_display?: string;
  photo?: string | null;
  is_active?: boolean;
}

/** `{id, name}` sub-object Taiga attaches for statuses, priorities, severities, types, projects. */
export interface NamedRef {
  id?: number;
  name?: string;
}

/** A full user record from `/users` or `/users/me`. */
export interface TaigaUser {
  id: number;
  username?: string;
  full_name?: string;
  full_name_display?: string;
  email?: string;
}

/** `POST /auth` response: the user record plus tokens. */
export interface AuthResponse extends TaigaUser {
  auth_token: string;
  refresh?: string;
}

export interface TaigaProject {
  id: number;
  name?: string;
  slug?: string;
  description?: string | null;
  is_private?: boolean;
  owner?: UserRef;
  members?: number[];
  total_memberships?: number | null;
  total_milestones?: number | null;
  total_story_points?: number | null;
  is_epics_activated?: boolean;
  is_backlog_activated?: boolean;
  is_kanban_activated?: boolean;
  is_wiki_activated?: boolean;
  is_issues_activated?: boolean;
}

/** A query-string value. Axios drops `undefined` and `null` params, which is how filters opt out. */
export type QueryValue = string | number | boolean | null | undefined;

export interface QueryParams {
  [key: string]: QueryValue;
}

/** A JSON request body. Concrete union, so dictionary values are never `unknown`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonBody {
  [key: string]: JsonValue | undefined;
}

/** Item kinds sharing Taiga's history, attachment and by_ref conventions. */
export type ItemTypeKey = 'issue' | 'user_story' | 'task' | 'epic' | 'wiki';

export interface ItemTypeMeta {
  path: string;
  /** Object-type segment for `/history/{history}/{id}`. */
  history: string;
  attachments: string;
  label: string;
}

/** Project taxonomy collections, keyed as tool arguments name them. */
export type TaxonomyKind =
  | 'issue_status'
  | 'user_story_status'
  | 'task_status'
  | 'epic_status'
  | 'priority'
  | 'severity'
  | 'issue_type';

/** Points arrive as a number, an array, or an object keyed by role ID depending on the endpoint. */
export type PointsValue = number | number[] | Record<string, number>;

/**
 * An issue, user story, task or epic. One interface because the four share almost every field;
 * the per-type differences (points on stories, severity on issues) are optional here and enforced
 * by the tool layer, which knows the requested type.
 */
export interface TaigaWorkItem {
  id: number;
  ref?: number;
  subject?: string;
  description?: string | null;
  version?: number;
  project?: number;
  is_closed?: boolean;
  created_date?: string;
  modified_date?: string;
  tags?: (string | string[])[];
  total_watchers?: number;
  watchers?: number[];
  status?: number | null;
  status_extra_info?: NamedRef;
  assigned_to?: number | null;
  assigned_to_extra_info?: UserRef | null;
  /** Stories may have several assignees; `assigned_to` is only the primary and is always in here. */
  assigned_users?: number[];
  milestone?: number | null;
  milestone_name?: string | null;
  milestone_extra_info?: NamedRef | null;
  priority_extra_info?: NamedRef | null;
  severity_extra_info?: NamedRef | null;
  type_extra_info?: NamedRef | null;
  project_extra_info?: NamedRef | null;
  epic_extra_info?: { id?: number; ref?: number; subject?: string } | null;
  epics?: Array<{ id?: number; ref?: number; subject?: string; color?: string }> | null;
  user_story_extra_info?: { id?: number; ref?: number; subject?: string } | null;
  total_points?: PointsValue | null;
  points?: Record<string, number> | null;
  /** Parent story ID, returned on task endpoints. */
  user_story?: number | null;
  /** Task summaries, returned on user story endpoints. */
  tasks?: TaigaWorkItem[];
  /** Related story summaries, returned on epic endpoints. */
  user_stories?: TaigaWorkItem[];
  color?: string;
  user_stories_counts?: { total?: number; progress?: number };
}

export interface TaigaMilestone {
  id: number;
  name?: string;
  slug?: string;
  project?: number;
  description?: string | null;
  estimated_start?: string | null;
  estimated_finish?: string | null;
  closed?: boolean;
  total_points?: PointsValue | null;
  closed_points?: PointsValue | null;
  project_extra_info?: NamedRef | null;
  /** Present on `/milestones` and `/milestones/{id}`, but WITHOUT `assigned_users` on each story. */
  user_stories?: TaigaWorkItem[];
}

/** `GET /milestones/{id}/stats`. Points fields are the inconsistent shapes, hence PointsValue. */
export interface TaigaMilestoneStats {
  name?: string;
  estimated_start?: string;
  estimated_finish?: string;
  total_points?: PointsValue;
  completed_points?: PointsValue;
  total_userstories?: number;
  completed_userstories?: number;
  total_tasks?: number;
  completed_tasks?: number;
  total_hours?: PointsValue | null;
  completed_hours?: PointsValue | null;
}

/** A `/history/{type}/{id}` entry. Entries with a non-empty `comment` are comments. */
export interface TaigaHistoryEntry {
  id: string;
  comment?: string;
  comment_html?: string;
  created_at?: string;
  user?: UserRef & { name?: string; pk?: number };
  edit_comment_date?: string | null;
  delete_comment_date?: string | null;
}

export interface TaigaAttachment {
  id: number;
  name?: string;
  size?: number;
  url?: string;
  description?: string;
  created_date?: string;
  object_id?: number;
  project?: number;
}

export interface TaigaWikiPage {
  id: number;
  slug?: string;
  content?: string;
  version?: number;
  project?: number;
  owner?: number;
  last_modifier?: number;
  created_date?: string;
  modified_date?: string;
  watchers?: number[];
  total_watchers?: number;
}

/** A status, priority, severity or issue-type option. */
export interface TaigaTaxonomyItem {
  id: number;
  name?: string;
  /** Statuses carry this; priorities, severities and types do not. */
  is_closed?: boolean;
}

/** A point value row from `GET /points?project=<id>`. */
export interface TaigaPointValue {
  id: number;
  name?: string;
  value?: number | null;
}

/** A role from `GET /roles?project=<id>`. */
export interface TaigaRole {
  id: number;
  name?: string;
  computable?: boolean;
}

/** Taiga's error bodies: `{field: ["message"]}` for validation, `{_error_message}` for auth. */
export type TaigaErrorBody = string | { _error_message?: string; detail?: string; [field: string]: string | string[] | undefined };

/** An Error carrying the HTTP status and Taiga's response body, as thrown by src/api.ts. */
export interface ApiError extends Error {
  status?: number;
  detail?: TaigaErrorBody;
}

/**
 * A tool as the registry stores it: metadata the suites assert against, plus the one operation the
 * server needs.
 *
 * `register` exists instead of a bare `handler` because a handler's argument type comes from its
 * own zod schema, and no single field type can hold six different handlers without a cast. Erasing
 * to `never` makes the handler unassignable to the SDK's callback, and widening it back requires
 * `as unknown as`, which is exactly the laundering the lint rules forbid. Registering inside the
 * module keeps the concrete type in scope, so nothing is asserted anywhere.
 *
 * ```ts
 * const inputSchema = { op: z.enum(['list']), project: z.string().optional() };
 * type Args = z.output<z.ZodObject<typeof inputSchema>>;
 * const annotations: ToolAnnotations = { readOnlyHint: true };
 * const handler = async ({ op, project }: Args): Promise<CallToolResult> => …;
 *
 * export const tools: RegisteredTool[] = [{
 *   name: 'projects', title: 'Projects', description: '…', inputSchema, annotations,
 *   register(server) {
 *     server.registerTool('projects', { title: 'Projects', description: '…', inputSchema, annotations }, guard(handler));
 *   },
 * }];
 * ```
 */
/**
 * A tool's zod argument schema as the registry stores it: field name to validator.
 *
 * Defined structurally rather than as zod's own `ZodRawShape`, so the registry does not depend on
 * that library's naming. Each tool module keeps its concrete schema object and passes THAT to the
 * SDK, so this erased form only has to describe what the suites read back.
 */
export interface ToolSchemaMap {
  [field: string]: ZodType;
}

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ToolSchemaMap;
  annotations: ToolAnnotations;
  /** Register this tool on the server, with its argument type still concrete. */
  register(server: McpServer): void;
}

export type { CallToolResult, ToolAnnotations };
