#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MAX_ATTACHMENT_BYTES } from '../src/constants.js';
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

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

const getFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const info = addr as AddressInfo | null;
      const free = info && 'port' in info ? info.port : 0;
      srv.close(() => resolve(free));
    });
  });

const port = await getFreePort();

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    TAIGA_HTTP_PORT: String(port),
    TAIGA_USERNAME: 'test',
    TAIGA_PASSWORD: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

const waitForPort = (timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = (): void => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', () => {
      socket.destroy();
      if (Date.now() - started > timeoutMs) reject(new Error('server did not start listening in time'));
      else setTimeout(tick, 50);
    });
  };
  tick();
});

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type HttpMethod = 'GET' | 'POST' | 'DELETE';

const request = (urlPath: string, payload: string | null, method: HttpMethod = 'POST'): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': String(Buffer.byteLength(payload)),
          }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

interface JsonRpcResult {
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  tools?: { name: string }[];
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: JsonRpcResult;
  error?: { code: number; message: string };
}

const extract = (body: string): JsonRpcResponse | undefined => {
  const match = body.match(/event: message\ndata: (.*?)(?:\n\n|$)/s);
  const raw = (match ? match[1] : body).trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as JsonRpcResponse;
};

let modernClient: Client | undefined;
try {
  await waitForPort(10_000);

  check('startup stderr line reports the HTTP endpoint', () => {
    assert.match(stderr, /mcp-taiga 1\.0\.0: 6 tools \(http:\/\/127\.0\.0\.1:\d+\/mcp\)/);
  });

  const init = await request('/mcp', JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '1.0.0' },
    },
  }));
  check('initialize responds 200', () => {
    assert.equal(init.status, 200, `expected 200, got ${init.status}: ${init.body.slice(0, 200)}`);
  });
  check('initialize echoes the protocol version and server info', () => {
    const msg = extract(init.body);
    assert.ok(msg, `no JSON-RPC payload in response: ${init.body.slice(0, 200)}`);
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.id, 1);
    assert.equal(msg.result?.protocolVersion, '2025-11-25');
    assert.deepEqual(msg.result?.serverInfo, { name: 'mcp-taiga', version: '1.0.0' });
  });
  check('stateless mode sets no Mcp-Session-Id header', () => {
    assert.equal(init.headers['mcp-session-id'], undefined);
  });

  const list = await request('/mcp', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  check('tools/list responds 200', () => {
    assert.equal(list.status, 200, `expected 200, got ${list.status}: ${list.body.slice(0, 200)}`);
  });
  check('tools/list returns exactly 6 tools with a valid JSON-RPC response', () => {
    const msg = extract(list.body);
    assert.ok(msg, `no JSON-RPC payload in response: ${list.body.slice(0, 200)}`);
    assert.equal(msg.jsonrpc, '2.0');
    assert.equal(msg.id, 2);
    assert.ok(Array.isArray(msg.result?.tools), 'result.tools missing');
    assert.equal(msg.result?.tools?.length, 6, `expected exactly 6 tools, got ${msg.result?.tools?.length}`);
    for (const tool of msg.result?.tools ?? []) {
      assert.ok(tool.name, `tool without name: ${JSON.stringify(tool)}`);
    }
  });

  const connectedClient = new Client(
    { name: 'http-modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  modernClient = connectedClient;
  const modernTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await connectedClient.connect(modernTransport);
  check('v2 client negotiates the 2026-07-28 protocol era', () => {
    assert.equal(connectedClient.getProtocolEra(), 'modern');
    assert.equal(connectedClient.getNegotiatedProtocolVersion(), '2026-07-28');
  });
  const modernTools = await connectedClient.listTools();
  check('modern client lists the same six tools', () => {
    assert.equal(modernTools.tools.length, 6);
  });
  const validationFailure = await connectedClient.callTool({
    name: 'projects',
    arguments: { op: 'not-an-op' },
  });
  check('modern client receives schema validation failures in-band', () => {
    assert.equal(validationFailure.isError, true);
  });
  const handlerFailure = await connectedClient.callTool({
    name: 'attachments',
    arguments: { op: 'upload', type: 'issue', item: '1' },
  });
  check('modern tools/call reaches the tool handler', () => {
    assert.equal(handlerFailure.isError, true);
    const [first] = handlerFailure.content;
    assert.ok(first?.type === 'text' && first.text.includes('Exactly one of filePath or fileContent'));
  });
  await connectedClient.close();
  modernClient = undefined;

  const underCapCall = await request('/mcp', JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'attachments',
      arguments: { op: 'upload', type: 'issue', item: '1', description: 'x'.repeat(5 * 1024 * 1024) },
    },
  }));
  check('tools/call under the HTTP body cap reaches the handler', () => {
    assert.equal(underCapCall.status, 200, `expected 200, got ${underCapCall.status}`);
    assert.match(underCapCall.body, /Exactly one of filePath or fileContent/);
  });

  const overCapCall = await request('/mcp', JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'attachments',
      arguments: { op: 'upload', type: 'issue', item: '1', description: 'x'.repeat(MAX_ATTACHMENT_BYTES * 2 + 1) },
    },
  }));
  check('tools/call over the HTTP body cap is rejected with 413', () => {
    assert.equal(overCapCall.status, 413, `expected 413, got ${overCapCall.status}`);
  });

  const malformed = await request('/mcp', '{ not json');
  check('malformed JSON body is rejected with 400', () => {
    assert.equal(malformed.status, 400, `expected 400, got ${malformed.status}: ${malformed.body.slice(0, 200)}`);
  });

  const unknown = await request('/nope', JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  check('unknown paths are rejected with 404', () => {
    assert.equal(unknown.status, 404, `expected 404, got ${unknown.status}`);
  });

  const get = await request('/mcp', null, 'GET');
  check('GET /mcp is rejected with 405', () => {
    assert.equal(get.status, 405, `expected 405, got ${get.status}: ${get.body.slice(0, 200)}`);
  });

  const del = await request('/mcp', null, 'DELETE');
  check('DELETE /mcp is rejected with 405', () => {
    assert.equal(del.status, 405, `expected 405, got ${del.status}`);
  });
} catch (error) {
  failed += 1;
  const message = error instanceof Error ? error.stack : String(error);
  console.error(`  FAIL http handshake\n       ${message}`);
  console.error(`  server stderr: ${stderr.trim() || '(empty)'}`);
} finally {
  await modernClient?.close().catch(() => {});
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.kill('SIGKILL');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
}

console.error(`\n${failed ? `${failed} http checks FAILED` : 'all http checks passed'}`);
process.exit(failed ? 1 : 0);