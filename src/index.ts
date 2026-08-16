#!/usr/bin/env node

/**
 * Taiga MCP server (stdio transport).
 *
 * Credentials come from the environment: TAIGA_API_URL, TAIGA_USERNAME, TAIGA_PASSWORD.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { get, isConfigured } from './api.js';
import { API_ENDPOINTS, RESOURCE_URIS, SERVER_INFO } from './constants.js';
import { registerAllTools } from './tools/index.js';
import type { TaigaProject, TaigaUser } from './types.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });

const server = new McpServer(SERVER_INFO, {
  capabilities: { tools: {}, resources: {} },
  instructions: 'Read and manage Taiga projects: user stories, tasks, issues, sprints, epics, wiki pages, '
    + 'comments and attachments. Project arguments accept a numeric ID or a slug; work items accept a numeric '
    + 'ID or a #reference (a #reference also needs the project).',
});

server.registerResource(
  'projects',
  RESOURCE_URIS.PROJECTS,
  {
    title: 'Taiga projects',
    description: 'Projects visible to the authenticated user, as JSON.',
    mimeType: 'application/json',
  },
  async (uri: URL) => {
    const projects = await get<TaigaProject[]>(API_ENDPOINTS.PROJECTS, { member: (await get<TaigaUser>(API_ENDPOINTS.USERS_ME)).id });
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          projects.map(({ id, name, slug, description }) => ({ id, name, slug, description })),
          null,
          2,
        ),
      }],
    };
  },
);

const count = registerAllTools(server);
console.error(`${SERVER_INFO.name} ${SERVER_INFO.version}: ${count} tools`
  + `${isConfigured() ? '' : ' (TAIGA_USERNAME/TAIGA_PASSWORD not set)'}`);

await server.connect(new StdioServerTransport());
