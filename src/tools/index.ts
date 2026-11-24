import type { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredTool } from '../types.js';
import { requestedToolNames } from '../api.js';
import { tools as projects } from './projects.js';
import { tools as work } from './work.js';
import { tools as sprints } from './sprints.js';
import { tools as comments } from './comments.js';
import { tools as attachments } from './attachments.js';
import { tools as wiki } from './wiki.js';
import { tools as activity } from './activity.js';

export const allTools: RegisteredTool[] = [...projects, ...work, ...sprints, ...comments, ...attachments, ...wiki, ...activity];

export function enabledTools(): RegisteredTool[] {
  const requested = requestedToolNames();

  if (!requested) return allTools;
  const valid = new Set(allTools.map((tool) => tool.name));

  for (const name of requested) {
    if (!valid.has(name)) {
      throw new Error(`Unknown tool "${name}" in TAIGA_TOOLS. Available: ${[...valid].join(', ')}`);
    }
  }

  const allowed = new Set(requested);

  return allTools.filter((tool) => allowed.has(tool.name));
}

export function registerAllTools(server: McpServer): number {
  const active = enabledTools();

  for (const tool of active) {
    tool.register(server);
  }

  return active.length;
}
