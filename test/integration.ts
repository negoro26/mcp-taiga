#!/usr/bin/env node
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNumericId } from '../src/taiga.js';

function isAsciiLetter(char: string | undefined): boolean {
  if (!char || char.length !== 1) return false;
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
}

function firstToken(str: string | null | undefined): string {
  const trimmed = String(str ?? '').trim();
  if (trimmed.length === 0) return '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      return trimmed.slice(0, i);
    }
  }
  return trimmed;
}

function isDigitRecord(line: string): boolean {
  const token = firstToken(line);
  return isNumericId(token);
}

function extractId(text: string | null | undefined): string | null {
  if (!text) return null;
  const idx = text.indexOf('id=');
  if (idx === -1) return null;
  const rest = text.slice(idx + 3);
  let end = 0;
  while (end < rest.length && rest[end] >= '0' && rest[end] <= '9') {
    end++;
  }
  if (end === 0) return null;
  const idStr = rest.slice(0, end);
  return isNumericId(idStr) ? idStr : null;
}

function extractRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const idx = text.indexOf('#');
  if (idx === -1) return null;
  const rest = text.slice(idx + 1);
  let end = 0;
  while (end < rest.length && rest[end] >= '0' && rest[end] <= '9') {
    end++;
  }
  if (end === 0) return null;
  const refStr = rest.slice(0, end);
  return isNumericId(refStr) ? refStr : null;
}

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

if (!process.env.TAIGA_USERNAME || !process.env.TAIGA_PASSWORD) {
  console.error('Skipping integration tests: TAIGA_USERNAME and TAIGA_PASSWORD are not set.');
  process.exit(0);
}

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const client = new Client({ name: 'integration-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  stderr: 'pipe',
});

interface ToolCallArgs {
  op?: string;
  type?: string;
  project?: string | number | null;
  item?: string | number | null;
  sprint?: string | number | null;
  assignee?: string;
  watcher?: string;
  [key: string]: string | number | boolean | null | undefined;
}

interface CallResult {
  text: string;
}

async function call(name: string, args: ToolCallArgs = {}): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const blocks = 'content' in res && Array.isArray(res.content) ? res.content : [];
  const text = blocks.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  if (res.isError) {
    console.error(`FAIL ${name}${args.op ? ` (${args.op})` : ''}: ${text}`);
    await client.close();
    process.exit(1);
  }

  console.error(`  ok   ${name}${args.op ? ` (${args.op})` : ''}`);
  return { text };
}

try {
  await client.connect(transport);

  await call('projects', { op: 'whoami' });

  const { text: projectsText } = await call('projects', { op: 'list' });
  const lines = projectsText.split('\n').map((l) => l.trim()).filter(Boolean);
  const headerLine = lines[0] || '';
  if (!headerLine || !isAsciiLetter(headerLine[0])) {
    console.error(`FAIL projects list header missing or does not start with a letter: "${headerLine}"`);
    await client.close();
    process.exit(1);
  }
  const projectLines = lines.slice(1).filter((l) => isDigitRecord(l));

  if (projectLines.length > 0) {
    const firstProject = projectLines[0];
    const pipeIdx = firstProject.indexOf('|');
    const projectPart = pipeIdx !== -1 ? firstProject.slice(0, pipeIdx).trim() : firstProject.trim();
    const tokens = projectPart.split(' ').map((t) => t.trim()).filter(Boolean);
    const projectId = tokens.length > 0 && isNumericId(tokens[0]) ? tokens[0] : null;
    const projectSlug = tokens.length > 1 ? tokens[1] : null;

    if (projectSlug) {
      await call('projects', { op: 'get', project: projectSlug });
    }
    if (projectId) {
      await call('projects', { op: 'get', project: projectId });
    }

    const { text: issuesText } = await call('work', { op: 'list', type: 'issue', project: projectId });
    const { text: storiesText } = await call('work', { op: 'list', type: 'story', project: projectId });
    await call('work', { op: 'list', type: 'task', project: projectId });
    const { text: sprintsText } = await call('sprints', { op: 'list', project: projectId });
    await call('work', { op: 'list', type: 'epic', project: projectId });
    await call('wiki', { op: 'list', project: projectId });

    const issueId = extractId(issuesText);
    if (issueId) {
      await call('work', { op: 'get', type: 'issue', item: issueId, project: projectId });
      await call('comments', { op: 'list', type: 'issue', item: issueId, project: projectId });
      await call('attachments', { op: 'list', type: 'issue', item: issueId, project: projectId });
    } else {
      console.error('  skip getIssue / issue comments: no issues found');
    }

    const storyId = extractId(storiesText);
    const storyRef = extractRef(storiesText);
    if (storyId) {
      await call('work', { op: 'get', type: 'story', item: storyId, project: projectId });
      if (storyRef) {
        await call('work', { op: 'get', type: 'story', item: `#${storyRef}`, project: projectId });
      }
      await call('comments', { op: 'list', type: 'story', item: storyId, project: projectId });
      await call('attachments', { op: 'list', type: 'story', item: storyId, project: projectId });
    } else {
      console.error('  skip getUserStory / story comments: no user stories found');
    }

    const sprintLines = sprintsText.split('\n').map((l) => l.trim()).filter((l) => isDigitRecord(l));
    if (sprintLines.length > 0) {
      const sprintId = firstToken(sprintLines[0]);
      if (isNumericId(sprintId)) {
        await call('sprints', { op: 'get', project: projectId, sprint: sprintId });
        await call('sprints', { op: 'stats', project: projectId, sprint: sprintId });
      }
    } else {
      console.error('  skip getMilestone: no sprints found');
    }

    const { text: myTasksText } = await call('work', {
      op: 'list',
      type: 'task',
      project: projectId,
      assignee: 'me',
    });
    if (myTasksText.includes('id=')) {
      if (myTasksText.includes('Unassigned')) {
        console.error('FAIL work list type:task assignee:me returned a row showing Unassigned');
        await client.close();
        process.exit(1);
      }
    } else {
      console.error('  skip myTasks text check: no tasks assigned to me');
    }

    const { text: myStoriesText } = await call('work', {
      op: 'list',
      type: 'story',
      project: projectId,
      assignee: 'me',
    });
    if (myStoriesText.includes('id=')) {
      if (myStoriesText.includes('Unassigned')) {
        console.error('FAIL work list type:story assignee:me returned a row showing Unassigned');
        await client.close();
        process.exit(1);
      }
    } else {
      console.error('  skip myStories text check: no user stories assigned to me');
    }

    await call('work', {
      op: 'list',
      type: 'story',
      project: projectId,
      watcher: 'me',
    });
  } else {
    console.error('  skip project checks: no projects found for user');
  }
  await client.close();
  console.error('\nall integration checks passed');
  process.exit(0);
} catch (error) {
  console.error(`FAIL unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  try {
    await client.close();
  } catch {
  }
  process.exit(1);
}
