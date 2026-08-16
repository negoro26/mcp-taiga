/**
 * Dense text rendering.
 *
 * The text channel is the ONLY channel that reaches a model: omp's MCP bridge concatenates
 * `type === 'text'` content and discards `structuredContent` and embedded resources entirely
 * (verified against its bundled cli.js). So every fact a caller needs must appear in this text,
 * and nothing else should — one line per record, pipe-separated, no emoji, no blank-line padding.
 */

import type {
  PointsValue,
  TaigaAttachment,
  TaigaHistoryEntry,
  TaigaMilestone,
  TaigaProject,
  TaigaWikiPage,
  TaigaWorkItem,
  UserRef,
} from './types.js';

const NONE = '-';

/** Line breaks and runs of whitespace, flattened so one record stays one line. */
function oneLine(text?: string | null): string {
  let flat = String(text ?? '');
  for (const character of ['\n', '\r', '\t', '\f', '\v']) {
    flat = flat.split(character).join(' ');
  }
  return flat.split(' ').filter(Boolean).join(' ');
}

/** `full_name_display`/`username` are the real keys; `*_extra_info` never carries `full_name`. */
export function userName(info?: UserRef | null): string | null {
  if (!info) return null;
  return info.full_name_display || info.full_name || info.username || null;
}

/**
 * Everyone assigned. Taiga user stories are multi-assignee: `assigned_users` holds IDs and
 * `assigned_to` is only the primary, so printing the primary alone misreports co-assigned work.
 */
export function assignees(item: TaigaWorkItem, namesById?: Map<number, string>): string {
  const ids = Array.isArray(item.assigned_users) ? item.assigned_users : [];
  if (ids.length > 1) {
    return namesById
      ? ids.map((id) => namesById.get(id) || `#${id}`).join('/')
      : `${userName(item.assigned_to_extra_info) ?? NONE}+${ids.length - 1}`;
  }
  return userName(item.assigned_to_extra_info) ?? NONE;
}

export function day(value?: string | null): string {
  return value ? String(value).slice(0, 10) : NONE;
}

/**
 * Total a Taiga points value, whatever shape it arrives in.
 *
 * The API is inconsistent: a milestone object carries plain numbers, while
 * `/milestones/{id}/stats` returns `total_points` as an object keyed by role ID
 * (`{"133": 90.0}`) and `completed_points` as an array (`[40.0]`). Concatenating those
 * directly produced `points: 40/[object Object] (NaN%)`.
 */
export function pointsSum(value?: PointsValue | null): number {
  if (Number.isFinite(value)) {
    // SAFETY: Number.isFinite confirms value is a number
    return value as number;
  }
  const parts = Array.isArray(value) ? value : Object.values(value ?? {});
  return parts.reduce((sum, part) => sum + (Number(part) || 0), 0);
}

/** Drop empty segments so a row never carries `| - | - |` noise. */
function row(...cells: (string | number | null | undefined)[]): string {
  return cells.filter((cell) => cell !== undefined && cell !== null && cell !== '' && cell !== NONE).join(' | ');
}

/** `19 acme-web Acme Web [private]` */
export function projectLine(project: TaigaProject): string {
  return row(`${project.id} ${oneLine(project.slug)}`, oneLine(project.name), project.is_private ? 'private' : null);
}

/**
 * `#70 Integrare Camera PTZ | Done | Sprint 2 | Jane Doe | 3pts | id=1888`
 * @param item
 * @param namesById
 * @param show set `sprint: false` inside a sprint view, where it is redundant
 */
export function workLine(item: TaigaWorkItem, namesById?: Map<number, string>, show: { sprint?: boolean } = {}): string {
  return row(
    `#${item.ref} ${oneLine(item.subject)}`,
    oneLine(item.status_extra_info?.name),
    show.sprint === false ? null : oneLine(item.milestone_name || item.milestone_extra_info?.name),
    oneLine(assignees(item, namesById)),
    oneLine(item.priority_extra_info?.name),
    item.total_points ? `${pointsSum(item.total_points)}pts` : null,
    item.user_story_extra_info ? `story #${item.user_story_extra_info.ref}` : null,
    `id=${item.id}`,
  );
}

/** `12 Sprint 2 | 2026-07-01..2026-07-15 | open | 5/14 stories` */
export function sprintLine(sprint: TaigaMilestone): string {
  const done = sprint.closed_points !== undefined && sprint.total_points !== undefined
    ? `${pointsSum(sprint.closed_points)}/${pointsSum(sprint.total_points)}pts` : null;
  return row(
    `${sprint.id} ${oneLine(sprint.name)}`,
    `${day(sprint.estimated_start)}..${day(sprint.estimated_finish)}`,
    sprint.closed ? 'closed' : 'open',
    sprint.user_stories ? `${sprint.user_stories.length} stories` : null,
    done,
  );
}

/** `4 home | v3 | 2026-08-01 | jdoe` */
export function wikiLine(page: TaigaWikiPage, namesById?: Map<number, string>): string {
  return row(
    `${page.id} ${oneLine(page.slug)}`,
    page.version ? `v${page.version}` : null,
    day(page.modified_date),
    page.owner !== undefined ? oneLine(namesById?.get(page.owner)) : undefined,
  );
}

/** `a1b2c3d4 2026-08-14 jdoe: looks good (edited)` */
export function commentLine(entry: TaigaHistoryEntry): string {
  const user = oneLine(entry.user?.username || userName(entry.user)) || '?';
  return row(
    `${String(entry.id).slice(0, 8)} ${day(entry.created_at)}`,
    `${user}: ${oneLine(entry.comment)}`,
    entry.edit_comment_date ? 'edited' : null,
  );
}

/** `123 diagram.png | 24KB | 2026-08-01` */
export function attachmentLine(attachment: TaigaAttachment): string {
  const size = attachment.size !== undefined && Number.isFinite(attachment.size)
    ? `${Math.max(1, Math.round(attachment.size / 1024))}KB`
    : null;
  return row(`${attachment.id} ${oneLine(attachment.name)}`, size, day(attachment.created_date));
}

/**
 * Detail view: `key: value` per line, omitting anything absent.
 */
export function details(pairs: [string, string | number | null | undefined][]): string {
  return pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== NONE)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/**
 * A list result: a header naming the collection and its size, then one line per record.
 * An empty collection is a normal result, not an error.
 *
 * The header MUST start with a letter. It used to read `1 projects`, which matches the same
 * `<number> <word>` shape as a record line (`19 acme-web`), and the first consumer that
 * parsed the output mistook the count for a record.
 * @param what e.g. `issues in acme-web`
 * @param rows rendered record lines
 * @param total full size before a `limit` truncated it
 */
export function listing(what: string, rows: string[], total?: number): string {
  const shown = total !== undefined && total !== rows.length ? `${rows.length} of ${total}` : String(rows.length);
  const header = `${what}: ${shown}`;
  return rows.length === 0 ? header : `${header}\n${rows.join('\n')}`;
}
