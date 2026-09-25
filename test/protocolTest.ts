#!/usr/bin/env node

import assert from 'node:assert/strict';
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/client";
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { isNumericId } from '../src/taiga.js';

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const client = new Client(
  { name: 'protocol-test', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });

let failed = 0;
const check = (name: string, fn: () => void): void => {
  try {
    fn();
    console.error(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL ${name}\n       ${message}`);
  }
};

await client.connect(transport);
check('server negotiates the 2026-07-28 protocol era', () => {
  assert.equal(client.getProtocolEra(), 'modern');
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
});

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
const manifest: { name: string; version: string } = JSON.parse(await readFile(manifestPath, 'utf8'));

const version = client.getServerVersion();
check('server advertises the same name and version as package.json', () => {
  assert.ok(version, 'no server version returned');
  assert.equal(version.name, manifest.name, 'handshake name must match package.json name');
  assert.equal(version.version, manifest.version, 'handshake version must match package.json version');
  const parts = version.version.split('.');
  assert.equal(parts.length, 3, `version must have 3 parts, got ${version.version}`);
  for (const part of parts) {
    assert.ok(isNumericId(part), `version part "${part}" must be numeric digits`);
  }
});

check('server declares tool and resource capabilities', () => {
  const capabilities = client.getServerCapabilities();
  assert.ok(capabilities?.tools, 'no tools capability');
  assert.ok(capabilities?.resources, 'no resources capability');
});

const { tools } = await client.listTools();
check('tools/list returns exactly 6 tools', () => {
  assert.equal(tools.length, 6, `expected exactly 6 tools, got ${tools.length}`);
});

check('every tool exposes a JSON Schema with required op and all properties described', () => {
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} has no description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} input schema is not an object`);
    assert.ok(tool.title || tool.annotations?.title, `${tool.name} has no title`);
    assert.ok(tool.inputSchema.required?.includes('op'), `${tool.name} must require 'op'`);
    const properties = tool.inputSchema.properties as Record<string, { description?: string; enum?: string[] }> | undefined;
    const opProp = properties?.op;
    assert.ok(opProp, `${tool.name} missing 'op' property`);
    assert.ok(Array.isArray(opProp.enum) && opProp.enum.length > 0, `${tool.name} 'op' enum must be non-empty`);
    for (const [field, schema] of Object.entries(properties ?? {})) {
      assert.ok(schema.description, `${tool.name}.${field} lost its description in JSON Schema conversion`);
    }
  }
});

check('no tool declares an output schema', () => {
  for (const tool of tools) {
    assert.equal((tool as { outputSchema?: string }).outputSchema, undefined, `${tool.name} must not declare outputSchema`);
  }
});

check('projects tool is annotated readOnlyHint, mutating tools are not', () => {
  const projects = tools.find((t) => t.name === 'projects');
  assert.ok(projects, 'projects tool not found');
  assert.equal(projects.annotations?.readOnlyHint, true, 'projects tool must have readOnlyHint: true');

  const others = tools.filter((t) => t.name !== 'projects');
  for (const tool of others) {
    assert.equal(tool.annotations?.readOnlyHint, false, `${tool.name} must have readOnlyHint: false`);
  }
});
check('mutating tools advertise idempotentHint: false', () => {
  for (const tool of tools.filter((candidate) => candidate.name !== 'projects')) {
    assert.equal(tool.annotations?.idempotentHint, false, `${tool.name} must have idempotentHint: false`);
  }
});

check('work tool advertises destructiveHint: true, projects does not', () => {
  const work = tools.find((t) => t.name === 'work');
  assert.ok(work, 'work tool not found');
  assert.equal(work.annotations?.destructiveHint, true, 'work tool must have destructiveHint: true');

  const projects = tools.find((t) => t.name === 'projects');
  assert.ok(projects, 'projects tool not found');
  assert.notEqual(projects.annotations?.destructiveHint, true, 'projects tool must not have destructiveHint: true');
});

check('tools/list payload serialisation budget is under 12000 characters', () => {
  const serialized = JSON.stringify(tools);
  assert.ok(serialized.length < 12000, `tools/list payload exceeded budget: ${serialized.length} chars (budget 12000)`);
});

const { resources } = await client.listResources();
check('projects resource is registered', () => {
  assert.deepEqual(resources.map((r) => r.uri), ['taiga://projects']);
});

const rejected = await client.callTool(
  {
    name: 'attachments',
    arguments: { op: 'upload', type: 'issue', item: '1' },
  }
);
check('a handler throw is reported in-band, not as a protocol error', () => {
  assert.equal(rejected.isError, true);
  const blocks = 'content' in rejected && Array.isArray(rejected.content) ? rejected.content : [];
  const [first] = blocks;
  const text = first?.type === 'text' ? first.text : '';
  assert.ok(
    text.includes('Exactly one of filePath or fileContent'),
    'expected filePath or fileContent error message',
  );
});

await client.close();
console.error(`\n${failed ? `${failed} protocol checks FAILED` : 'all protocol checks passed'}`);
process.exit(failed ? 1 : 0);
