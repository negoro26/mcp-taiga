#!/usr/bin/env node

/**
 * Taiga MCP server.
 *
 * Transports: stdio by default; streamable HTTP at http://<host>:<port>/mcp when
 * TAIGA_HTTP_PORT is set (TAIGA_HTTP_HOST optionally overrides the bind host).
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
import { startHttpServer } from './http.js';
import { allTools, registerAllTools } from './tools/index.js';
import type { TaigaProject, TaigaUser } from './types.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), quiet: true });

function createServer(): McpServer {
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

  registerAllTools(server);
  return server;
}

const count = allTools.length;

if (process.env.TAIGA_HTTP_PORT) {
  const port = Number(process.env.TAIGA_HTTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid TAIGA_HTTP_PORT: "${process.env.TAIGA_HTTP_PORT}" is not a port number`);
    process.exit(1);
  }
  const host = process.env.TAIGA_HTTP_HOST || '127.0.0.1';
  await startHttpServer(port, host, createServer);
  console.error(`${SERVER_INFO.name} ${SERVER_INFO.version}: ${count} tools (http://${host}:${port}/mcp)`);
} else {
  const server = createServer();
  console.error(`${SERVER_INFO.name} ${SERVER_INFO.version}: ${count} tools`
    + `${isConfigured() ? '' : ' (TAIGA_USERNAME/TAIGA_PASSWORD not set)'}`);
  await server.connect(new StdioServerTransport());
}
