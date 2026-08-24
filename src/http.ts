/**
 * Streamable HTTP transport: serves the same MCP server at http://<host>:<port>/mcp
 * instead of stdio when TAIGA_HTTP_PORT is set.
 *
 * Stateless (sessionIdGenerator undefined). SDK 1.30 forbids reusing a stateless
 * transport across requests, so each request gets a fresh transport bound to a
 * fresh server instance from the shared factory; the HTTP server itself is the
 * single long-lived object.
 */

import http from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MCP_PATH = '/mcp';

/**
 * Start the HTTP server and resolve once it is listening.
 * @param port TCP port to bind
 * @param host bind host (TAIGA_HTTP_HOST or 127.0.0.1)
 * @param createServer shared factory building a fully registered server per request
 */
export async function startHttpServer(port: number, host: string, createServer: () => McpServer): Promise<Server> {
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLoopback) {
    console.error(`WARNING: TAIGA_HTTP_HOST "${host}" is not a loopback address. The endpoint is reachable by other hosts on the network without TLS.`);
  }

  const hostHeader = host.includes(':') ? `[${host}]` : host;
  const allowedHosts = [`${hostHeader}:${port}`];

  const handler: RequestListener = (req, res) => {
    let transport: StreamableHTTPServerTransport | undefined;
    let mcp: McpServer | undefined;
    void (async () => {
      try {
        if (new URL(req.url ?? '/', `http://${hostHeader}:${port}`).pathname !== MCP_PATH) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'POST' });
          res.end('Method not allowed');
          return;
        }

        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', resolve);
          req.on('error', reject);
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableDnsRebindingProtection: true,
          allowedHosts,
        });
        mcp = createServer();
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null,
          }));
        }
      } finally {
        // handleRequest only resolves after the response body is fully flushed,
        // so both are finished by now.
        await transport?.close().catch(() => {});
        await mcp?.close().catch(() => {});
      }
    })();
  };

  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  return server;
}