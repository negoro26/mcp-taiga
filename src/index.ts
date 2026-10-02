#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, isConfigured } from './api.js';
import { API_ENDPOINTS, RESOURCE_URIS, SERVER_INFO } from './constants.js';
import { allTools, registerAllTools } from './tools/index.js';
import type { TaigaProject, TaigaUser } from './types.js';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

function createServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    instructions: 'Read and manage Taiga. Start with projects op=list when the project is unknown, then prefer the '
      + 'numeric IDs it returns.',
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
console.error(`${SERVER_INFO.name} ${SERVER_INFO.version}: ${count} tools${isConfigured() ? '' : ' (TAIGA_USERNAME/TAIGA_PASSWORD not set)'}`);
serveStdio(createServer);
