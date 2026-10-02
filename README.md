# Taiga MCP server

[![CI](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml/badge.svg)](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-taiga)](https://www.npmjs.com/package/mcp-taiga)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-blue)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-black)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A TypeScript MCP server for Taiga. It gives LLM clients six tools for projects, work items, sprints, comments, attachments, and wiki pages.

New to the code? Start with [FEATURES.md](FEATURES.md), which maps every behaviour to the file and symbol that owns it.

The server uses MCP revision `2026-07-28` and native `fetch`, and speaks stdio only.

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
- Work items accept a numeric ID or a `#reference`, and those mean different things. A bare number is always an ID; `#42` is always a reference in the given project. There is no fallback between them.
- New user stories and tasks join the project's current open sprint unless you pass `sprint`. Pass `sprint: "none"` to create them unsprinted. Issues and epics are never placed automatically, and epics are only created or linked when you ask for one.
- Members accept an ID, username, full name, or `me`.
- Statuses, priorities, severities, issue types, and sprint names resolve to Taiga IDs.
- Batch work-item creation accepts at most 20 items.
- `attachments.download` returns metadata by default. Set `includeContent: true` to return bytes, or set `savePath` to write them locally.
- Listings return dense plain text. Empty lists are successful results. A work-item list returns at most 50 rows; its header reads `user stories in myproject: 50 of 312`, so the true total is always visible and a higher `limit` can be requested.

## Safety and reliability

- 401 responses trigger one token refresh and retry.
- 429 responses retry at most twice and honor `Retry-After`. Waits longer than five seconds fail with a retry message.
- 5xx responses are not retried because a write may already have succeeded.
- Project, user, and taxonomy metadata is cached for 60 seconds.
- Requests time out after 30 seconds.
- Attachment downloads reject redirects, cap reads at 10 MB, require the Taiga hostname, and do not send the bearer token to media hosts.
- File downloads refuse to overwrite an existing file.
- Deletes accept one target at a time. Batch creation does not imply batch deletion.
- Every write checks ownership first. `work.update`, `link`, and `unlink` require you to be the item's creator or its assignee; `work.delete`, `wiki.update`, `wiki.delete`, and `attachments.delete` require you to be the creator. `comments.edit` and `comments.delete` require you to be the comment's author. A record Taiga returns without an owner is refused rather than assumed.

## Docker

```bash
docker build -t mcp-taiga .
docker run --rm -i --env-file .env mcp-taiga
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
| `npm test` | Run unit, protocol, and contract tests |
| `npm run test:integration` | Run the live Taiga smoke test when credentials exist |

The test suite covers pure helpers, the MCP stdio handshake, and all tool operations against a mock Taiga server. Live Taiga reads are covered by the optional integration smoke test.

## Project layout

```text
src/index.ts             entrypoint: reads .env, registers the six tools, speaks stdio
src/api.ts               the only file that knows URLs and tokens; auth, retry, cache
src/taiga.ts             resolves names to ids and holds every rule about Taiga
src/format.ts            turns records into plain text responses
src/utils.ts             success and error response shapes
src/constants.ts         API paths, limits, and fixed messages
src/types.ts             TypeScript shapes for Taiga's JSON
src/tools/index.ts       the six tools, registered in order
src/tools/projects.ts    projects: list, get, whoami
src/tools/work.ts        work items: list, get, create, update, link, unlink, delete
src/tools/sprints.ts     sprints: list, get, stats, create
src/tools/comments.ts    comments: list, add, edit, delete
src/tools/attachments.ts attachments: list, upload, download, delete
src/tools/wiki.ts        wiki pages: list, get, create, update, delete, watch
test/unitTest.ts         pure helpers in isolation
test/protocolTest.ts     the MCP handshake over stdio
test/apiContractTest.ts  every tool op against an in-process fake Taiga
test/integration.ts      live Taiga reads, only when credentials are set
```

Comments are banned in source and enforced by the `anti-slop/no-comments` lint rule. Reasoning lives in [FEATURES.md](FEATURES.md) instead, which also maps each behaviour to the symbol that owns it. See [AGENTS.md](AGENTS.md) for the rules that apply to code changes.

## Contributing

Pull requests target `dev`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model and commit rules.

## License

[MIT](LICENSE)
