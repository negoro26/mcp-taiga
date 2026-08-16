#!/usr/bin/env node
/**
 * API Contract Test Suite: verifies that every MCP tool sends the expected HTTP requests
 * and handles responses according to the Taiga REST API specification without a live Taiga instance.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { allTools } from '../src/tools/index.js';
import { isNumericId } from '../src/taiga.js';
import { MAX_ATTACHMENT_BYTES } from '../src/constants.js';
import { login } from '../src/api.js';
import type {
  ApiError,
  AuthResponse,
  CallToolResult,
  JsonBody,
  JsonValue,
  TaigaAttachment,
  TaigaHistoryEntry,
  TaigaMilestone,
  TaigaMilestoneStats,
  TaigaProject,
  TaigaTaxonomyItem,
  TaigaUser,
  TaigaWikiPage,
  TaigaWorkItem,
} from '../src/types.js';

interface RecordedBody {
  name?: string;
  project?: number | string;
  projectId?: number | string;
  estimated_start?: string;
  estimated_finish?: string;
  subject?: string;
  version?: number;
  status?: number | string;
  priority?: number | string;
  severity?: number | string;
  type?: number | string;
  milestone?: number | string;
  user_story?: number | string;
  userStoryId?: number | string;
  color?: string;
  slug?: string;
  content?: string;
  watchers?: number[];
  comment?: string;
  epic?: number | string;
  items?: Array<{
    subject?: string;
    status?: string;
    priority?: string;
    severity?: string;
    issueType?: string;
    tags?: string[];
    points?: number;
    color?: string;
  }>;
  points?: Record<string, number> | number | string;
  total_points?: JsonValue;
  [key: string]: JsonValue | undefined;
}

interface RecordedRequest {
  method?: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: RecordedBody | null;
  rawBody: string;
}

type MockPayload =
  | JsonValue
  | JsonBody
  | TaigaProject
  | TaigaProject[]
  | TaigaWorkItem
  | TaigaWorkItem[]
  | TaigaMilestone
  | TaigaMilestone[]
  | TaigaMilestoneStats
  | TaigaAttachment
  | TaigaAttachment[]
  | TaigaWikiPage
  | TaigaWikiPage[]
  | TaigaTaxonomyItem
  | TaigaTaxonomyItem[]
  | TaigaHistoryEntry
  | TaigaHistoryEntry[]
  | TaigaUser
  | TaigaUser[]
  | AuthResponse;

function isListHeader(line: string): boolean {
  if (!line) return false;
  const colonIndex = line.indexOf(': ');
  if (colonIndex <= 0) return false;
  const first = line[0] ?? '';
  if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z'))) return false;
  const after = line.slice(colonIndex + 2);
  if (isNumericId(after)) return true;
  const parts = after.split(' of ');
  if (parts.length === 2 && isNumericId(parts[0]) && isNumericId(parts[1])) {
    return true;
  }
  return false;
}

function isDigitRecord(line: string): boolean {
  const trimmed = line.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const token = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return isNumericId(token);
}
function isWorkRecord(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  return trimmed.startsWith('#') && trimmed.includes('id=');
}
function resultText(result: CallToolResult): string {
  for (const block of result.content) {
    if (block.type === 'text') {
      return block.text;
    }
  }
  return '';
}

const requests: RecordedRequest[] = [];
let serverPort = 0;
let throttleRecoverHits = 0;
// 1. In-process mock Taiga HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = parsedUrl.pathname;
  const segments = pathname.split('/').filter(Boolean);
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    // SAFETY: IncomingMessage stream chunks are Buffer instances
    chunks.push(chunk as Buffer);
  }
  const rawBuffer = Buffer.concat(chunks);
  const rawBody = rawBuffer.toString('utf8');
  let body: RecordedBody | null = null;
  if (rawBody && req.headers['content-type']?.includes('application/json')) {
    try {
      // SAFETY: JSON.parse of application/json payload parsed to RecordedBody
      body = JSON.parse(rawBody) as RecordedBody;
    } catch {
      body = null;
    }
  }

  requests.push({
    method: req.method,
    path: pathname,
    query,
    headers: req.headers,
    body,
    rawBody,
  });

  const sendJson = (status: number, data: MockPayload): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // Media download mock
  if (pathname === '/media/redirect-source.txt') {
    res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/media/redirect-target.txt` });
    res.end();
    return;
  }
  if (pathname === '/media/redirect-target.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('redirected-target-content');
    return;
  }
  if (pathname === '/media/oversized-attachment.bin') {
    const oversizedLength = MAX_ATTACHMENT_BYTES + 1;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(oversizedLength),
    });
    res.end(Buffer.alloc(oversizedLength));
    return;
  }
  if (pathname.startsWith('/media/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('attachment-file-content');
    return;
  }

  // Auth endpoint
  if (pathname === '/api/v1/auth' && req.method === 'POST') {
    sendJson(200, {
      auth_token: 'contract-test-token',
      refresh: 'contract-test-refresh',
      id: 1,
      username: 'tester',
      full_name_display: 'Tester User',
    });
    return;
  }

  // Current user (deliberately no full_name property, only full_name_display)
  if (pathname === '/api/v1/users/me' && req.method === 'GET') {
    sendJson(200, { id: 1, username: 'tester', full_name_display: 'Tester User' });
    return;
  }

  // Users (project members)
  if (pathname === '/api/v1/users' && req.method === 'GET') {
    sendJson(200, [
      { id: 1, username: 'tester', full_name_display: 'Tester User' },
      { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
      { id: 3, username: 'jsmith', full_name_display: 'John Display' },
    ]);
    return;
  }

  // Projects
  if (pathname === '/api/v1/projects/by_slug' && query['slug'] === 'throttle-recover' && req.method === 'GET') {
    throttleRecoverHits += 1;
    if (throttleRecoverHits === 1) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ _error_message: 'Too Many Requests' }));
      return;
    }
    sendJson(200, {
      id: 99,
      name: 'Throttle Recover',
      slug: 'throttle-recover',
      description: 'Throttle Recover Project',
      total_memberships: 1,
      is_private: false,
      owner: { username: 'tester', full_name_display: 'Tester User' },
    });
    return;
  }

  if (pathname === '/api/v1/projects/by_slug' && query['slug'] === 'throttle-giveup' && req.method === 'GET') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    res.end(JSON.stringify({ _error_message: 'Too Many Requests' }));
    return;
  }

  if (pathname === '/api/v1/projects/by_slug' && query['slug'] === 'cached-project' && req.method === 'GET') {
    sendJson(200, {
      id: 98,
      name: 'Cached Project',
      slug: 'cached-project',
      description: 'Cached Project',
      total_memberships: 2,
      is_private: false,
      owner: { username: 'tester', full_name_display: 'Tester User' },
      is_epics_activated: true,
      is_backlog_activated: true,
      is_kanban_activated: true,
      is_wiki_activated: true,
      is_issues_activated: true,
    });
    return;
  }

  if (pathname === '/api/v1/projects/by_slug' && query['slug'] === 'cached-project-b' && req.method === 'GET') {
    sendJson(200, {
      id: 97,
      name: 'Cached Project B',
      slug: 'cached-project-b',
      description: 'Cached Project B',
      total_memberships: 2,
      is_private: false,
      owner: { username: 'tester', full_name_display: 'Tester User' },
      is_epics_activated: true,
      is_backlog_activated: true,
      is_kanban_activated: true,
      is_wiki_activated: true,
      is_issues_activated: true,
    });
    return;
  }

  if (pathname === '/api/v1/milestones' && req.method === 'POST' && body?.name === 'server-error-500') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ _error_message: 'Internal Server Error' }));
    return;
  }

  if (pathname === '/api/v1/projects/by_slug' && req.method === 'GET') {
    sendJson(200, {
      id: 1,
      name: 'Project 1',
      slug: query['slug'] || 'project-1',
      description: 'Test Project',
      total_memberships: 3,
      is_private: false,
      owner: { username: 'tester', full_name_display: 'Tester User' },
      is_epics_activated: true,
      is_backlog_activated: true,
      is_kanban_activated: true,
      is_wiki_activated: true,
      is_issues_activated: true,
    });
    return;
  }
  if (pathname === '/api/v1/projects' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 1,
        name: 'Project 1',
        slug: 'project-1',
        description: 'Test Project',
        total_memberships: 3,
        is_private: false,
        owner: { username: 'tester', full_name_display: 'Tester User' },
        is_epics_activated: true,
        is_backlog_activated: true,
        is_kanban_activated: true,
        is_wiki_activated: true,
        is_issues_activated: true,
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/projects/1' && req.method === 'GET') {
    sendJson(200, {
      id: 1,
      name: 'Project 1',
      slug: 'project-1',
      description: 'Test Project',
      total_memberships: 3,
      is_private: false,
      owner: { username: 'tester', full_name_display: 'Tester User' },
      is_epics_activated: true,
      is_backlog_activated: true,
      is_kanban_activated: true,
      is_wiki_activated: true,
      is_issues_activated: true,
    });
    return;
  }

  // Taxonomies
  if (pathname === '/api/v1/issue-statuses' && req.method === 'GET') {
    sendJson(200, [
      { id: 11, name: 'New' },
      { id: 12, name: 'In progress' },
      { id: 13, name: 'Closed', is_closed: true },
    ]);
    return;
  }

  if (pathname === '/api/v1/userstory-statuses' && req.method === 'GET') {
    sendJson(200, [
      { id: 51, name: 'New' },
      { id: 52, name: 'In progress' },
      { id: 53, name: 'Done', is_closed: true },
    ]);
    return;
  }

  if (pathname === '/api/v1/task-statuses' && req.method === 'GET') {
    sendJson(200, [
      { id: 61, name: 'New' },
      { id: 62, name: 'In progress' },
      { id: 63, name: 'Closed', is_closed: true },
    ]);
    return;
  }

  if (pathname === '/api/v1/epic-statuses' && req.method === 'GET') {
    sendJson(200, [
      { id: 71, name: 'New' },
      { id: 72, name: 'In progress' },
      { id: 73, name: 'Closed', is_closed: true },
    ]);
    return;
  }

  if (pathname === '/api/v1/priorities' && req.method === 'GET') {
    sendJson(200, [
      { id: 21, name: 'Low' },
      { id: 22, name: 'Normal' },
      { id: 23, name: 'High' },
    ]);
    return;
  }

  if (pathname === '/api/v1/severities' && req.method === 'GET') {
    sendJson(200, [
      { id: 31, name: 'Minor' },
      { id: 32, name: 'Normal' },
      { id: 33, name: 'Critical' },
    ]);
    return;
  }

  if (pathname === '/api/v1/issue-types' && req.method === 'GET') {
    sendJson(200, [
      { id: 41, name: 'Bug' },
      { id: 42, name: 'Question' },
      { id: 43, name: 'Enhancement' },
    ]);
    return;
  }

  if (pathname === '/api/v1/points' && req.method === 'GET') {
    sendJson(200, [
      { id: 217, name: '?', value: null },
      { id: 220, name: '1', value: 1 },
      { id: 222, name: '3', value: 3 },
      { id: 312, name: '50', value: 50 },
    ]);
    return;
  }

  if (pathname === '/api/v1/roles' && req.method === 'GET') {
    sendJson(200, [
      { id: 133, name: 'Story Points', computable: true },
      { id: 134, name: 'Product Owner', computable: false },
      { id: 135, name: 'UX Designer', computable: false },
    ]);
    return;
  }

  // Milestones (Sprints)
  if (pathname === '/api/v1/milestones' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 10,
        name: 'Sprint 1',
        slug: 'sprint-1',
        project: 1,
        estimated_start: '2026-08-01',
        estimated_finish: '2026-08-15',
        closed: false,
        total_points: { '133': 90 },
        closed_points: [40],
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/milestones' && req.method === 'POST') {
    sendJson(201, {
      id: 10,
      name: body?.name || 'Sprint 2',
      slug: 'sprint-2',
      project: Number(body?.project) || 1,
      estimated_start: body?.estimated_start || '2026-09-01',
      estimated_finish: body?.estimated_finish || '2026-09-15',
      closed: false,
      total_points: 0,
      closed_points: 0,
      project_extra_info: { name: 'Project 1' },
    });
    return;
  }

  if (pathname === '/api/v1/milestones/10/stats' && req.method === 'GET') {
    sendJson(200, {
      name: 'Sprint 1',
      estimated_start: '2026-08-01',
      estimated_finish: '2026-08-15',
      total_points: { '133': 90 },
      completed_points: [40],
      total_userstories: 7,
      completed_userstories: 4,
      total_tasks: 57,
      completed_tasks: 28,
      total_hours: 20,
      completed_hours: 10,
    });
    return;
  }

  if (pathname === '/api/v1/milestones/10' && req.method === 'GET') {
    sendJson(200, {
      id: 10,
      name: 'Sprint 1',
      slug: 'sprint-1',
      project: 1,
      estimated_start: '2026-08-01',
      estimated_finish: '2026-08-15',
      closed: false,
      total_points: { '133': 90 },
      closed_points: [40],
      user_stories: [],
    });
    return;
  }

  // Issues
  if (pathname === '/api/v1/issues/by_ref' && req.method === 'GET') {
    sendJson(200, {
      id: 101,
      ref: Number(query['ref'] || 1),
      subject: 'Issue 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      priority_extra_info: { name: 'High' },
      severity_extra_info: { name: 'Critical' },
      type_extra_info: { name: 'Bug' },
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
      milestone_extra_info: { name: 'Sprint 1' },
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'Test issue description',
      tags: ['bug'],
    });
    return;
  }

  if (pathname === '/api/v1/issues' && req.method === 'GET') {
    if (query['q'] === 'empty') {
      sendJson(200, []);
      return;
    }
    sendJson(200, [
      {
        id: 101,
        ref: 1,
        subject: 'Issue 1',
        project: 1,
        version: 1,
        status_extra_info: { name: 'In progress' },
        priority_extra_info: { name: 'High' },
        severity_extra_info: { name: 'Critical' },
        type_extra_info: { name: 'Bug' },
        assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
        milestone_extra_info: { name: 'Sprint 1' },
        created_date: '2026-08-01T00:00:00Z',
        modified_date: '2026-08-02T00:00:00Z',
        description: 'Test issue description',
        tags: ['bug'],
      },
      {
        id: 102,
        ref: 2,
        subject: 'Issue 2',
        project: 1,
        version: 1,
        status_extra_info: { name: 'New' },
        priority_extra_info: { name: 'Normal' },
        severity_extra_info: { name: 'Normal' },
        type_extra_info: { name: 'Enhancement' },
        assigned_to_extra_info: { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
        milestone_extra_info: { name: 'Sprint 1' },
        created_date: '2026-08-02T00:00:00Z',
        modified_date: '2026-08-03T00:00:00Z',
        description: 'Second issue description',
        tags: ['enhancement'],
      },
      {
        id: 103,
        ref: 3,
        subject: 'Issue 3',
        project: 1,
        version: 1,
        status_extra_info: { name: 'New' },
        priority_extra_info: { name: 'Low' },
        severity_extra_info: { name: 'Minor' },
        type_extra_info: { name: 'Question' },
        assigned_to_extra_info: { id: 3, username: 'jsmith', full_name_display: 'John Display' },
        created_date: '2026-08-03T00:00:00Z',
        modified_date: '2026-08-04T00:00:00Z',
        description: 'Third issue description',
        tags: ['question'],
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/issues' && req.method === 'POST') {
    if (body?.subject === 'FORCE_FAIL_BATCH') {
      sendJson(400, { _error_message: 'Invalid issue creation' });
      return;
    }
    sendJson(201, {
      id: 101,
      ref: 1,
      subject: body?.subject || 'Issue 1',
      project: Number(body?.project) || 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      priority_extra_info: { name: 'High' },
      severity_extra_info: { name: 'Critical' },
      type_extra_info: { name: 'Bug' },
    });
    return;
  }

  if (pathname === '/api/v1/issues/101' && req.method === 'GET') {
    sendJson(200, {
      id: 101,
      ref: 1,
      subject: 'Issue 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      priority_extra_info: { name: 'High' },
      severity_extra_info: { name: 'Critical' },
      type_extra_info: { name: 'Bug' },
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
      milestone_extra_info: { name: 'Sprint 1' },
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'Test issue description',
      tags: ['bug'],
    });
    return;
  }

  // Issue 102 with a long description (> 2000 chars) for truncation testing
  if (pathname === '/api/v1/issues/102' && req.method === 'GET') {
    sendJson(200, {
      id: 102,
      ref: 2,
      subject: 'Long Description Issue',
      project: 1,
      version: 1,
      status_extra_info: { name: 'New' },
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'A'.repeat(2500),
    });
    return;
  }

  if (pathname === '/api/v1/issues/101' && req.method === 'PATCH') {
    sendJson(200, {
      id: 101,
      ref: 1,
      subject: body?.subject || 'Issue 1',
      project: 1,
      version: (body?.version || 1) + 1,
      status_extra_info: { name: 'In progress' },
      milestone_extra_info: { name: 'Sprint 1' },
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
    });
    return;
  }

  if (pathname === '/api/v1/issues/101' && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  // User Stories (multi-assignee: assigned_users [1, 2], assigned_to_extra_info without full_name)
  if (pathname === '/api/v1/userstories/by_ref' && req.method === 'GET') {
    const requestedRef = Number(query['ref'] || 2);
    if (requestedRef === 20) {
      sendJson(200, {
        id: 202,
        ref: 20,
        subject: 'Story 2',
        project: 1,
        version: 1,
        status_extra_info: { name: 'In progress' },
        assigned_users: [1],
        assigned_to: 1,
        assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
        milestone_extra_info: { name: 'Sprint 1' },
        milestone_name: 'Sprint 1',
        created_date: '2026-08-01T00:00:00Z',
        modified_date: '2026-08-02T00:00:00Z',
        description: 'Test story 2 description',
        tags: ['feature'],
        points: { '133': 217 },
        total_points: null,
        tasks: [],
      });
      return;
    }
    sendJson(200, {
      id: 201,
      ref: requestedRef,
      subject: 'Story 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      assigned_users: [1, 2],
      assigned_to: 2,
      assigned_to_extra_info: { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
      milestone_extra_info: { name: 'Sprint 1' },
      milestone_name: 'Sprint 1',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'Test story description',
      tags: ['feature'],
      points: { '133': 217 },
      total_points: null,
      tasks: [],
    });
    return;
  }

  if (pathname === '/api/v1/userstories' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 201,
        ref: 2,
        subject: 'Story 1',
        project: 1,
        version: 1,
        status_extra_info: { name: 'In progress' },
        assigned_users: [1, 2],
        assigned_to: 2,
        assigned_to_extra_info: { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
        milestone_extra_info: { name: 'Sprint 1' },
        milestone_name: 'Sprint 1',
        created_date: '2026-08-01T00:00:00Z',
        modified_date: '2026-08-02T00:00:00Z',
        description: 'Test story description',
        tags: ['feature'],
      points: { '133': 217 },
      total_points: null,
        tasks: [],
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/userstories' && req.method === 'POST') {
    sendJson(201, {
      id: 201,
      ref: 2,
      subject: body?.subject || 'Story 1',
      project: Number(body?.project) || 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
    });
    return;
  }

  if (pathname === '/api/v1/userstories/201' && req.method === 'GET') {
    sendJson(200, {
      id: 201,
      ref: 2,
      subject: 'Story 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      assigned_users: [1, 2],
      assigned_to: 2,
      assigned_to_extra_info: { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
      milestone_extra_info: { name: 'Sprint 1' },
      milestone_name: 'Sprint 1',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'Test story description',
      tags: ['feature'],
      points: { '133': 217 },
      total_points: null,
      tasks: [],
    });
    return;
  }
  if (pathname === '/api/v1/userstories/202' && req.method === 'GET') {
    sendJson(200, {
      id: 202,
      ref: 20,
      subject: 'Story 2',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      assigned_users: [1],
      assigned_to: 1,
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
      milestone_extra_info: { name: 'Sprint 1' },
      milestone_name: 'Sprint 1',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      description: 'Test story 2 description',
      tags: ['feature'],
      points: { '133': 217 },
      total_points: null,
      tasks: [],
    });
    return;
  }

  if (pathname === '/api/v1/userstories/201' && req.method === 'PATCH') {
    sendJson(200, {
      id: 201,
      ref: 2,
      subject: body?.subject || 'Story 1',
      project: 1,
      version: (body?.version || 1) + 1,
      status_extra_info: { name: 'In progress' },
      assigned_users: [1, 2],
      assigned_to: 2,
      assigned_to_extra_info: { id: 2, username: 'alex', full_name_display: 'Alex Developer' },
      milestone: body?.milestone !== undefined ? Number(body.milestone) : undefined,
      milestone_name: 'Sprint 1',
      milestone_extra_info: { name: 'Sprint 1' },
      project_extra_info: { name: 'Project 1' },
    });
    return;
  }

  if (pathname === '/api/v1/userstories/201' && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Tasks
  if (pathname === '/api/v1/tasks/by_ref' && req.method === 'GET') {
    sendJson(200, {
      id: 301,
      ref: Number(query['ref'] || 3),
      subject: 'Task 1',
      project: 1,
      version: 1,
      user_story: 201,
      user_story_extra_info: { ref: 2, subject: 'Story 1' },
      status_extra_info: { name: 'In progress' },
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
    });
    return;
  }

  if (pathname === '/api/v1/tasks' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 301,
        ref: 3,
        subject: 'Task 1',
        project: 1,
        version: 1,
        user_story: 201,
        user_story_extra_info: { ref: 2, subject: 'Story 1' },
        status_extra_info: { name: 'In progress' },
        assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/tasks' && req.method === 'POST') {
    sendJson(201, {
      id: 301,
      ref: 3,
      subject: body?.subject || 'Task 1',
      project: Number(body?.project) || 1,
      user_story: Number(body?.user_story) || 201,
      version: 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
      user_story_extra_info: { ref: 2, subject: 'Story 1' },
    });
    return;
  }

  if (pathname === '/api/v1/tasks/301' && req.method === 'GET') {
    sendJson(200, {
      id: 301,
      ref: 3,
      subject: 'Task 1',
      project: 1,
      version: 1,
      user_story: 201,
      user_story_extra_info: { ref: 2, subject: 'Story 1' },
      status_extra_info: { name: 'In progress' },
      assigned_to_extra_info: { id: 1, username: 'tester', full_name_display: 'Tester User' },
    });
    return;
  }

  if (pathname === '/api/v1/tasks/301' && req.method === 'PATCH') {
    sendJson(200, {
      id: 301,
      ref: 3,
      subject: body?.subject || 'Task 1',
      project: 1,
      version: (body?.version || 1) + 1,
      user_story: 201,
      status_extra_info: { name: 'In progress' },
    });
    return;
  }

  if (pathname === '/api/v1/tasks/301' && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Epics
  if (pathname === '/api/v1/epics/by_ref' && req.method === 'GET') {
    sendJson(200, {
      id: 401,
      ref: Number(query['ref'] || 4),
      subject: 'Epic 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
      color: '#FF5733',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      user_stories: [],
      user_stories_counts: { total: 0, progress: 0 },
    });
    return;
  }

  if (pathname === '/api/v1/epics' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 401,
        ref: 4,
        subject: 'Epic 1',
        project: 1,
        version: 1,
        status_extra_info: { name: 'In progress' },
        project_extra_info: { name: 'Project 1' },
        color: '#FF5733',
        created_date: '2026-08-01T00:00:00Z',
        modified_date: '2026-08-02T00:00:00Z',
        user_stories: [],
        user_stories_counts: { total: 0, progress: 0 },
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/epics' && req.method === 'POST') {
    sendJson(201, {
      id: 401,
      ref: 4,
      subject: body?.subject || 'Epic 1',
      project: Number(body?.project) || 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
      color: body?.color || '#FF5733',
    });
    return;
  }

  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'epics' &&
    isNumericId(segments[3]) &&
    segments[4] === 'related_userstories' &&
    isNumericId(segments[5]) &&
    req.method === 'DELETE'
  ) {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'epics' &&
    isNumericId(segments[3]) &&
    segments[4] === 'related_userstories' &&
    req.method === 'POST'
  ) {
    sendJson(201, {
      id: 501,
      epic: 401,
      user_story: body?.user_story !== undefined ? Number(body.user_story) : undefined,
    });
    return;
  }

  if (pathname === '/api/v1/epics/401' && req.method === 'GET') {
    sendJson(200, {
      id: 401,
      ref: 4,
      subject: 'Epic 1',
      project: 1,
      version: 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
      color: '#FF5733',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      user_stories: [],
      user_stories_counts: { total: 0, progress: 0 },
    });
    return;
  }

  if (pathname === '/api/v1/epics/401' && req.method === 'PATCH') {
    sendJson(200, {
      id: 401,
      ref: 4,
      subject: body?.subject || 'Epic 1',
      project: 1,
      version: (body?.version || 1) + 1,
      status_extra_info: { name: 'In progress' },
      project_extra_info: { name: 'Project 1' },
      color: body?.color || '#FF5733',
    });
    return;
  }

  if (pathname === '/api/v1/epics/401' && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (
    segments.length === 4 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    (segments[2] === 'issues' || segments[2] === 'userstories' || segments[2] === 'tasks' || segments[2] === 'epics') &&
    isNumericId(segments[3]) &&
    req.method === 'DELETE'
  ) {
    res.writeHead(204);
    res.end();
    return;
  }

  // Wiki
  if (pathname === '/api/v1/wiki/by_slug' && req.method === 'GET') {
    sendJson(200, {
      id: 601,
      slug: query['slug'] || 'home',
      project: 1,
      version: 1,
      content: 'Wiki content markdown',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      watchers: [],
      owner: 1,
      last_modifier: 2,
    });
    return;
  }

  if (pathname === '/api/v1/wiki' && req.method === 'GET') {
    sendJson(200, [
      {
        id: 601,
        slug: 'home',
        project: 1,
        version: 1,
        content: 'Wiki content markdown',
        created_date: '2026-08-01T00:00:00Z',
        modified_date: '2026-08-02T00:00:00Z',
        watchers: [],
        owner: 1,
        last_modifier: 2,
      },
    ]);
    return;
  }

  if (pathname === '/api/v1/wiki' && req.method === 'POST') {
    sendJson(201, {
      id: 601,
      slug: body?.slug || 'home',
      project: Number(body?.project) || 1,
      version: 1,
      content: body?.content || '',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      watchers: body?.watchers || [],
      owner: 1,
      last_modifier: 1,
    });
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'wiki' &&
    isNumericId(segments[3]) &&
    segments[4] === 'watch' &&
    req.method === 'POST'
  ) {
    sendJson(200, {});
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'wiki' &&
    isNumericId(segments[3]) &&
    segments[4] === 'unwatch' &&
    req.method === 'POST'
  ) {
    sendJson(200, {});
    return;
  }
  if (pathname === '/api/v1/wiki/601' && req.method === 'GET') {
    sendJson(200, {
      id: 601,
      slug: 'home',
      project: 1,
      version: 1,
      content: 'Wiki content markdown',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      watchers: [],
      owner: 1,
      last_modifier: 2,
    });
    return;
  }

  if (pathname === '/api/v1/wiki/601' && req.method === 'PATCH') {
    sendJson(200, {
      id: 601,
      slug: 'home',
      project: 1,
      version: (body?.version || 1) + 1,
      content: body?.content || 'Updated wiki content',
      created_date: '2026-08-01T00:00:00Z',
      modified_date: '2026-08-02T00:00:00Z',
      watchers: body?.watchers || [],
      owner: 1,
      last_modifier: 1,
    });
    return;
  }

  if (pathname === '/api/v1/wiki/601' && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }

  // History & Comments
  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'history' &&
    isNumericId(segments[4]) &&
    segments[5] === 'edit_comment' &&
    req.method === 'POST'
  ) {
    sendJson(200, {});
    return;
  }

  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'history' &&
    isNumericId(segments[4]) &&
    segments[5] === 'delete_comment' &&
    req.method === 'POST'
  ) {
    sendJson(200, {});
    return;
  }

  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'history' &&
    isNumericId(segments[4]) &&
    req.method === 'GET'
  ) {
    sendJson(200, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        user: { name: 'Tester User', username: 'tester' },
        created_at: '2026-08-01T12:00:00Z',
        comment: 'Sample comment text',
        edit_comment_date: null,
        delete_comment_date: null,
      },
    ]);
    return;
  }

  // Attachments (issues, userstories, tasks, epics, wiki)
  const attachmentEntities = { issues: true, userstories: true, tasks: true, epics: true, wiki: true } satisfies Record<string, true>;
  if (
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    (segments[2] ?? '') in attachmentEntities &&
    segments[3] === 'attachments' &&
    (segments.length === 4 || (segments.length === 5 && isNumericId(segments[4])))
  ) {
    const isSingle = segments.length === 5;
    if (isSingle) {
      if (req.method === 'GET') {
        const attId = Number(segments[4]);
        if (attId === 702) {
          sendJson(200, {
            id: 702,
            name: 'foreign-attachment.txt',
            size: 24,
            url: 'http://foreign.example.com/media/foreign-attachment.txt',
            created_date: '2026-08-01T00:00:00Z',
          });
          return;
        }
        if (attId === 703) {
          sendJson(200, {
            id: 703,
            name: 'passwd',
            size: 100,
            url: 'file:///etc/passwd',
            created_date: '2026-08-01T00:00:00Z',
          });
          return;
        }
        if (attId === 704) {
          sendJson(200, {
            id: 704,
            name: 'data-attachment.txt',
            size: 100,
            url: 'data:text/plain;base64,SGVsbG8=',
            created_date: '2026-08-01T00:00:00Z',
          });
          return;
        }
        if (attId === 705) {
          sendJson(200, {
            id: 705,
            name: 'redirect-attachment.txt',
            size: 24,
            url: `http://127.0.0.1:${serverPort}/media/redirect-source.txt`,
            created_date: '2026-08-01T00:00:00Z',
          });
          return;
        }
        if (attId === 706) {
          sendJson(200, {
            id: 706,
            name: 'oversized-attachment.bin',
            size: MAX_ATTACHMENT_BYTES + 1,
            url: `http://127.0.0.1:${serverPort}/media/oversized-attachment.bin`,
            created_date: '2026-08-01T00:00:00Z',
          });
          return;
        }
        sendJson(200, {
          id: 701,
          name: 'test-attachment.txt',
          size: 24,
          url: `http://127.0.0.1:${serverPort}/media/test-attachment.txt`,
          created_date: '2026-08-01T00:00:00Z',
        });
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
    } else {
      if (req.method === 'GET') {
        sendJson(200, [
          {
            id: 701,
            name: 'test-attachment.txt',
            size: 24,
            url: `http://127.0.0.1:${serverPort}/media/test-attachment.txt`,
            created_date: '2026-08-01T00:00:00Z',
            description: 'Test attachment description',
          },
        ]);
        return;
      }
      if (req.method === 'POST') {
        sendJson(201, {
          id: 701,
          name: 'uploaded-file.txt',
          size: 24,
          url: `http://127.0.0.1:${serverPort}/media/uploaded-file.txt`,
          created_date: '2026-08-01T00:00:00Z',
          description: 'Uploaded attachment',
        });
        return;
      }
    }
  }

  // Default fallback 404
  sendJson(404, { _error_message: `Mock endpoint not found: ${req.method ?? 'GET'} ${pathname}` });
});

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    // SAFETY: TCP server.address() returns AddressInfo with port when listening
    const info = addr as AddressInfo | null;
    if (info && 'port' in info) {
      serverPort = info.port;
    }
    resolve();
  });
});

const apiUrl = `http://127.0.0.1:${serverPort}/api/v1`;
process.env['TAIGA_API_URL'] = apiUrl;
process.env['TAIGA_USERNAME'] = 'tester';
process.env['TAIGA_PASSWORD'] = 'password';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const client = new Client({ name: 'contract-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    TAIGA_API_URL: apiUrl,
    TAIGA_USERNAME: 'tester',
    TAIGA_PASSWORD: 'password',
  },
  stderr: 'pipe',
});

await client.connect(transport);

let failed = 0;
const exercisedMatrix = new Set<string>();

interface ToolCheckOptions {
  expectError?: boolean;
}

async function runToolCheck(
  name: string,
  args: JsonBody,
  { expectError = false }: ToolCheckOptions = {},
): Promise<CallToolResult> {
  try {
    const result = await client.request(
      { method: 'tools/call', params: { name, arguments: args } },
      CallToolResultSchema,
    );

    if (expectError) {
      assert.equal(result.isError, true, `${name} (${JSON.stringify(args)}) was expected to fail with isError: true`);
    } else {
      assert.notEqual(result.isError, true, `${name} (${JSON.stringify(args)}) failed unexpectedly: ${resultText(result)}`);
      assert.equal(result.structuredContent, undefined, `${name} must not return structuredContent`);
      if (args['op']) {
        exercisedMatrix.add(`${name}:${String(args['op'])}`);
      }
    }
    console.error(`  ok   ${name}${args['op'] ? `:${String(args['op'])}` : ''}`);
    return result;
  } catch (error) {
    failed += 1;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${name}${args['op'] ? `:${String(args['op'])}` : ''}\n       ${msg}`);
    throw error;
  }
}

async function runContractAssertion(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.error(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${name}\n       ${msg}`);
  }
}

// Temporary file for download testing
const tmpDownloadPath = path.join(os.tmpdir(), `taiga-download-test-${Date.now()}.txt`);

let listProjectsRes!: CallToolResult;
let listIssuesRes!: CallToolResult;
let listUserStoriesRes!: CallToolResult;
let listTasksRes!: CallToolResult;
let listEpicsRes!: CallToolResult;
let listWithLimitRes!: CallToolResult;
let listEmptyRes!: CallToolResult;
let listSprintsRes!: CallToolResult;
let getSprintRes!: CallToolResult;
let sprintStatsRes!: CallToolResult;
let listCommentsRes!: CallToolResult;
let listAttachmentsRes!: CallToolResult;
let listWikiRes!: CallToolResult;
let getLongDescRes!: CallToolResult;
let downloadNoSaveRes!: CallToolResult;
let downloadWithSaveRes!: CallToolResult;
let downloadForeignHostRes!: CallToolResult;
let downloadExistingFileRes!: CallToolResult;
let downloadFileProtocolRes!: CallToolResult;
let downloadDataProtocolRes!: CallToolResult;
let downloadRedirectRes!: CallToolResult;
let downloadOversizedRes!: CallToolResult;
let tmpExistingDir = '';
let existingFilePath = '';
let unknownOpRes!: CallToolResult;
let missingArgRes!: CallToolResult;
let unknownMemberRes!: CallToolResult;
let deleteIssueRes!: CallToolResult;
let deleteStoryRes!: CallToolResult;
let deleteTaskRes!: CallToolResult;
let deleteEpicRes!: CallToolResult;
let deleteByRefRes!: CallToolResult;
let deleteNoItemRes!: CallToolResult;
let deleteWithItemsRes!: CallToolResult;

try {
  // --- 1. PROJECTS TOOL ---
  await runToolCheck('projects', { op: 'whoami' });
  listProjectsRes = await runToolCheck('projects', { op: 'list' });
  await runToolCheck('projects', { op: 'get', project: 'project-1' });

  // --- 2. WORK TOOL ---
  // Work: issue
  listIssuesRes = await runToolCheck('work', {
    op: 'list',
    type: 'issue',
    project: 'project-1',
    status: 'In progress',
    assignee: 'tester',
    watcher: 'me',
    sprint: 'Sprint 1',
    priority: 'High',
    severity: 'Critical',
    issueType: 'Bug',
    tags: ['bug'],
    closed: false,
    q: 'Issue',
    orderBy: '-created_date',
  });
  listWithLimitRes = await runToolCheck('work', {
    op: 'list',
    type: 'issue',
    project: 'project-1',
    limit: 1,
  });
  listEmptyRes = await runToolCheck('work', {
    op: 'list',
    type: 'issue',
    project: 'project-1',
    q: 'empty',
  });
  await runToolCheck('work', {
    op: 'get',
    type: 'issue',
    item: '#1',
    project: 'project-1',
  });
  getLongDescRes = await runToolCheck('work', {
    op: 'get',
    type: 'issue',
    item: 102,
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'issue',
    project: 'project-1',
    subject: 'New Issue',
    status: 'In progress',
    priority: 'High',
    severity: 'Critical',
    issueType: 'Bug',
    assignee: 'tester',
    sprint: 'Sprint 1',
    tags: ['tag1'],
  });
  await runToolCheck('work', {
    op: 'update',
    type: 'issue',
    item: 101,
    subject: 'Updated Issue',
    status: 'In progress',
  });

  // Work: story
  listUserStoriesRes = await runToolCheck('work', {
    op: 'list',
    type: 'story',
    project: 'project-1',
    status: 'In progress',
    assignee: 'me',
    watcher: 'alex',
    sprint: '10',
    closed: false,
    parent: '401',
  });
  await runToolCheck('work', {
    op: 'get',
    type: 'story',
    item: '#2',
    project: 'project-1',
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'story',
    project: 'project-1',
    subject: 'New Story',
    status: 'In progress',
    sprint: 'Sprint 1',
    assignee: 'tester',
    tags: ['tag1'],
    points: 3,
  });
  await runToolCheck('work', {
    op: 'update',
    type: 'story',
    item: 201,
    subject: 'Updated Story',
    status: 'In progress',
    sprint: 'Sprint 1',
    points: 50,
  });
  await runToolCheck('work', {
    op: 'link',
    type: 'story',
    item: '201',
    parent: '401',
  });
  await runToolCheck('work', {
    op: 'unlink',
    type: 'story',
    item: '201',
    parent: '401',
  });

  // Work: task
  listTasksRes = await runToolCheck('work', {
    op: 'list',
    type: 'task',
    project: 'project-1',
    parent: '#2',
    sprint: 10,
    status: 'In progress',
    assignee: 'tester',
    watcher: 'me',
  });
  await runToolCheck('work', {
    op: 'get',
    type: 'task',
    item: 301,
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'task',
    project: 'project-1',
    parent: '#2',
    subject: 'New Task',
    status: 'In progress',
    assignee: 'tester',
    tags: ['tag1'],
  });
  await runToolCheck('work', {
    op: 'update',
    type: 'task',
    item: 301,
    subject: 'Updated Task',
    status: 'In progress',
  });

  // Work: epic
  listEpicsRes = await runToolCheck('work', {
    op: 'list',
    type: 'epic',
    project: 'project-1',
  });
  await runToolCheck('work', {
    op: 'get',
    type: 'epic',
    item: '#4',
    project: 'project-1',
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'epic',
    project: 'project-1',
    subject: 'New Epic',
    description: 'Epic desc',
    status: 'In progress',
    tags: ['epic1'],
    color: '#FF5733',
  });
  await runToolCheck('work', {
    op: 'update',
    type: 'epic',
    item: 401,
    subject: 'Updated Epic',
    status: 'In progress',
    color: '#00FF00',
  });

  // Work: batch create via items
  await runToolCheck('work', {
    op: 'create',
    type: 'issue',
    project: 'project-1',
    items: [
      {
        subject: 'Batch Issue 1',
        status: 'In progress',
        priority: 'High',
        severity: 'Critical',
        issueType: 'Bug',
        tags: ['b1'],
      },
    ],
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'story',
    project: 'project-1',
    items: [
      {
        subject: 'Batch Story 1',
        status: 'In progress',
        points: 50,
        tags: ['s1'],
      },
    ],
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'task',
    project: 'project-1',
    parent: '#2',
    items: [
      {
        subject: 'Batch Task 1',
        status: 'In progress',
        tags: ['t1'],
      },
    ],
  });
  await runToolCheck('work', {
    op: 'create',
    type: 'epic',
    project: 'project-1',
    items: [
      {
        subject: 'Batch Epic 1',
        status: 'In progress',
        color: '#112233',
      },
    ],
  });

  // Work: delete
  deleteIssueRes = await runToolCheck('work', {
    op: 'delete',
    type: 'issue',
    item: 101,
  });
  deleteStoryRes = await runToolCheck('work', {
    op: 'delete',
    type: 'story',
    item: 201,
  });
  deleteTaskRes = await runToolCheck('work', {
    op: 'delete',
    type: 'task',
    item: 301,
  });
  deleteEpicRes = await runToolCheck('work', {
    op: 'delete',
    type: 'epic',
    item: 401,
  });
  deleteByRefRes = await runToolCheck('work', {
    op: 'delete',
    type: 'issue',
    item: '#1',
    project: 'project-1',
  });

  // --- 3. SPRINTS TOOL ---
  listSprintsRes = await runToolCheck('sprints', { op: 'list', project: 'project-1' });
  getSprintRes = await runToolCheck('sprints', { op: 'get', project: 'project-1', sprint: 'Sprint 1' });
  await runToolCheck('sprints', {
    op: 'create',
    project: 'project-1',
    name: 'Sprint 2',
    start: '2026-09-01',
    finish: '2026-09-15',
  });
  sprintStatsRes = await runToolCheck('sprints', { op: 'stats', sprint: '10' });

  // --- 4. COMMENTS TOOL ---
  listCommentsRes = await runToolCheck('comments', { op: 'list', type: 'issue', item: '101' });
  await runToolCheck('comments', {
    op: 'add',
    type: 'issue',
    item: '101',
    text: 'Contract test comment',
  });
  await runToolCheck('comments', {
    op: 'edit',
    type: 'issue',
    item: '101',
    commentId: '11111111-1111-1111-1111-111111111111',
    text: 'Edited comment content',
  });
  await runToolCheck('comments', {
    op: 'delete',
    type: 'issue',
    item: '101',
    commentId: '11111111-1111-1111-1111-111111111111',
  });

  // --- 5. ATTACHMENTS TOOL ---
  listAttachmentsRes = await runToolCheck('attachments', { op: 'list', type: 'issue', item: '101' });
  await runToolCheck('attachments', {
    op: 'upload',
    type: 'issue',
    item: '101',
    fileName: 'test.txt',
    fileContent: Buffer.from('hello attachment').toString('base64'),
  });
  await runToolCheck('attachments', {
    op: 'upload',
    type: 'user_story',
    item: '201',
    fileName: 'story.txt',
    fileContent: Buffer.from('story attachment').toString('base64'),
  });
  downloadNoSaveRes = await runToolCheck('attachments', {
    op: 'download',
    type: 'issue',
    attachmentId: '701',
  });
  downloadWithSaveRes = await runToolCheck('attachments', {
    op: 'download',
    type: 'issue',
    attachmentId: '701',
    savePath: tmpDownloadPath,
  });
  tmpExistingDir = await mkdtemp(path.join(os.tmpdir(), 'taiga-att-existing-'));
  existingFilePath = path.join(tmpExistingDir, 'existing.txt');
  await writeFile(existingFilePath, 'original-unclobbered-content', 'utf8');

  downloadExistingFileRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '701',
      savePath: existingFilePath,
    },
    { expectError: true },
  );

  downloadForeignHostRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '702',
    },
    { expectError: true },
  );
  downloadFileProtocolRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '703',
    },
    { expectError: true },
  );
  downloadDataProtocolRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '704',
    },
    { expectError: true },
  );
  downloadRedirectRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '705',
    },
    { expectError: true },
  );
  downloadOversizedRes = await runToolCheck(
    'attachments',
    {
      op: 'download',
      type: 'issue',
      attachmentId: '706',
    },
    { expectError: true },
  );
  await runToolCheck('attachments', {
    op: 'delete',
    type: 'issue',
    attachmentId: '701',
  });

  // --- 6. WIKI TOOL ---
  listWikiRes = await runToolCheck('wiki', { op: 'list', project: 'project-1' });
  await runToolCheck('wiki', {
    op: 'create',
    project: 'project-1',
    page: 'contract-wiki',
    content: '# Contract Wiki Page',
  });
  await runToolCheck('wiki', {
    op: 'get',
    page: 'contract-wiki',
    project: 'project-1',
  });
  await runToolCheck('wiki', {
    op: 'update',
    page: 'contract-wiki',
    project: 'project-1',
    content: '# Updated Contract Wiki Page',
  });
  await runToolCheck('wiki', {
    op: 'watch',
    page: 'contract-wiki',
    project: 'project-1',
    watch: true,
  });
  await runToolCheck('wiki', {
    op: 'delete',
    page: 'contract-wiki',
    project: 'project-1',
  });

  // --- ERROR / GUARD TESTS ---
  unknownOpRes = await runToolCheck(
    'projects',
    { op: 'invalid_op' },
    { expectError: true },
  );
  missingArgRes = await runToolCheck(
    'projects',
    { op: 'get' },
    { expectError: true },
  );
  unknownMemberRes = await runToolCheck(
    'work',
    {
      op: 'list',
      type: 'issue',
      project: 'project-1',
      assignee: 'nonexistent_user',
    },
    { expectError: true },
  );
  await runToolCheck(
    'work',
    {
      op: 'create',
      type: 'issue',
      project: 'project-1',
      items: [
        {
          subject: 'FORCE_FAIL_BATCH',
          status: 'In progress',
        },
      ],
    },
    { expectError: true },
  );
  deleteNoItemRes = await runToolCheck(
    'work',
    {
      op: 'delete',
      type: 'issue',
    },
    { expectError: true },
  );
  deleteWithItemsRes = await runToolCheck(
    'work',
    {
      op: 'delete',
      type: 'issue',
      item: 101,
      items: [
        {
          subject: 'Batch delete attempt',
        },
      ],
    },
    { expectError: true },
  );
  // --- 3b. RATE LIMITING, CACHING, AND OCC UPDATE CHECKS ---
  const throttleRecoverRes = await runToolCheck('projects', { op: 'get', project: 'throttle-recover' });

  const giveupStart = Date.now();
  const throttleGiveupRes = await runToolCheck(
    'projects',
    { op: 'get', project: 'throttle-giveup' },
    { expectError: true },
  );
  const giveupElapsed = Date.now() - giveupStart;

  const serverErrorRes = await runToolCheck(
    'sprints',
    { op: 'create', project: 'project-1', name: 'server-error-500' },
    { expectError: true },
  );

  const cacheListRes1 = await runToolCheck('work', {
    op: 'list',
    type: 'story',
    project: 'cached-project',
    assignee: 'alex',
  });
  const cacheListRes2 = await runToolCheck('work', {
    op: 'list',
    type: 'story',
    project: 'cached-project',
    assignee: 'alex',
  });
  const cacheListRes3 = await runToolCheck('work', {
    op: 'list',
    type: 'story',
    project: 'cached-project-b',
    assignee: 'alex',
  });
  const cacheListRes4 = await runToolCheck('work', {
    op: 'list',
    type: 'story',
    project: 'cached-project-b',
    assignee: 'alex',
  });

  // --- 3c. STORY POINTS RESOLUTION & CACHING CHECKS ---
  const unestimatedStoryRes = await runToolCheck('work', {
    op: 'create',
    type: 'story',
    project: 'project-1',
    subject: 'Unestimated Story',
    points: '?',
  });

  const writeCountBeforeUnknown = requests.filter(
    (r) => r.method === 'POST' || r.method === 'PATCH' || r.method === 'PUT' || r.method === 'DELETE',
  ).length;

  const unknownPointsRes = await runToolCheck(
    'work',
    {
      op: 'create',
      type: 'story',
      project: 'project-1',
      subject: 'Unknown Points Story',
      points: 7,
    },
    { expectError: true },
  );

  const writeCountAfterUnknown = requests.filter(
    (r) => r.method === 'POST' || r.method === 'PATCH' || r.method === 'PUT' || r.method === 'DELETE',
  ).length;

  // --- 3d. WORK UPDATE PARENT REGRESSION CHECKS ---
  const taskReparentNumericRes = await runToolCheck('work', {
    op: 'update',
    type: 'task',
    item: 301,
    parent: 202,
    subject: 'Task Reparented Numeric',
  });

  const taskReparentByRefRes = await runToolCheck('work', {
    op: 'update',
    type: 'task',
    item: 301,
    parent: '#20',
    subject: 'Task Reparented By Ref',
  });

  const storyUpdateParentRes = await runToolCheck(
    'work',
    {
      op: 'update',
      type: 'story',
      item: 201,
      parent: 401,
    },
    { expectError: true },
  );

  const issueUpdateParentRes = await runToolCheck(
    'work',
    {
      op: 'update',
      type: 'issue',
      item: 101,
      parent: 201,
    },
    { expectError: true },
  );

  const epicUpdateParentRes = await runToolCheck(
    'work',
    {
      op: 'update',
      type: 'epic',
      item: 401,
      parent: 201,
    },
    { expectError: true },
  );

  const authCanaryPassword = 'pw-canary-do-not-leak';
  let leakPort = 0;
  const leakServer = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (parsedUrl.pathname === '/api/v1/auth' && req.method === 'POST') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ _error_message: 'Invalid credentials' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ _error_message: `Mock endpoint not found: ${req.method ?? 'GET'} ${parsedUrl.pathname}` }));
  });

  await new Promise<void>((resolve) => {
    leakServer.listen(0, '127.0.0.1', () => {
      const addr = leakServer.address();
      // SAFETY: TCP server.address() returns AddressInfo with port when listening
      const info = addr as AddressInfo | null;
      if (info && 'port' in info) {
        leakPort = info.port;
      }
      resolve();
    });
  });

  const leakApiUrl = `http://127.0.0.1:${leakPort}/api/v1`;
  const leakTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      TAIGA_API_URL: leakApiUrl,
      TAIGA_USERNAME: 'leak-tester',
      TAIGA_PASSWORD: authCanaryPassword,
    },
    stderr: 'pipe',
  });
  const leakClient = new Client({ name: 'contract-leak-test', version: '1.0.0' });
  let leakToolRes!: CallToolResult;
  let directAuthError: Error | undefined;

  try {
    await leakClient.connect(leakTransport);
    leakToolRes = await leakClient.request(
      { method: 'tools/call', params: { name: 'projects', arguments: { op: 'list' } } },
      CallToolResultSchema,
    );

    const prevApiUrl = process.env['TAIGA_API_URL'];
    process.env['TAIGA_API_URL'] = leakApiUrl;
    try {
      await login('leak-tester', authCanaryPassword);
    } catch (error) {
      if (error instanceof Error) {
        directAuthError = error;
      }
    } finally {
      process.env['TAIGA_API_URL'] = prevApiUrl;
    }
  } finally {
    try {
      await leakClient.close();
    } catch {
      // ignore
    }
    leakServer.close();
  }
  // --- 4. ASSERT ON RECORDED REQUESTS & MATRIX COVERAGE ---

  await runContractAssertion('every (tool, op) pair in allTools was exercised', () => {
    const expectedMatrix = new Set<string>();
    for (const tool of allTools) {
      const opSchema = tool.inputSchema['op'];
      if (opSchema instanceof z.ZodEnum) {
        for (const op of opSchema.options) {
          expectedMatrix.add(`${tool.name}:${String(op)}`);
        }
      }
    }
    assert.ok(expectedMatrix.size > 0, 'derived expected op matrix must not be empty');
    assert.deepEqual(
      [...exercisedMatrix].sort(),
      [...expectedMatrix].sort(),
      `Op matrix mismatch. Unexercised: ${[...expectedMatrix].filter((x) => !exercisedMatrix.has(x)).join(', ')}`,
    );
  });

  await runContractAssertion('create operations send numeric project and resolved taxonomy IDs without deprecated keys', () => {
    const issueCreates = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/issues' && r.body?.subject !== 'FORCE_FAIL_BATCH');
    assert.ok(issueCreates.length >= 2, 'expected create and batch create issue requests');
    for (const req of issueCreates) {
      assert.ok(req.body, 'create issue request must have body');
      assert.ok(Number.isInteger(req.body.project), `create issue project must be numeric, got ${req.body.project}`);
      assert.equal(req.body.projectId, undefined, 'create issue must not send projectId');
      if (req.body.status !== undefined) assert.ok(Number.isInteger(req.body.status), `create issue status must be numeric, got ${req.body.status}`);
      if (req.body.priority !== undefined) assert.ok(Number.isInteger(req.body.priority), `create issue priority must be numeric, got ${req.body.priority}`);
      if (req.body.severity !== undefined) assert.ok(Number.isInteger(req.body.severity), `create issue severity must be numeric, got ${req.body.severity}`);
      if (req.body.type !== undefined) assert.ok(Number.isInteger(req.body.type), `create issue type must be numeric, got ${req.body.type}`);
    }

    const storyCreates = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/userstories');
    assert.ok(storyCreates.length >= 2, 'expected create and batch create story requests');
    for (const req of storyCreates) {
      assert.ok(req.body, 'create story request must have body');
      assert.ok(Number.isInteger(req.body.project), `create story project must be numeric, got ${req.body.project}`);
      assert.equal(req.body.projectId, undefined, 'create story must not send projectId');
      if (req.body.status !== undefined) assert.ok(Number.isInteger(req.body.status), `create story status must be numeric, got ${req.body.status}`);
      if (req.body.milestone !== undefined) assert.ok(Number.isInteger(req.body.milestone), `create story milestone must be numeric, got ${req.body.milestone}`);
    }

    const taskCreates = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/tasks');
    assert.ok(taskCreates.length >= 2, 'expected create and batch create task requests');
    for (const req of taskCreates) {
      assert.ok(req.body, 'create task request must have body');
      assert.ok(Number.isInteger(req.body.project), `create task project must be numeric, got ${req.body.project}`);
      assert.ok(Number.isInteger(req.body.user_story), `create task user_story must be numeric, got ${req.body.user_story}`);
      assert.equal(req.body.userStoryId, undefined, 'create task must not send userStoryId');
      assert.equal(req.body.projectId, undefined, 'create task must not send projectId');
      if (req.body.status !== undefined) assert.ok(Number.isInteger(req.body.status), `create task status must be numeric, got ${req.body.status}`);
    }
  });

  await runContractAssertion('every PATCH includes an integer version field', () => {
    const patches = requests.filter((r) => r.method === 'PATCH');
    assert.ok(patches.length >= 5, `expected at least 5 PATCH requests, got ${patches.length}`);
    for (const req of patches) {
      assert.ok(req.body, `PATCH ${req.path} has no body`);
      assert.ok(Number.isInteger(req.body.version), `PATCH ${req.path} missing integer version: ${JSON.stringify(req.body)}`);
    }
  });

  await runContractAssertion('comment operations match Taiga history & PATCH conventions', () => {
    const commentPatch = requests.find((r) => r.method === 'PATCH' && r.path === '/api/v1/issues/101' && r.body?.comment === 'Contract test comment');
    assert.ok(commentPatch, 'add comment must be a PATCH of the item with comment');
    assert.ok(commentPatch.body, 'comment patch request must have body');
    assert.ok(Number.isInteger(commentPatch.body.version), `add comment PATCH must include integer version, got ${commentPatch.body.version}`);

    const editComment = requests.find((r) => r.method === 'POST' && r.path.includes('/edit_comment'));
    assert.ok(editComment, 'edit comment must POST to .../edit_comment');
    assert.equal(editComment.query['id'], '11111111-1111-1111-1111-111111111111');
    assert.equal(editComment.body?.comment, 'Edited comment content');

    const deleteComment = requests.find((r) => r.method === 'POST' && r.path.includes('/delete_comment'));
    assert.ok(deleteComment, 'delete comment must POST to .../delete_comment');
    assert.equal(deleteComment.query['id'], '11111111-1111-1111-1111-111111111111');

    const listComments = requests.find((r) => r.method === 'GET' && r.path.startsWith('/api/v1/history/issue/101'));
    assert.ok(listComments, 'list comments must GET /history/{type}/{id}');
    assert.equal(listComments.query['type'], 'comment', 'list comments must send ?type=comment');
  });

  await runContractAssertion('epic user story linking uses related_userstories endpoints and never PATCHes /userstories with epic', () => {
    const linkReq = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/epics/401/related_userstories');
    assert.ok(linkReq, 'link must POST to /epics/{id}/related_userstories');
    assert.deepEqual(linkReq.body, { epic: 401, user_story: 201 });

    const unlinkReq = requests.find((r) => r.method === 'DELETE' && r.path === '/api/v1/epics/401/related_userstories/201');
    assert.ok(unlinkReq, 'unlink must DELETE /epics/{id}/related_userstories/{userStoryId}');

    const badEpicPatch = requests.find((r) => r.method === 'PATCH' && r.path.startsWith('/api/v1/userstories') && r.body?.epic !== undefined);
    assert.equal(badEpicPatch, undefined, 'no tool should ever PATCH /userstories with an epic field');
  });

  await runContractAssertion('attachment operations hit per-type prefixes and never /issues/attachments for a user story', () => {
    const issueAttList = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/issues/attachments');
    assert.ok(issueAttList, 'issue list attachments must hit /api/v1/issues/attachments');

    const storyAttUpload = requests.find((r) => r.method === 'POST' && r.path === '/api/v1/userstories/attachments');
    assert.ok(storyAttUpload, 'user story upload attachment must hit /api/v1/userstories/attachments');
  });

  await runContractAssertion('every API request carries x-disable-pagination, authorization: Bearer, and POST /auth is called once', () => {
    const authPosts = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/auth');
    assert.equal(authPosts.length, 1, `POST /auth should be issued exactly ONCE (token caching), got ${authPosts.length}`);

    const apiRequests = requests.filter((r) => r.path.startsWith('/api/v1') && r.path !== '/api/v1/auth');
    assert.ok(apiRequests.length > 20, 'expected many API requests');
    for (const req of apiRequests) {
      assert.equal(req.headers['x-disable-pagination'], 'true', `${req.method ?? 'GET'} ${req.path} missing x-disable-pagination header`);
      assert.equal(req.headers['authorization'], 'Bearer contract-test-token', `${req.method ?? 'GET'} ${req.path} missing or invalid Bearer auth header`);
    }
  });

  await runContractAssertion('work list with sprint NAME resolves it to numeric milestone parameter', () => {
    const listReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/issues' && r.query['tags'] === 'bug');
    assert.ok(listReq, 'recorded list issues request not found');
    assert.equal(listReq.query['milestone'], '10', `milestone name "Sprint 1" should resolve to numeric string "10", got "${listReq.query['milestone']}"`);
    assert.equal(listReq.query['status'], '12', `status name "In progress" should resolve to "12", got "${listReq.query['status']}"`);
    assert.equal(listReq.query['assigned_to'], '1', `assignee "tester" should resolve to "1", got "${listReq.query['assigned_to']}"`);
    assert.equal(listReq.query['order_by'], '-created_date');
    assert.equal(listReq.query['status__is_closed'], 'false');
  });

  await runContractAssertion('work list type:story with assignee sends assigned_users and NO assigned_to, and watcher sends watchers', () => {
    const storyReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/userstories' && r.query['epic'] === '401');
    assert.ok(storyReq, 'recorded list userstories request not found');
    assert.equal(storyReq.query['assigned_users'], '1', `assignee "me" should resolve to numeric string "1", got "${storyReq.query['assigned_users']}"`);
    assert.equal(storyReq.query['assigned_to'], undefined, 'list stories must NOT send assigned_to parameter');
    assert.equal(storyReq.query['watchers'], '2', `watcher "alex" should resolve to numeric string "2", got "${storyReq.query['watchers']}"`);
    assert.equal(storyReq.query['is_closed'], 'false');
  });

  await runContractAssertion('work list type:issue and type:task send assigned_to, and watcher sends watchers', () => {
    const issueReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/issues' && r.query['tags'] === 'bug');
    assert.ok(issueReq, 'recorded list issues request not found');
    assert.equal(issueReq.query['assigned_to'], '1', `assignee "tester" should resolve to numeric string "1", got "${issueReq.query['assigned_to']}"`);
    assert.equal(issueReq.query['watchers'], '1', `watcher "me" should resolve to numeric string "1", got "${issueReq.query['watchers']}"`);

    const taskReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/tasks' && r.query['milestone'] === '10');
    assert.ok(taskReq, 'recorded list tasks request not found');
    assert.equal(taskReq.query['assigned_to'], '1', `assignee "tester" should resolve to numeric string "1", got "${taskReq.query['assigned_to']}"`);
    assert.equal(taskReq.query['watchers'], '1', `watcher "me" should resolve to numeric string "1", got "${taskReq.query['watchers']}"`);
  });

  await runContractAssertion('assignee: "me" and watcher: "me" resolve via GET /users/me to numeric user ID', () => {
    const meReq = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/users/me');
    assert.ok(meReq, 'expected GET /users/me request to resolve "me"');
  });

  await runContractAssertion('rendered list text names every co-assignee on multi-assignee stories and never says "-" for matched rows', () => {
    const issueText = resultText(listIssuesRes);
    assert.ok(!issueText.includes('Unassigned'), 'rendered issue list must not contain "Unassigned"');
    assert.ok(issueText.includes('Tester User'), 'rendered issue list must display assignee name');

    const taskText = resultText(listTasksRes);
    assert.ok(!taskText.includes('Unassigned'), 'rendered task list must not contain "Unassigned"');
    assert.ok(taskText.includes('Tester User'), 'rendered task list must display assignee name');

    const storyText = resultText(listUserStoriesRes);
    assert.ok(!storyText.includes('Unassigned'), 'rendered story list must not contain "Unassigned"');
    assert.ok(storyText.includes('Tester User'), 'rendered multi-assignee story list must name first assignee (me)');
    assert.ok(storyText.includes('Alex Developer'), 'rendered multi-assignee story list must name second assignee (co-assignee)');
  });

  await runContractAssertion('list operations format header as "<what>: <n>" (or "N of M") starting with a letter, non-confusable with records', () => {
    const allListResponses: [string, CallToolResult][] = [
      ['projects list', listProjectsRes],
      ['work list (issues)', listIssuesRes],
      ['work list (stories)', listUserStoriesRes],
      ['work list (tasks)', listTasksRes],
      ['work list (epics)', listEpicsRes],
      ['work list (with limit)', listWithLimitRes],
      ['work list (empty)', listEmptyRes],
      ['sprints list', listSprintsRes],
      ['comments list', listCommentsRes],
      ['attachments list', listAttachmentsRes],
      ['wiki list', listWikiRes],
    ];

    // 1. Every list result's first line matches list header contract
    for (const [label, res] of allListResponses) {
      assert.notEqual(res.isError, true, `${label} must succeed without isError`);
      const text = resultText(res);
      const firstLine = text.split('\n')[0] ?? '';
      assert.ok(
        isListHeader(firstLine),
        `${label} first line "${firstLine}" must match list header contract`,
      );
      // Ensure header NEVER matches the old record-like format
      assert.ok(
        !isDigitRecord(firstLine),
        `${label} header "${firstLine}" must never start with a number`,
      );
    }

    // 2. For a stubbed multi-record list (listIssuesRes has 3 issues), every line after the first parses as a record
    const issueLines = resultText(listIssuesRes).split('\n');
    assert.equal(issueLines.length, 4, `expected 1 header + 3 record lines, got ${issueLines.length}`);
    assert.ok(isListHeader(issueLines[0] ?? '') && issueLines[0]?.endsWith(': 3'), `expected header "issues in project-1: 3", got "${issueLines[0]}"`);
    for (let i = 1; i < issueLines.length; i++) {
      const line = issueLines[i] ?? '';
      assert.ok(
        isWorkRecord(line),
        `record line ${i} "${line}" must parse as a record with #ref and id=`,
      );
      assert.ok(
        !isListHeader(line),
        `record line ${i} "${line}" must not be mistaken for a header`,
      );
    }

    // 3. Limit smaller than the stub's row count renders N of M with true total, and row count equals N
    const limitText = resultText(listWithLimitRes);
    const limitLines = limitText.split('\n');
    assert.equal(limitLines.length, 2, `expected 1 header + 1 record line with limit 1, got ${limitLines.length}`);
    assert.ok(
      isListHeader(limitLines[0] ?? '') && limitLines[0]?.endsWith(': 1 of 3'),
      `expected "issues in project-1: 1 of 3", got "${limitLines[0]}"`,
    );
    assert.ok(
      isWorkRecord(limitLines[1] ?? ''),
      `limit record line "${limitLines[1]}" must parse as a record`,
    );

    // 4. An empty list renders exactly one line, ends in ": 0", and is NOT an error
    assert.notEqual(listEmptyRes.isError, true, 'empty list must not be an error');
    const emptyText = resultText(listEmptyRes);
    const emptyLines = emptyText.split('\n');
    assert.equal(emptyLines.length, 1, `empty list must render exactly 1 line, got ${emptyLines.length} ("${emptyText}")`);
    assert.ok(emptyLines[0]?.endsWith(': 0'), `empty list header must end in ": 0", got "${emptyLines[0]}"`);
    assert.ok(isListHeader(emptyLines[0] ?? ''), `empty list header "${emptyLines[0]}" must match list header contract`);
  });
  await runContractAssertion('sprints op:stats renders role-keyed and array points shapes without [object Object] or NaN', () => {
    assert.notEqual(sprintStatsRes.isError, true, 'sprints op:stats must succeed');
    const statsText = resultText(sprintStatsRes);
    assert.ok(!statsText.includes('[object Object]'), `stats text must not contain [object Object]: "${statsText}"`);
    assert.ok(!statsText.includes('NaN'), `stats text must not contain NaN: "${statsText}"`);
    assert.ok(statsText.includes('points: 40/90 (44%)'), `stats text must include formatted points: "${statsText}"`);
    assert.ok(statsText.includes('stories: 4/7 (57%)'), `stats text must include formatted stories: "${statsText}"`);
    assert.ok(statsText.includes('tasks: 28/57 (49%)'), `stats text must include formatted tasks: "${statsText}"`);

    const listText = resultText(listSprintsRes);
    assert.ok(!listText.includes('[object Object]'), `sprints list must not contain [object Object]: "${listText}"`);
    assert.ok(!listText.includes('NaN'), `sprints list must not contain NaN: "${listText}"`);
    assert.ok(listText.includes('40/90pts'), `sprints list must include formatted points: "${listText}"`);

    const getText = resultText(getSprintRes);
    assert.ok(!getText.includes('[object Object]'), `sprint get must not contain [object Object]: "${getText}"`);
    assert.ok(!getText.includes('NaN'), `sprint get must not contain NaN: "${getText}"`);
    assert.ok(getText.includes('points: 40/90'), `sprint get must include formatted points: "${getText}"`);
  });

  await runContractAssertion('new surface guards: unknown op, missing required arg, limit truncation, long desc truncation, download with/without savePath', async () => {
    // 1. Unknown op returns isError: true with message
    assert.equal(unknownOpRes.isError, true, 'unknown op should return isError: true');
    const unknownOpText = resultText(unknownOpRes);
    assert.ok(
      unknownOpText.includes('Invalid option') ||
      unknownOpText.includes('expected one of') ||
      unknownOpText.includes('invalid_op') ||
      unknownOpText.includes('Unknown op'),
      `expected error about unknown op: ${unknownOpText}`,
    );

    // 2. Missing required arg returns isError: true with message
    assert.equal(missingArgRes.isError, true, 'missing arg should return isError: true');
    const missingArgText = resultText(missingArgRes);
    assert.ok(missingArgText.includes('Project ID') || missingArgText.includes('required'), `expected error about required project arg: ${missingArgText}`);

    // 3. Unknown member lists available usernames
    assert.equal(unknownMemberRes.isError, true, 'unknown member should return isError: true');
    const unknownMemberText = resultText(unknownMemberRes);
    assert.ok(unknownMemberText.includes('Available usernames: tester, alex, jsmith'), `expected error listing available usernames: ${unknownMemberText}`);

    // 4. Limit truncates rendered rows
    const limitText = resultText(listWithLimitRes);
    const limitLines = limitText.split('\n').filter((l) => l.trim().startsWith('#'));
    assert.equal(limitLines.length, 1, `expected exactly 1 rendered item with limit: 1, got ${limitLines.length}`);

    // 5. Work get description > 2000 chars is truncated with marker
    const longDescText = resultText(getLongDescRes);
    assert.ok(longDescText.includes('…(truncated)'), 'description over 2000 chars must be truncated with …(truncated)');

    // 6. Attachments download without savePath returns useful text naming the file
    const noSaveText = resultText(downloadNoSaveRes);
    assert.ok(noSaveText.includes('test-attachment.txt'), 'download without savePath must name the file');
    assert.ok(noSaveText.includes('savePath'), 'download without savePath must note savePath is needed');

    // 7. Attachments download with savePath writes bytes to disk and reports path
    const withSaveText = resultText(downloadWithSaveRes);
    assert.ok(withSaveText.includes(tmpDownloadPath), 'download with savePath must report the destination path');
    const writtenData = await readFile(tmpDownloadPath, 'utf8');
    assert.equal(writtenData, 'attachment-file-content', 'downloaded file content must match mock payload');

    // 8. Attachments download refuses foreign hostname and records no foreign request
    assert.equal(downloadForeignHostRes.isError, true, 'download from foreign host must fail with isError: true');
    const foreignHostText = resultText(downloadForeignHostRes);
    assert.ok(foreignHostText.includes('foreign.example.com'), 'error must name the foreign hostname');
    assert.ok(foreignHostText.includes('127.0.0.1'), 'error must name the Taiga host');
    const foreignRequestRecorded = requests.some(
      (r) => r.path.includes('foreign-attachment') || (r.headers.host !== undefined && r.headers.host.includes('foreign.example.com')),
    );
    assert.equal(foreignRequestRecorded, false, 'stub must record no request to foreign media host');

    // 9. Attachments download refuses to overwrite existing file
    assert.equal(downloadExistingFileRes.isError, true, 'download to existing file must fail with isError: true');
    const existingFileText = resultText(downloadExistingFileRes);
    assert.ok(
      existingFileText.includes('already exists') || existingFileText.includes('Refusing to overwrite'),
      'error must explain that file already exists',
    );
    const existingContentAfter = await readFile(existingFilePath, 'utf8');
    assert.equal(
      existingContentAfter,
      'original-unclobbered-content',
      'existing file content must not be modified',
    );

    // 10. Attachments download protocol allow-list: file: URL rejected before hostname check
    assert.equal(downloadFileProtocolRes.isError, true, 'download with file: protocol must fail with isError: true');
    const fileProtoText = resultText(downloadFileProtocolRes);
    assert.ok(fileProtoText.includes('unsupported protocol "file:"'), 'error must name unsupported protocol file:');
    assert.ok(fileProtoText.includes('must be http: or https:'), 'error must state required http: or https: protocols');
    const fileReqRecorded = requests.some(
      (r) => r.path.includes('passwd') || r.path.includes('/etc/'),
    );
    assert.equal(fileReqRecorded, false, 'stub must record no request to file URL after metadata fetch');

    // 11. Attachments download protocol allow-list: data: URL rejected
    assert.equal(downloadDataProtocolRes.isError, true, 'download with data: protocol must fail with isError: true');
    const dataProtoText = resultText(downloadDataProtocolRes);
    assert.ok(dataProtoText.includes('unsupported protocol "data:"'), 'error must name unsupported protocol data:');
    assert.ok(dataProtoText.includes('must be http: or https:'), 'error must state required http: or https: protocols');
    const dataReqRecorded = requests.some(
      (r) => r.path.includes('data-attachment'),
    );
    assert.equal(dataReqRecorded, false, 'stub must record no request to data URL after metadata fetch');

    // 12. Attachments download transfer bounds: redirect refusal (maxRedirects: 0)
    assert.equal(downloadRedirectRes.isError, true, 'download following redirect must fail with isError: true due to maxRedirects: 0');
    const redirectSourceRequests = requests.filter((r) => r.path === '/media/redirect-source.txt');
    assert.equal(redirectSourceRequests.length, 1, 'stub must record exactly one request to redirect source');
    const redirectTargetRequests = requests.filter((r) => r.path === '/media/redirect-target.txt');
    assert.equal(redirectTargetRequests.length, 0, 'stub must record zero requests to redirect target');

    // 13. Attachments download transfer bounds: size cap exceeds MAX_ATTACHMENT_BYTES
    assert.equal(downloadOversizedRes.isError, true, 'download of oversized attachment must fail with isError: true');
  });

  await runContractAssertion('work op:delete permanently deletes single work item across all 4 types and records GET before DELETE', () => {
    const deleteChecks: Array<{
      type: string;
      path: string;
      res: CallToolResult;
      ref: string;
      subject: string;
      id: string;
    }> = [
      { type: 'issue', path: '/api/v1/issues/101', res: deleteIssueRes, ref: '#1', subject: 'Issue 1', id: '101' },
      { type: 'story', path: '/api/v1/userstories/201', res: deleteStoryRes, ref: '#2', subject: 'Story 1', id: '201' },
      { type: 'task', path: '/api/v1/tasks/301', res: deleteTaskRes, ref: '#3', subject: 'Task 1', id: '301' },
      { type: 'epic', path: '/api/v1/epics/401', res: deleteEpicRes, ref: '#4', subject: 'Epic 1', id: '401' },
    ];

    for (const { type, path: expectedPath, res, ref, subject, id } of deleteChecks) {
      assert.notEqual(res.isError, true, `work delete ${type} must succeed`);
      const text = resultText(res);
      assert.ok(text.includes(ref), `delete ${type} response must include ref ${ref}: "${text}"`);
      assert.ok(text.includes(subject), `delete ${type} response must include subject "${subject}": "${text}"`);
      assert.ok(text.includes(`id=${id}`), `delete ${type} response must include id=${id}: "${text}"`);
      assert.ok(text.includes('permanent'), `delete ${type} response must include "permanent": "${text}"`);

      // Verify recorded requests: method DELETE, exact per-type path, never #ref, preceded by GET
      const deleteIdx = requests.findIndex((r) => r.method === 'DELETE' && r.path === expectedPath);
      assert.ok(deleteIdx !== -1, `expected DELETE request to ${expectedPath}`);

      const getIdx = requests.findIndex((r, idx) => idx < deleteIdx && r.method === 'GET' && r.path === expectedPath);
      assert.ok(getIdx !== -1, `expected GET ${expectedPath} to precede DELETE ${expectedPath}`);
    }

    // Ensure no DELETE requests with #ref or mismatched collection paths exist
    const invalidDeletes = requests.filter(
      (r) => r.method === 'DELETE' && (r.path.includes('#') || r.path.includes('undefined')),
    );
    assert.equal(invalidDeletes.length, 0, 'no DELETE request may include #ref or undefined');
  });

  await runContractAssertion('work op:delete resolves #ref to numeric ID and guards against missing item or batch items', () => {
    // 1. #ref resolution
    assert.notEqual(deleteByRefRes.isError, true, 'work delete by #ref must succeed');
    const byRefText = resultText(deleteByRefRes);
    assert.ok(byRefText.includes('#1'), `delete by #ref response must include ref #1: "${byRefText}"`);
    assert.ok(byRefText.includes('Issue 1'), `delete by #ref response must include subject: "${byRefText}"`);
    assert.ok(byRefText.includes('id=101'), `delete by #ref response must include id=101: "${byRefText}"`);
    assert.ok(byRefText.includes('permanent'), `delete by #ref response must include "permanent": "${byRefText}"`);

    const byRefGet = requests.find((r) => r.method === 'GET' && r.path === '/api/v1/issues/by_ref');
    assert.ok(byRefGet, 'delete by #ref must query /api/v1/issues/by_ref');
    assert.equal(byRefGet.query['project'], '1', 'by_ref query must include resolved project ID');
    assert.equal(byRefGet.query['ref'], '1', 'by_ref query must include ref');

    // 2. Delete without item
    assert.equal(deleteNoItemRes.isError, true, 'delete without item must return isError: true');
    const noItemText = resultText(deleteNoItemRes);
    assert.ok(
      noItemText.includes('required') || noItemText.includes('Item numeric ID or #ref is required'),
      `delete without item must name required arg: "${noItemText}"`,
    );

    // 3. Delete with items (batch refusal)
    assert.equal(deleteWithItemsRes.isError, true, 'delete with items must return isError: true');
    const batchText = resultText(deleteWithItemsRes);
    assert.ok(
      batchText.includes('create-only') || batchText.includes('Batch is create-only'),
      `delete with items must mention batch is create-only: "${batchText}"`,
    );
  });
  // --- Dedicated Rate-Limiting & Caching & Update assertions ---
  await runContractAssertion('rate limit 429 with Retry-After: 0 retries and succeeds on second hit', () => {
    assert.notEqual(throttleRecoverRes.isError, true, 'throttle recover tool call must succeed');
    const recoverRequests = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/projects/by_slug' && r.query['slug'] === 'throttle-recover',
    );
    assert.equal(recoverRequests.length, 2, `stub must record request twice after 429 retry, got ${recoverRequests.length}`);
  });

  await runContractAssertion('rate limit 429 with Retry-After: 120 aborts promptly without sleeping and reports wait', () => {
    assert.equal(throttleGiveupRes.isError, true, 'tool must return isError: true when rate limit wait exceeds threshold');
    const text = resultText(throttleGiveupRes);
    assert.ok(text.includes('rate limited'), `error text must mention being rate limited: "${text}"`);
    assert.ok(text.includes('120s') || text.includes('120'), `error text must mention wait in seconds: "${text}"`);
    assert.ok(giveupElapsed < 2000, `rate limited call must return promptly under 2s (took ${giveupElapsed}ms)`);
    const giveupRequests = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/projects/by_slug' && r.query['slug'] === 'throttle-giveup',
    );
    assert.equal(giveupRequests.length, 1, `stub must record rate limited request exactly ONCE, got ${giveupRequests.length}`);
  });

  await runContractAssertion('server error 500 on POST is not retried and surfaces in-band error', () => {
    assert.equal(serverErrorRes.isError, true, '500 error must surface as in-band MCP error');
    const post500Requests = requests.filter(
      (r) => r.method === 'POST' && r.path === '/api/v1/milestones' && r.body?.name === 'server-error-500',
    );
    assert.equal(post500Requests.length, 1, `stub must record exactly ONE POST, proving 5xx is not retried, got ${post500Requests.length}`);
  });

  await runContractAssertion('caching: /users?project= and /projects/by_slug are requested ONCE across repeated calls while work items are requested TWICE, and cache is scoped per endpoint and slug', () => {
    assert.notEqual(cacheListRes1.isError, true, 'first cached list call for project A must succeed');
    assert.notEqual(cacheListRes2.isError, true, 'second cached list call for project A must succeed');
    assert.notEqual(cacheListRes3.isError, true, 'first cached list call for project B must succeed');
    assert.notEqual(cacheListRes4.isError, true, 'second cached list call for project B must succeed');
    const usersReqsA = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/users' && r.query['project'] === '98',
    );
    const usersReqsB = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/users' && r.query['project'] === '97',
    );
    const projectReqsA = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/projects/by_slug' && r.query['slug'] === 'cached-project',
    );
    const projectReqsB = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/projects/by_slug' && r.query['slug'] === 'cached-project-b',
    );
    const storyReqsA = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/userstories' && r.query['project'] === '98',
    );
    const storyReqsB = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/userstories' && r.query['project'] === '97',
    );
    assert.equal(usersReqsA.length, 1, `expected /users?project=98 to be requested ONCE across both calls, got ${usersReqsA.length}`);
    assert.equal(usersReqsB.length, 1, `expected /users?project=97 to be requested ONCE across both calls, got ${usersReqsB.length}`);
    assert.equal(projectReqsA.length, 1, `expected /projects/by_slug?slug=cached-project to be requested ONCE, got ${projectReqsA.length}`);
    assert.equal(projectReqsB.length, 1, `expected /projects/by_slug?slug=cached-project-b to be requested ONCE, got ${projectReqsB.length}`);
    assert.equal(storyReqsA.length, 2, `expected work-item list endpoint for project A to be requested TWICE, got ${storyReqsA.length}`);
    assert.equal(storyReqsB.length, 2, `expected work-item list endpoint for project B to be requested TWICE, got ${storyReqsB.length}`);
  });

  await runContractAssertion('auth 401 error does not leak plaintext password in tool response or serialized error chain', () => {
    assert.ok(leakToolRes, 'expected leakToolRes');
    assert.equal(leakToolRes.isError, true, 'tool call must fail with isError: true on 401 auth');
    const toolErrorText = resultText(leakToolRes);
    assert.equal(
      toolErrorText.includes(authCanaryPassword),
      false,
      `tool error text must not contain configured password: ${toolErrorText}`,
    );
    assert.equal(
      JSON.stringify(leakToolRes).includes(authCanaryPassword),
      false,
      'serialized MCP tool result must not contain configured password',
    );

    assert.ok(directAuthError, 'direct login() call with canary password must throw an Error');
    assert.equal(
      directAuthError.message.includes(authCanaryPassword),
      false,
      `direct error message must not contain password: ${directAuthError.message}`,
    );

    // Every field is flattened to a string so the whole chain, including Taiga's response body,
    // is searchable for the canary. `detail` is stringified rather than nested for that reason.
    interface ErrorFrame {
      name: string;
      message: string;
      status?: number;
      detail?: string;
      cause?: string;
    }
    const errorChain: ErrorFrame[] = [];
    let curr: Error | undefined = directAuthError;
    while (curr instanceof Error) {
      // SAFETY: every error thrown by src/api.ts is an ApiError, which is an Error carrying
      // optional `status` and `detail`; reading them off a plain Error yields undefined.
      const apiErr = curr as ApiError;
      errorChain.push({
        name: curr.name,
        message: curr.message,
        status: apiErr.status,
        detail: apiErr.detail === undefined ? undefined : JSON.stringify(apiErr.detail),
        cause: curr.cause === undefined ? undefined : String(curr.cause),
      });
      curr = curr.cause instanceof Error ? curr.cause : undefined;
    }
    const serializedChain = JSON.stringify(errorChain);
    assert.equal(
      serializedChain.includes(authCanaryPassword),
      false,
      `serialized error chain must not contain canary password: ${serializedChain}`,
    );
  });

  await runContractAssertion('work op:update issues exactly one GET of the item before PATCH and PATCH carries integer version', () => {
    const updatePatches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/issues/101' && r.body?.subject === 'Updated Issue',
    );
    assert.equal(updatePatches.length, 1, 'expected exactly one PATCH for Updated Issue');
    const patchReq = updatePatches[0];
    assert.ok(patchReq, 'expected patchReq');
    assert.ok(patchReq.body, 'expected patchReq.body');
    assert.ok(Number.isInteger(patchReq.body.version), `PATCH version must be numeric integer, got ${patchReq.body.version}`);

    const patchIdx = requests.indexOf(patchReq);
    const precedingGets = requests.slice(0, patchIdx).filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/issues/101',
    );
    assert.equal(precedingGets.length, 1, `expected exactly 1 preceding GET (from update resolveItem, no redundant GET in patchItem), got ${precedingGets.length}`);

    const allWorkPatches = requests.filter(
      (r) => r.method === 'PATCH' && (
        r.path === '/api/v1/issues/101' ||
        r.path === '/api/v1/userstories/201' ||
        r.path === '/api/v1/tasks/301' ||
        r.path === '/api/v1/epics/401'
      ),
    );
    assert.ok(allWorkPatches.length >= 4, 'expected at least 4 work update PATCH requests');
    for (const p of allWorkPatches) {
      assert.ok(p.body, 'work patch request must have body');
      assert.ok(Number.isInteger(p.body.version), `${p.path} PATCH must include numeric version, got ${p.body.version}`);
    }
  });

  await runContractAssertion('work op:update type:story with points: 50 sends role-keyed map and never scalar or total_points', () => {
    const updatePatches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/userstories/201' && r.body?.subject === 'Updated Story',
    );
    assert.equal(updatePatches.length, 1, 'expected exactly one PATCH for Updated Story');
    const patchReq = updatePatches[0];
    assert.ok(patchReq, 'expected patchReq');
    assert.ok(patchReq.body, 'expected patchReq.body');

    const pointsPayload = patchReq.body.points;
    assert.ok(pointsPayload !== undefined && pointsPayload !== null, 'PATCH body must contain points');
    assert.equal(Number.isFinite(pointsPayload), false, 'points must not be a number');
    assert.equal(Array.isArray(pointsPayload), false, 'points must not be an array');
    // SAFETY: points is verified to be non-primitive and non-array object
    const pointsMap = pointsPayload as Record<string, number>;
    const keys = Object.keys(pointsMap);
    assert.deepEqual(keys, ['133'], 'points must have single key equal to computable role ID "133"');
    assert.equal(pointsMap['133'], 312, 'points["133"] must equal point-row ID 312 for 50 points');
    assert.equal('total_points' in patchReq.body, false, 'PATCH body must NOT contain total_points');
  });

  await runContractAssertion('work op:create type:story with points: 3 and points: "?" sends role-keyed point-row IDs and never total_points', () => {
    const create3Req = requests.find(
      (r) => r.method === 'POST' && r.path === '/api/v1/userstories' && r.body?.subject === 'New Story',
    );
    assert.ok(create3Req, 'expected POST /api/v1/userstories for New Story');
    assert.ok(create3Req.body, 'expected create3Req.body');
    assert.equal(Number.isFinite(create3Req.body.points), false, 'points: 3 must not send scalar number');
    assert.equal(Array.isArray(create3Req.body.points), false, 'points must not be an array');
    // SAFETY: points is verified to be non-primitive and non-array object
    const create3Points = create3Req.body.points as Record<string, number>;
    assert.deepEqual(Object.keys(create3Points), ['133'], 'create points must have single key "133"');
    assert.equal(create3Points['133'], 222, 'points: 3 must resolve to point-row ID 222');
    assert.equal('total_points' in create3Req.body, false, 'create body must NOT contain total_points');

    assert.notEqual(unestimatedStoryRes.isError, true, 'create unestimated story must succeed');
    const unestimatedReq = requests.find(
      (r) => r.method === 'POST' && r.path === '/api/v1/userstories' && r.body?.subject === 'Unestimated Story',
    );
    assert.ok(unestimatedReq, 'expected POST /api/v1/userstories for Unestimated Story');
    assert.ok(unestimatedReq.body, 'expected unestimatedReq.body');
    assert.equal(Number.isFinite(unestimatedReq.body.points), false, 'points: "?" must not send scalar');
    // SAFETY: points is verified to be non-primitive and non-array object
    const unestimatedPoints = unestimatedReq.body.points as Record<string, number>;
    assert.deepEqual(Object.keys(unestimatedPoints), ['133'], 'unestimated points must have single key "133"');
    assert.equal(unestimatedPoints['133'], 217, 'points: "?" must resolve to point-row ID 217');
    assert.equal('total_points' in unestimatedReq.body, false, 'unestimated body must NOT contain total_points');
  });

  await runContractAssertion('work op:create type:story with unknown points returns isError: true listing available points and issues no write request', () => {
    assert.equal(unknownPointsRes.isError, true, 'unknown points value must return isError: true');
    const errorText = resultText(unknownPointsRes);
    assert.ok(errorText.includes('7'), `error text must name requested point value 7: "${errorText}"`);
    assert.ok(errorText.includes('?'), `error text must list available point name "?": "${errorText}"`);
    assert.ok(errorText.includes('1'), `error text must list available point name "1": "${errorText}"`);
    assert.ok(errorText.includes('3'), `error text must list available point name "3": "${errorText}"`);
    assert.ok(errorText.includes('50'), `error text must list available point name "50": "${errorText}"`);
    assert.equal(
      writeCountAfterUnknown,
      writeCountBeforeUnknown,
      `unknown points call must issue NO POST, PATCH, PUT, or DELETE requests (before: ${writeCountBeforeUnknown}, after: ${writeCountAfterUnknown})`,
    );
  });

  await runContractAssertion('points and roles metadata are requested exactly ONCE per project across repeated point-setting calls due to caching', () => {
    const pointsRequests = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/points' && r.query['project'] === '1',
    );
    const rolesRequests = requests.filter(
      (r) => r.method === 'GET' && r.path === '/api/v1/roles' && r.query['project'] === '1',
    );
    assert.equal(pointsRequests.length, 1, `expected /points?project=1 to be requested ONCE due to caching, got ${pointsRequests.length}`);
    assert.equal(rolesRequests.length, 1, `expected /roles?project=1 to be requested ONCE due to caching, got ${rolesRequests.length}`);
  });

  await runContractAssertion('work op:update type:task with numeric parent sets user_story in PATCH body and carries integer version without parent or userStoryId keys', () => {
    assert.notEqual(taskReparentNumericRes.isError, true, 'task reparent with numeric parent must succeed');
    const reparentPatch = requests.find(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/tasks/301' && r.body?.subject === 'Task Reparented Numeric',
    );
    assert.ok(reparentPatch, 'expected PATCH /api/v1/tasks/301 for Task Reparented Numeric');
    assert.ok(reparentPatch.body, 'expected reparentPatch.body');
    assert.equal(reparentPatch.body.user_story, 202, 'PATCH body must contain user_story equal to resolved numeric story ID 202');
    assert.ok(Number.isInteger(reparentPatch.body.user_story), 'user_story must be an integer');
    assert.ok(Number.isInteger(reparentPatch.body.version), `PATCH version must be numeric integer, got ${reparentPatch.body.version}`);
    assert.equal('parent' in reparentPatch.body, false, 'PATCH body must NOT contain parent key');
    assert.equal('userStoryId' in reparentPatch.body, false, 'PATCH body must NOT contain userStoryId key');
    assert.equal(reparentPatch.body.parent, undefined, 'PATCH body parent must be undefined');
    assert.equal(reparentPatch.body.userStoryId, undefined, 'PATCH body userStoryId must be undefined');
  });

  await runContractAssertion('work op:update type:task with #ref parent resolves via by_ref and sets numeric user_story in PATCH body', () => {
    assert.notEqual(taskReparentByRefRes.isError, true, 'task reparent with #ref parent must succeed');
    const byRefReq = requests.find(
      (r) => r.method === 'GET' && r.path === '/api/v1/userstories/by_ref' && r.query['ref'] === '20',
    );
    assert.ok(byRefReq, 'expected GET /api/v1/userstories/by_ref?ref=20 to resolve story #20');
    assert.equal(byRefReq.query['project'], '1', 'by_ref lookup must include project ID 1');

    const reparentPatch = requests.find(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/tasks/301' && r.body?.subject === 'Task Reparented By Ref',
    );
    assert.ok(reparentPatch, 'expected PATCH /api/v1/tasks/301 for Task Reparented By Ref');
    assert.ok(reparentPatch.body, 'expected reparentPatch.body');
    assert.equal(reparentPatch.body.user_story, 202, 'PATCH body must carry numeric database ID 202, not the ref string "#20"');
    assert.ok(Number.isInteger(reparentPatch.body.user_story), 'user_story must be numeric integer');
    assert.notEqual(reparentPatch.body.user_story, '#20', 'PATCH body must not carry raw reference string');
    assert.equal('parent' in reparentPatch.body, false, 'PATCH body must NOT contain parent key');
    assert.equal('userStoryId' in reparentPatch.body, false, 'PATCH body must NOT contain userStoryId key');
  });

  await runContractAssertion('work op:update type:story with parent returns error pointing to link and unlink ops and issues no PATCH request', () => {
    assert.equal(storyUpdateParentRes.isError, true, 'story update with parent must return isError: true');
    const text = resultText(storyUpdateParentRes);
    assert.ok(text.includes('link'), `error text must mention "link": "${text}"`);
    assert.ok(text.includes('unlink'), `error text must mention "unlink": "${text}"`);
    assert.ok(
      text.includes('A story\'s epic cannot be set with update. Use op "link" or "unlink" with parent set to the epic.'),
      `error text must give specific link/unlink guidance, got "${text}"`,
    );

    const storyPatches = requests.filter(
      (r) => r.method === 'PATCH' && r.path.startsWith('/api/v1/userstories'),
    );
    for (const p of storyPatches) {
      assert.notEqual(p.body?.epic, 401, 'no PATCH to /userstories should carry epic');
      assert.notEqual(p.body?.parent, 401, 'no PATCH to /userstories should carry parent');
    }
    const story201Patches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/userstories/201',
    );
    assert.equal(story201Patches.length, 1, 'expected exactly one PATCH for /userstories/201 (the valid update), none from rejected parent update');
  });

  await runContractAssertion('work op:update rejects parent for issue and epic with unsupported field error and issues no write request', () => {
    assert.equal(issueUpdateParentRes.isError, true, 'issue update with parent must return isError: true');
    const issueText = resultText(issueUpdateParentRes);
    assert.ok(issueText.includes('parent'), `error text must name unsupported field "parent": "${issueText}"`);
    assert.ok(issueText.includes('issue'), `error text must name type "issue": "${issueText}"`);
    assert.ok(
      issueText.includes('Field "parent" is not supported for issue.'),
      `error text must state field is not supported: "${issueText}"`,
    );
    const issue101Patches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/issues/101',
    );
    assert.equal(issue101Patches.length, 2, 'expected exactly two PATCHes for /issues/101 (valid update and comment), none from rejected parent update');

    assert.equal(epicUpdateParentRes.isError, true, 'epic update with parent must return isError: true');
    const epicText = resultText(epicUpdateParentRes);
    assert.ok(epicText.includes('parent'), `error text must name unsupported field "parent": "${epicText}"`);
    assert.ok(epicText.includes('epic'), `error text must name type "epic": "${epicText}"`);
    assert.ok(
      epicText.includes('Field "parent" is not supported for epic.'),
      `error text must state field is not supported: "${epicText}"`,
    );
    const epic401Patches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/epics/401',
    );
    assert.equal(epic401Patches.length, 1, 'expected exactly one PATCH for /epics/401 (valid update), none from rejected parent update');
  });

  await runContractAssertion('work-item PATCH requests including task reparent always carry integer version', () => {
    const reparentPatches = requests.filter(
      (r) => r.method === 'PATCH' && r.path === '/api/v1/tasks/301' && r.body?.user_story === 202,
    );
    assert.ok(reparentPatches.length >= 2, `expected at least 2 task reparent PATCH requests, got ${reparentPatches.length}`);
    for (const p of reparentPatches) {
      assert.ok(p.body, 'task reparent patch must have body');
      assert.ok(Number.isInteger(p.body.version), `task reparent PATCH must include integer version, got ${p.body.version}`);
      assert.equal(p.body.user_story, 202, `task reparent PATCH must set user_story to 202, got ${p.body.user_story}`);
    }
  });

} finally {
  try {
    await rm(tmpDownloadPath, { force: true });
    if (tmpExistingDir) {
      await rm(tmpExistingDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
  await client.close();
  server.close();
}

console.error(`\n${exercisedMatrix.size} (tool, op) pairs exercised`);
console.error(failed ? `${failed} contract checks FAILED` : 'all contract checks passed');
process.exit(failed ? 1 : 0);
