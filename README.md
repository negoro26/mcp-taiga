# Taiga MCP server

[![CI](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml/badge.svg)](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-taiga)](https://www.npmjs.com/package/mcp-taiga)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-blue)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-black)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A TypeScript MCP server for Taiga. It gives LLM clients six tools for projects, work items, sprints, comments, attachments, and wiki pages.

The server uses MCP revision `2026-07-28`, native `fetch`, and either stdio or streamable HTTP.

## Requirements

- Node.js 24 or newer.
- A Taiga account on taiga.io or a self-hosted instance.
- `TAIGA_USERNAME` and `TAIGA_PASSWORD`.

Set `TAIGA_API_URL` for a self-hosted instance. Include `/api/v1` in the URL.

| Variable | Purpose | Default |
| --- | --- | --- |
| `TAIGA_API_URL` | Taiga REST API base URL | `https://api.taiga.io/api/v1` |
| `TAIGA_USERNAME` | Taiga username or email | Required |
| `TAIGA_PASSWORD` | Taiga password | Required |
| `TAIGA_HTTP_PORT` | Serve streamable HTTP when set | stdio |
| `TAIGA_HTTP_HOST` | HTTP bind address | `127.0.0.1` |

## Install

### Published package

Use the published package from an MCP client that accepts a stdio command:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "npx",
      "args": ["-y", "mcp-taiga"],
      "env": {
        "TAIGA_USERNAME": "your_username",
        "TAIGA_PASSWORD": "your_password"
      }
    }
  }
}
```

Pass credentials through the client environment. An npx install does not load a repository `.env` file.

### Local checkout

```bash
git clone https://github.com/negoro26/mcp-taiga.git
cd mcp-taiga
npm ci
npm run build
cp .env.example .env
```

Fill in `.env`, then configure the client to run:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-taiga/dist/src/index.js"],
      "cwd": "/absolute/path/to/mcp-taiga"
    }
  }
}
```

A local checkout loads `.env` with Node's built-in environment loader. Do not commit `.env`.

### Oh My Pi

Start OMP in the checkout and run:

```text
/mcp add
```

Choose a local stdio server, then use:

```text
command: node
args: /absolute/path/to/mcp-taiga/dist/src/index.js
cwd: /absolute/path/to/mcp-taiga
```

Run `/mcp test taiga` or `/mcp list` to verify the server. OMP configuration lives in `~/.omp/agent/mcp.json`.

## HTTP transport

Set `TAIGA_HTTP_PORT` to serve the same tools over streamable HTTP:

```bash
TAIGA_HTTP_PORT=3000 npx -y mcp-taiga
```

The endpoint is:

```text
http://127.0.0.1:3000/mcp
```

Configure URL-based clients with:

```json
{
  "mcpServers": {
    "taiga": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

The HTTP server is stateless, validates the Host and Origin headers, and defaults to loopback. A routable bind address prints a warning because the connection is not encrypted.

## Tools

The server exposes six tools and 28 operation pairs.

| Tool | Operations | Key arguments |
| --- | --- | --- |
| `projects` | `list`, `get`, `whoami` | `project` accepts an ID or slug |
| `work` | `list`, `get`, `create`, `update`, `link`, `unlink`, `delete` | `type`, `project`, `item`, `subject`, `items` |
| `sprints` | `list`, `get`, `create`, `stats` | `project`, `sprint`, `name`, `start`, `finish` |
| `comments` | `list`, `add`, `edit`, `delete` | `type`, `item`, `text`, `commentId` |
| `attachments` | `list`, `upload`, `download`, `delete` | `type`, `item`, `attachmentId`, `filePath` or `fileContent`, `savePath` |
| `wiki` | `list`, `get`, `create`, `update`, `delete`, `watch` | `project`, `page`, `content`, `watch` |

### Input conventions

- Projects accept a numeric ID or slug.
- Work items accept a numeric ID or a `#reference`. A reference also needs `project`.
- Members accept an ID, username, full name, or `me`.
- Statuses, priorities, severities, issue types, and sprint names resolve to Taiga IDs.
- Batch work-item creation accepts at most 20 items.
- `attachments.download` returns metadata by default. Set `includeContent: true` to return bytes, or set `savePath` to write them locally.
- Listings return dense plain text. Empty lists are successful results.

## Safety and reliability

- 401 responses trigger one token refresh and retry.
- 429 responses retry at most twice and honor `Retry-After`. Waits longer than five seconds fail with a retry message.
- 5xx responses are not retried because a write may already have succeeded.
- Project, user, and taxonomy metadata is cached for 60 seconds.
- Requests time out after 30 seconds.
- Attachment downloads reject redirects, cap reads at 10 MB, require the Taiga hostname, and do not send the bearer token to media hosts.
- File downloads refuse to overwrite an existing file.
- Deletes accept one target at a time. Batch creation does not imply batch deletion.

## Docker

```bash
docker build -t mcp-taiga .
docker run --rm -i --env-file .env mcp-taiga
```

For HTTP mode:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e TAIGA_HTTP_PORT=3000 \
  --env-file .env \
  mcp-taiga
```

The container uses Node.js 24 Alpine and runs as the non-root `node` user.

## Development

```bash
npm ci
npm run check
npm run lint
npm test
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile `src` and `test` into `dist` |
| `npm run check` | Type-check without output |
| `npm run lint` | Run the TypeScript anti-slop checks with oxlint |
| `npm test` | Run unit, protocol, contract, and HTTP tests |
| `npm run test:integration` | Run the live Taiga smoke test when credentials exist |

The test suite covers pure helpers, the MCP stdio handshake, all tool operations against a mock Taiga server, streamable HTTP, and live Taiga reads.

## Project layout

```text
src/index.ts             server entrypoint and transport selection
src/http.ts              streamable HTTP transport
src/api.ts               authenticated fetch transport and cache
src/taiga.ts             Taiga domain resolution and patching
src/tools/*.ts           six tool implementations
test/apiContractTest.ts  mock Taiga contract tests
test/protocolTest.ts     stdio MCP tests
test/httpTest.ts         HTTP MCP tests
test/integration.ts      live Taiga smoke test
```

## Contributing

Pull requests target `dev`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model and commit rules.

## License

[MIT](LICENSE)
