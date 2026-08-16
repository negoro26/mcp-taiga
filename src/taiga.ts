/**
 * Shared Taiga domain helpers: identifier resolution, taxonomy lookup, optimistic-concurrency patch.
 * Anything used by more than one tool module belongs here; single-use API calls stay in the tool.
 */

import { get, getMetadata, patch } from './api.js';
import { API_ENDPOINTS, ERROR_MESSAGES } from './constants.js';
import type {
  ApiError,
  ItemTypeKey,
  ItemTypeMeta,
  JsonBody,
  TaigaMilestone,
  TaigaPointValue,
  TaigaProject,
  TaigaRole,
  TaigaTaxonomyItem,
  TaigaUser,
  TaigaWorkItem,
  TaxonomyKind,
} from './types.js';

/**
 * Item kinds that share Taiga's history, attachment and by_ref conventions.
 * `history` is the object type segment used by /history/{history}/{id}.
 */
export const ITEM_TYPES = {
  issue: { path: API_ENDPOINTS.ISSUES, history: 'issue', attachments: '/issues/attachments', label: 'Issue' },
  user_story: { path: API_ENDPOINTS.USER_STORIES, history: 'userstory', attachments: '/userstories/attachments', label: 'User Story' },
  task: { path: API_ENDPOINTS.TASKS, history: 'task', attachments: '/tasks/attachments', label: 'Task' },
  epic: { path: API_ENDPOINTS.EPICS, history: 'epic', attachments: '/epics/attachments', label: 'Epic' },
  wiki: { path: API_ENDPOINTS.WIKI, history: 'wiki', attachments: '/wiki/attachments', label: 'Wiki Page' },
} satisfies Record<ItemTypeKey, ItemTypeMeta>;

export function itemType(type: string): ItemTypeMeta {
  // SAFETY: dynamic key lookup on ITEM_TYPES, validated against undefined immediately below
  const meta: ItemTypeMeta | undefined = ITEM_TYPES[type as ItemTypeKey];
  if (!meta) {
    throw new Error(`Unsupported item type "${type}". Expected one of: ${Object.keys(ITEM_TYPES).join(', ')}`);
  }
  return meta;
}

/**
 * True when the value is a bare positive integer written in decimal digits — a Taiga database ID
 * rather than a slug, a `#reference`, or a name.
 *
 * Character comparison rather than a pattern: JavaScript's `\d` is ASCII-only, so this is exactly
 * equivalent and states the rule in the open.
 */
export function isNumericId(value: string | number | null | undefined): boolean {
  const text = String(value ?? '').trim();
  if (text.length === 0) return false;
  for (const character of text) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

/**
 * Resolve a project ID or slug to a numeric project ID.
 */
export async function resolveProjectId(projectIdentifier: string | number): Promise<number> {
  if (projectIdentifier === undefined || projectIdentifier === null || projectIdentifier === '') {
    throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
  }
  if (isNumericId(projectIdentifier)) return Number(projectIdentifier);
  const project = await getMetadata<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/by_slug`, { slug: projectIdentifier });
  return project.id;
}

/**
 * Resolve a project ID or slug to the full project object.
 */
export async function resolveProject(projectIdentifier: string | number): Promise<TaigaProject> {
  if (isNumericId(projectIdentifier)) {
    return get<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/${projectIdentifier}`);
  }
  return get<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/by_slug`, { slug: projectIdentifier });
}

/**
 * Resolve an item by database ID or by project reference number.
 *
 * A bare number is treated as a database ID; `#123` is a reference and needs a project.
 */
export async function resolveItem(
  type: ItemTypeKey,
  identifier: string | number,
  projectIdentifier?: string | number,
): Promise<TaigaWorkItem> {
  const { path, label } = itemType(type);
  const raw = String(identifier).trim();

  if (raw.startsWith('#')) {
    if (!projectIdentifier) throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
    const project = await resolveProjectId(projectIdentifier);
    return get<TaigaWorkItem>(`${path}/by_ref`, { ref: raw.slice(1), project });
  }
  if (!isNumericId(raw)) {
    throw new Error(`${label} identifier "${identifier}" is not a numeric ID or a #reference.`);
  }
  try {
    return await get<TaigaWorkItem>(`${path}/${raw}`);
  } catch (error) {
    // Users routinely paste reference numbers without the '#'. Fall back when we can.
    // SAFETY: error is an ApiError when thrown by api.ts transport
    const apiErr = error as ApiError;
    if (apiErr.status === 404 && projectIdentifier) {
      const project = await resolveProjectId(projectIdentifier);
      return get<TaigaWorkItem>(`${path}/by_ref`, { ref: raw, project });
    }
    throw error;
  }
}

/** Taxonomy collections, keyed by the name used in tool arguments. */
const TAXONOMY = {
  issue_status: API_ENDPOINTS.ISSUE_STATUSES,
  user_story_status: API_ENDPOINTS.USER_STORY_STATUSES,
  task_status: API_ENDPOINTS.TASK_STATUSES,
  priority: API_ENDPOINTS.PRIORITIES,
  severity: API_ENDPOINTS.SEVERITIES,
  issue_type: API_ENDPOINTS.ISSUE_TYPES,
  epic_status: API_ENDPOINTS.EPIC_STATUSES,
} satisfies Record<TaxonomyKind, string>;

/**
 * List a project taxonomy (statuses, priorities, severities, types).
 */
export function listTaxonomy(kind: TaxonomyKind, projectId: number): Promise<TaigaTaxonomyItem[]> {
  const endpoint = TAXONOMY[kind];
  if (!endpoint) throw new Error(`Unknown taxonomy "${kind}"`);
  return getMetadata<TaigaTaxonomyItem[]>(endpoint, { project: projectId });
}

/** Case-insensitive name lookup over a collection of `{id, name}`. */
export function findIdByName(collection: TaigaTaxonomyItem[], name?: string | number): number | undefined {
  if (!name) return undefined;
  const wanted = String(name).toLowerCase();
  return collection.find((item) => item.name?.toLowerCase() === wanted)?.id;
}

/**
 * Resolve a taxonomy value by name to its numeric ID.
 * @throws when the name does not exist in the project, listing the valid names.
 */
export async function resolveTaxonomyId(
  kind: TaxonomyKind,
  projectId: number,
  name?: string,
): Promise<number | undefined> {
  if (!name) return undefined;
  const options = await listTaxonomy(kind, projectId);
  const id = findIdByName(options, name);
  if (id === undefined) {
    throw new Error(`No ${kind.split('_').join(' ')} named "${name}" in this project. Available: ${options.map((o) => o.name).join(', ')}`);
  }
  return id;
}

/**
 * Project members as full user records: `{id, username, full_name, full_name_display}`.
 *
 * Prefer this over /memberships: on a real instance the membership records carried
 * `user_email: null` and `user_extra_info: null`, so a username was unresolvable from them.
 */
function listProjectUsers(projectId: number): Promise<TaigaUser[]> {
  return getMetadata<TaigaUser[]>(API_ENDPOINTS.USERS, { project: projectId });
}

/**
 * Map of user ID to display name for a project, for rendering ID-only fields
 * such as a user story's `assigned_users` or a wiki page's `owner`.
 */
export async function projectUserNames(projectId: number): Promise<Map<number, string>> {
  const users = await listProjectUsers(projectId);
  return new Map(users.map((u) => [u.id, u.full_name_display || u.full_name || u.username || `#${u.id}`]));
}

/**
 * Resolve a person to a user ID. Accepts a numeric ID, `me`, a username, a full name, or an email.
 */
export async function resolveMemberId(projectId: number, assignee: string | number): Promise<number> {
  const wanted = String(assignee).trim();
  if (isNumericId(wanted)) return Number(wanted);
  if (wanted.toLowerCase() === 'me') return (await getMetadata<TaigaUser>(API_ENDPOINTS.USERS_ME)).id;

  const users = await listProjectUsers(projectId);
  const needle = wanted.toLowerCase();
  const match = users.find((u) => [u.username, u.full_name, u.full_name_display, u.email]
    .some((value) => value?.toLowerCase() === needle));
  if (!match) {
    const known = users.map((u) => u.username).filter(Boolean).join(', ');
    throw new Error(`No member of this project matches "${assignee}". Available usernames: ${known}`);
  }
  return match.id;
}

/**
 * Patch an item, supplying the optimistic-concurrency `version` Taiga requires.
 *
 * Pass the already-resolved record when you have one. Callers reach an item through
 * `resolveItem` first, and refetching it here just to read `version` doubled the request count of
 * every update. Taiga rejects a stale version only when the changed fields overlap, so a single
 * refetch on conflict is enough.
 */
export async function patchItem<T>(
  type: ItemTypeKey,
  target: number | string | { id: number; version?: number },
  payload: JsonBody,
): Promise<T> {
  const { path } = itemType(type);
  // `instanceof Object` separates the record form from a bare ID without a cast and without
  // `typeof`: primitives are never instances of Object, so both branches narrow cleanly.
  const known = target instanceof Object ? target : null;
  const id = known ? known.id : target;
  const version = known?.version ?? (await get<TaigaWorkItem>(`${path}/${id}`)).version;
  try {
    return await patch<T>(`${path}/${id}`, { ...payload, version });
  } catch (error) {
    // SAFETY: error is an ApiError when thrown by api.ts transport
    const apiErr = error as ApiError;
    if (apiErr.status === 400 && JSON.stringify(apiErr.detail ?? '').includes('version')) {
      const fresh = await get<TaigaWorkItem>(`${path}/${id}`);
      return patch<T>(`${path}/${id}`, { ...payload, version: fresh.version });
    }
    throw error;
  }
}

const SPRINT_CLEAR_SENTINELS = new Set(['null', 'none', 'remove']);

/**
 * Resolve a sprint by ID or name to the full milestone object.
 */
async function resolveSprint(
  projectId: string | number,
  identifier: string | number,
): Promise<TaigaMilestone | null> {
  if (identifier === undefined || identifier === null) {
    throw new Error('Sprint identifier cannot be empty.');
  }
  const raw = String(identifier).trim();
  if (!raw) {
    throw new Error('Sprint identifier cannot be empty.');
  }
  if (SPRINT_CLEAR_SENTINELS.has(raw.toLowerCase())) {
    return null;
  }
  if (isNumericId(raw)) {
    return get<TaigaMilestone>(`${API_ENDPOINTS.MILESTONES}/${raw}`);
  }
  const project = await resolveProjectId(projectId);
  const sprints = await get<TaigaMilestone[]>(API_ENDPOINTS.MILESTONES, { project });
  const wanted = raw.toLowerCase();
  const match = sprints.find((s) => s.name?.toLowerCase() === wanted);
  if (!match) {
    const available = sprints.map((s) => s.name).join(', ');
    throw new Error(`No sprint named "${identifier}" in this project. Available: ${available || 'none'}`);
  }
  return match;
}

/**
 * Resolve a sprint identifier (numeric ID or sprint name) to a milestone ID.
 */
export async function resolveSprintId(
  projectId: string | number,
  identifier: string | number,
): Promise<number | null> {
  if (identifier === undefined || identifier === null) {
    throw new Error('Sprint identifier cannot be empty.');
  }
  const raw = String(identifier).trim();
  if (!raw) {
    throw new Error('Sprint identifier cannot be empty.');
  }
  if (SPRINT_CLEAR_SENTINELS.has(raw.toLowerCase())) {
    return null;
  }
  if (isNumericId(raw)) {
    return Number(raw);
  }
  const sprint = await resolveSprint(projectId, raw);
  return sprint ? sprint.id : null;
}

/**
 * Resolve a point value (scalar number, string like "5", or "?" for unestimated)
 * into a role-keyed map of point-row IDs ({ [roleId]: pointRowId }).
 */
export async function resolvePointsPayload(projectId: number, points: string | number): Promise<Record<string, number>> {
  const [pointTaxonomy, roles] = await Promise.all([
    getMetadata<TaigaPointValue[]>(API_ENDPOINTS.POINTS, { project: projectId }),
    getMetadata<TaigaRole[]>(API_ENDPOINTS.ROLES, { project: projectId }),
  ]);

  const isNumeric = Number.isFinite(Number(points));
  let matched: TaigaPointValue | undefined;
  if (isNumeric) {
    const num = Number(points);
    matched = pointTaxonomy.find((p) => p.value !== null && p.value !== undefined && p.value === num);
  } else {
    const needle = String(points).toLowerCase();
    matched = pointTaxonomy.find((p) => p.name !== undefined && p.name.toLowerCase() === needle);
  }

  if (!matched) {
    const available = pointTaxonomy
      .map((p) => p.name)
      .filter((n): n is string => n !== undefined)
      .join(', ');
    throw new Error(`No point value "${points}" in this project. Available: ${available}`);
  }

  const computableRoles = roles.filter((r) => r.computable);
  if (computableRoles.length === 0) {
    throw new Error('This project has no computable role, so points cannot be set.');
  }
  if (computableRoles.length > 1) {
    const roleNames = computableRoles.map((r) => r.name ?? String(r.id)).join(', ');
    throw new Error(`Project has multiple computable roles (${roleNames}). Points must be set per role in the Taiga UI.`);
  }

  return { [String(computableRoles[0].id)]: matched.id };
}
