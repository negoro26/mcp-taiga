
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

function oneLine(text?: string | null): string {
  let flat = String(text ?? '');
  for (const character of ['\n', '\r', '\t', '\f', '\v']) {
    flat = flat.split(character).join(' ');
  }
  return flat.split(' ').filter(Boolean).join(' ');
}

export function userName(info?: UserRef | null): string | null {
  if (!info) return null;
  return info.full_name_display || info.full_name || info.username || null;
}

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

export function pointsSum(value?: PointsValue | null): number {
  if (Number.isFinite(value)) {
    return value as number;
  }
  const parts = Array.isArray(value) ? value : Object.values(value ?? {});
  return parts.reduce((sum, part) => sum + (Number(part) || 0), 0);
}

function row(...cells: (string | number | null | undefined)[]): string {
  return cells.filter((cell) => cell !== undefined && cell !== null && cell !== '' && cell !== NONE).join(' | ');
}

export function projectLine(project: TaigaProject): string {
  return row(`${project.id} ${oneLine(project.slug)}`, oneLine(project.name), project.is_private ? 'private' : null);
}

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

export function wikiLine(page: TaigaWikiPage, namesById?: Map<number, string>): string {
  return row(
    `${page.id} ${oneLine(page.slug)}`,
    page.version ? `v${page.version}` : null,
    day(page.modified_date),
    page.owner !== undefined ? oneLine(namesById?.get(page.owner)) : undefined,
  );
}

export function commentLine(entry: TaigaHistoryEntry): string {
  const user = oneLine(entry.user?.username || userName(entry.user)) || '?';
  return row(
    `${String(entry.id).slice(0, 8)} ${day(entry.created_at)}`,
    `${user}: ${oneLine(entry.comment)}`,
    entry.edit_comment_date ? 'edited' : null,
  );
}

export function attachmentLine(attachment: TaigaAttachment): string {
  const size = attachment.size !== undefined && Number.isFinite(attachment.size)
    ? `${Math.max(1, Math.round(attachment.size / 1024))}KB`
    : null;
  return row(`${attachment.id} ${oneLine(attachment.name)}`, size, day(attachment.created_date));
}

export function details(pairs: [string, string | number | null | undefined][]): string {
  const lines: string[] = [];
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null && value !== '' && value !== NONE) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

export function listing(what: string, rows: string[], total?: number): string {
  const shown = total !== undefined && total !== rows.length ? `${rows.length} of ${total}` : String(rows.length);
  const header = `${what}: ${shown}`;
  return rows.length === 0 ? header : `${header}\n${rows.join('\n')}`;
}
