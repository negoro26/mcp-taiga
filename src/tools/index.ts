/**
 * Tool registry. Six op-dispatching tools, one per Taiga domain.
 *
 * Each module exports a `tools` array of definitions:
 *   { name, title, description, inputSchema, annotations, handler }
 *
 * No tool declares an `outputSchema` and no handler returns `structuredContent`: omp's MCP bridge
 * concatenates `type === 'text'` content and ignores both, so they are pure `tools/list` overhead.
 * The text a handler returns is the whole result.
 *
 * Handlers may throw; `guard` converts a throw into an MCP tool error so the model can self-correct.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RegisteredTool } from '../types.js';
import { tools as projects } from './projects.js';
import { tools as work } from './work.js';
import { tools as sprints } from './sprints.js';
import { tools as comments } from './comments.js';
import { tools as attachments } from './attachments.js';
import { tools as wiki } from './wiki.js';

export const allTools: RegisteredTool[] = [...projects, ...work, ...sprints, ...comments, ...attachments, ...wiki];

/**
 * Register every tool with an McpServer.
 */
export function registerAllTools(server: McpServer): number {
  for (const tool of allTools) {
    tool.register(server);
  }
  return allTools.length;
}
