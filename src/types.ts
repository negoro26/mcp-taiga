
import type { ZodObject, ZodType } from 'zod';
import type { CallToolResult, ToolAnnotations, McpServer } from '@modelcontextprotocol/server';

export interface UserRef {
  id?: number;
  username?: string;
  full_name?: string;
  full_name_display?: string;
  photo?: string | null;
  is_active?: boolean;
}

export interface NamedRef {
  id?: number;
  name?: string;
}

export interface TaigaUser {
  id: number;
  username?: string;
  full_name?: string;
  full_name_display?: string;
  email?: string;
}

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

export type QueryValue = string | number | boolean | null | undefined;

export interface QueryParams {
  [key: string]: QueryValue;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonBody {
  [key: string]: JsonValue | undefined;
}

export type ItemTypeKey = 'issue' | 'user_story' | 'task' | 'epic' | 'wiki';

export interface ItemTypeMeta {
  path: string;
  history: string;
  attachments: string;
  label: string;
}

export type TaxonomyKind =
  | 'issue_status'
  | 'user_story_status'
  | 'task_status'
  | 'epic_status'
  | 'priority'
  | 'severity'
  | 'issue_type';

export type PointsValue = number | number[] | Record<string, number>;

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
  user_story?: number | null;
  tasks?: TaigaWorkItem[];
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
  user_stories?: TaigaWorkItem[];
}

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

export interface TaigaTaxonomyItem {
  id: number;
  name?: string;
  is_closed?: boolean;
}

export interface TaigaPointValue {
  id: number;
  name?: string;
  value?: number | null;
}

export interface TaigaRole {
  id: number;
  name?: string;
  computable?: boolean;
}

export type TaigaErrorBody = string | { _error_message?: string; detail?: string; [field: string]: string | string[] | undefined };

export interface ApiError extends Error {
  status?: number;
  detail?: TaigaErrorBody;
}

export interface RegisteredTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodObject<Record<string, ZodType>>;
  annotations: ToolAnnotations;
  register(server: McpServer): void;
}

export type { CallToolResult, ToolAnnotations };
