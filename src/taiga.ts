
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
  TaigaWikiPage,
  TaigaWorkItem,
  TaxonomyKind,
} from './types.js';

export const ITEM_TYPES = {
  issue: { path: API_ENDPOINTS.ISSUES, history: 'issue', attachments: '/issues/attachments', label: 'Issue' },
  user_story: { path: API_ENDPOINTS.USER_STORIES, history: 'userstory', attachments: '/userstories/attachments', label: 'User Story' },
  task: { path: API_ENDPOINTS.TASKS, history: 'task', attachments: '/tasks/attachments', label: 'Task' },
  epic: { path: API_ENDPOINTS.EPICS, history: 'epic', attachments: '/epics/attachments', label: 'Epic' },
  wiki: { path: API_ENDPOINTS.WIKI, history: 'wiki', attachments: '/wiki/attachments', label: 'Wiki Page' },
} satisfies Record<ItemTypeKey, ItemTypeMeta>;

export function itemType(type: string): ItemTypeMeta {
  const meta: ItemTypeMeta | undefined = ITEM_TYPES[type as ItemTypeKey];
  if (!meta) {
    throw new Error(`Unsupported item type "${type}". Expected one of: ${Object.keys(ITEM_TYPES).join(', ')}`);
  }
  return meta;
}

export function isNumericId(value: string | number | null | undefined): boolean {
  const text = String(value ?? '').trim();
  if (text.length === 0) return false;
  for (const character of text) {
    if (character < '0' || character > '9') return false;
  }
  return true;
}

export async function resolveProjectId(projectIdentifier: string | number): Promise<number> {
  if (projectIdentifier === undefined || projectIdentifier === null || projectIdentifier === '') {
    throw new Error(ERROR_MESSAGES.MISSING_PROJECT_ID);
  }
  if (isNumericId(projectIdentifier)) return Number(projectIdentifier);
  const project = await getMetadata<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/by_slug`, { slug: projectIdentifier });
  return project.id;
}

export async function resolveWikiPage(page: string | number, project?: string | number): Promise<TaigaWikiPage> {
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

export async function resolveProject(projectIdentifier: string | number): Promise<TaigaProject> {
  if (isNumericId(projectIdentifier)) {
    return get<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/${projectIdentifier}`);
  }
  return get<TaigaProject>(`${API_ENDPOINTS.PROJECTS}/by_slug`, { slug: projectIdentifier });
}

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
    const apiErr = error as ApiError;
    if (apiErr.status === 404 && projectIdentifier) {
      const project = await resolveProjectId(projectIdentifier);
      return get<TaigaWorkItem>(`${path}/by_ref`, { ref: raw, project });
    }
    throw error;
  }
}

const TAXONOMY = {
  issue_status: API_ENDPOINTS.ISSUE_STATUSES,
  user_story_status: API_ENDPOINTS.USER_STORY_STATUSES,
  task_status: API_ENDPOINTS.TASK_STATUSES,
  priority: API_ENDPOINTS.PRIORITIES,
  severity: API_ENDPOINTS.SEVERITIES,
  issue_type: API_ENDPOINTS.ISSUE_TYPES,
  epic_status: API_ENDPOINTS.EPIC_STATUSES,
} satisfies Record<TaxonomyKind, string>;

export function listTaxonomy(kind: TaxonomyKind, projectId: number): Promise<TaigaTaxonomyItem[]> {
  const endpoint = TAXONOMY[kind];
  if (!endpoint) throw new Error(`Unknown taxonomy "${kind}"`);
  return getMetadata<TaigaTaxonomyItem[]>(endpoint, { project: projectId });
}

export function findIdByName(collection: TaigaTaxonomyItem[], name?: string | number): number | undefined {
  if (!name) return undefined;
  const wanted = String(name).toLowerCase();
  return collection.find((item) => item.name?.toLowerCase() === wanted)?.id;
}

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

function listProjectUsers(projectId: number): Promise<TaigaUser[]> {
  return getMetadata<TaigaUser[]>(API_ENDPOINTS.USERS, { project: projectId });
}

export async function projectUserNames(projectId: number): Promise<Map<number, string>> {
  const users = await listProjectUsers(projectId);
  return new Map(users.map((u) => [u.id, u.full_name_display || u.full_name || u.username || `#${u.id}`]));
}

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

export async function patchItem<T>(
  type: ItemTypeKey,
  target: number | string | { id: number; version?: number },
  payload: JsonBody,
): Promise<T> {
  const { path } = itemType(type);
  const known = target instanceof Object ? target : null;
  const id = known ? known.id : target;
  const version = known?.version ?? (await get<TaigaWorkItem>(`${path}/${id}`)).version;
  try {
    return await patch<T>(`${path}/${id}`, { ...payload, version });
  } catch (error) {
    const apiErr = error as ApiError;
    if (apiErr.status === 400 && JSON.stringify(apiErr.detail ?? '').includes('version')) {
      const fresh = await get<TaigaWorkItem>(`${path}/${id}`);
      return patch<T>(`${path}/${id}`, { ...payload, version: fresh.version });
    }
    throw error;
  }
}

const SPRINT_CLEAR_SENTINELS = new Set(['null', 'none', 'remove']);

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
  const project = await resolveProjectId(projectId);
  const sprints = await get<TaigaMilestone[]>(API_ENDPOINTS.MILESTONES, { project });
  const wanted = raw.toLowerCase();
  const match = sprints.find((s) => s.name?.toLowerCase() === wanted);
  if (!match) {
    const available = sprints.map((s) => s.name).join(', ');
    throw new Error(`No sprint named "${raw}" in this project. Available: ${available || 'none'}`);
  }
  return match.id;
}

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
