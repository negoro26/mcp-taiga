import type { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredTool } from '../types.js';
import { tools as projects } from './projects.js';
import { tools as work } from './work.js';
import { tools as sprints } from './sprints.js';
import { tools as comments } from './comments.js';
import { tools as attachments } from './attachments.js';
import { tools as wiki } from './wiki.js';

export const allTools: RegisteredTool[] = [...projects, ...work, ...sprints, ...comments, ...attachments, ...wiki];

export function registerAllTools(server: McpServer): number {
  for (const tool of allTools) {
    tool.register(server);
  }
  return allTools.length;
}
