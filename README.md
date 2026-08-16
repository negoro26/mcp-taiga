# Taiga MCP Server

Model Context Protocol (MCP) server for Taiga project management, written in TypeScript and built on the Model Context Protocol SDK over stdio transport. It connects LLM clients to Taiga instances to inspect and manage projects, work items (issues, user stories, tasks, epics), sprints, comments, attachments, and wiki pages.

The server consolidates all capabilities into 6 op-dispatching tools designed for minimal token overhead and dense, human- and LLM-readable text responses.

## Requirements and Configuration

- Node.js >= 20.11
- A Taiga account on taiga.io or a self-hosted Taiga instance
- Three environment variables configured:

| Variable | Description | Default |
| --- | --- | --- |
| `TAIGA_API_URL` | Base URL of the Taiga REST API (must include `/api/v1`) | `https://api.taiga.io/api/v1` |
| `TAIGA_USERNAME` | Taiga username or email | *Required* |
| `TAIGA_PASSWORD` | Taiga account password | *Required* |

### MCP Client Configuration

Add the server to your MCP client configuration (such as `claude_desktop_config.json` or your harness configuration).

#### Using Local Checkout

When running from a local checkout, run `npm run build` first to compile the TypeScript source into `dist/`.

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/dist/src/index.js"],
      "env": {
        "TAIGA_API_URL": "https://api.taiga.io/api/v1",
        "TAIGA_USERNAME": "your_username",
        "TAIGA_PASSWORD": "your_password"
      }
    }
  }
}
```

#### Using npx

The package is not yet published to npm, so the npx configuration below is forward-looking:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "npx",
      "args": ["-y", "mcp-taiga"],
      "env": {
        "TAIGA_API_URL": "https://api.taiga.io/api/v1",
        "TAIGA_USERNAME": "your_username",
        "TAIGA_PASSWORD": "your_password"
      }
    }
  }
}
```

## Containers

The included two-stage `Dockerfile` uses Node 22 Alpine with a non-root `node` user. The build stage compiles the TypeScript source, and the runtime stage packages only the compiled `dist/src` output and production dependencies.

Build the container image:

```bash
docker build -t mcp-taiga .
```

Run the container attached to standard I/O:

```bash
docker run --rm -i --env-file .env mcp-taiga
```

Podman works by direct substitution: replace `docker` with `podman` in the commands above.

Point an MCP client configuration at the container runner:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--env-file", "/absolute/path/to/.env", "mcp-taiga"]
    }
  }
}
```

There is deliberately no compose file. An MCP stdio server must be spawned attached directly to its client's stdin and stdout streams, and exits when that stdin stream closes. Process supervisors or compose setups that attempt to keep long-running background services alive cause infinite restart loops and container name conflicts.

## Conventions

- **Projects**: Project arguments accept a numeric project ID (e.g. `19`) or a slug (e.g. `"acme-web"`).
- **Work Items**: Work items accept a numeric database ID (e.g. `1888`) or a reference prefixed with hash (e.g. `"#70"`). A `#reference` requires the `project` argument to resolve.
- **People**: Member arguments accept a numeric user ID, username (e.g. `"jdoe"`), full name (e.g. `"Jane Doe"`), or the literal `"me"`.
- **Taxonomies**: Statuses, priorities, severities, issue types, and sprint names accept human-readable names and are resolved to numeric IDs server-side.
- **Multi-Assignee User Stories**: Taiga user stories support multiple assignees via `assigned_users`. Filtering by `assignee` on `work list type:story` matches co-assignees, and listings display all assignees rather than only the primary.
- **Dense Text Results**: Results are plain text formatted with one dense line per record or clean key-value blocks for detail views. No consumer reads `structuredContent`, so results are text only. An empty collection is reported as `<items> in <project>: 0` rather than an error.
- **Full Collections**: List endpoints return complete collections because the client sends the `x-disable-pagination: true` request header, eliminating multi-page roundtrips.

## Why Six Tools

Single-purpose tool proliferation creates substantial context window overhead before any tool is invoked. Consolidating functionality into 6 op-dispatching domain tools keeps the `tools/list` payload to about 10,267 characters (~2,775 tokens).

Output schemas are deliberately absent from tool registrations: MCP client bridges concatenate text content and ignore `outputSchema` and `structuredContent`, so omitting output schemas eliminates unnecessary token overhead on session startup.

## Tool Reference

The server exposes 6 tools covering 28 operation pairs.

### 1. `projects`

List or inspect Taiga projects and verify credentials.

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List projects where authenticated user is a member | *(none)* | *(none)* |
| `get` | Inspect project metadata, owner, member count, active modules | `project` | *(none)* |
| `whoami` | Verify credentials and show current user info | *(none)* | *(none)* |

### 2. `work`

Manage issues, user stories, tasks, and epics (`type`: `issue`, `story`, `task`, `epic`).

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List work items with server-side filters | `type`, `project` | `assignee`, `watcher`, `sprint`, `status`, `tags`, `closed`, `q`, `orderBy`, `limit`, `parent` (tasks) |
| `get` | Get complete details and description for a work item | `type`, `item` | `project` (required if item is `#ref`) |
| `create` | Create a single work item or batch items | `type`, `project`, `subject` *(or `items` for batch; tasks require `parent`)* | `description`, `status`, `assignee`, `sprint`, `tags`, `priority` (issue), `severity` (issue), `issueType` (issue), `points` (story), `parent` (epic for story / default for batch), `items` (max 20) |
| `update` | Update fields on an existing work item | `type`, `item` | `project` (required if item is `#ref`), `subject`, `description`, `status`, `assignee`, `sprint`, `tags`, `priority`, `severity`, `issueType`, `points` |
| `link` | Link a user story to an epic | `type` (`story`), `item` (story), `parent` (epic) | `project` (required if item or parent is `#ref`) |
| `unlink` | Remove a user story from an epic | `type` (`story`), `item` (story), `parent` (epic) | `project` (required if item or parent is `#ref`) |
| `delete` | Permanently delete a single work item | `type`, `item` | `project` (required if item is `#ref`) |

### 3. `sprints`

Manage sprints (milestones) and inspect progress statistics.

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List sprints in a project | `project` | *(none)* |
| `get` | Get sprint details and assigned user stories | `sprint` | `project` (required if sprint is a name) |
| `create` | Create a new sprint milestone | `project`, `name` | `start` (YYYY-MM-DD), `finish` (YYYY-MM-DD) |
| `stats` | Get sprint progress statistics and completion metrics | `sprint` | `project` (required if sprint is a name) |

Sprint deletion is intentionally not exposed: removing a milestone detaches every story and task on it, making it a board-wide edit that belongs in the Taiga UI.

### 4. `comments`

List, add, edit, or delete comments on work items and wiki pages (`type`: `issue`, `story`, `task`, `epic`, `wiki`).

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List comments oldest first | `type`, `item` | `project` (required for `#ref` or wiki slug), `includeDeleted` |
| `add` | Add a comment to an item | `type`, `item`, `text` | `project` (required for `#ref` or wiki slug) |
| `edit` | Edit an existing comment by UUID | `type`, `item`, `commentId`, `text` | `project` (required for `#ref` or wiki slug) |
| `delete` | Soft-delete a comment by UUID | `type`, `item`, `commentId` | `project` (required for `#ref` or wiki slug) |

### 5. `attachments`

Manage file attachments on work items and wiki pages (`type`: `issue`, `story`, `task`, `epic`, `wiki`).

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List attachments on an item | `type`, `item` | `project` (required for `#ref` or wiki slug) |
| `upload` | Upload a file from local path or base64 | `type`, `item`, `filePath` *or* `fileContent` | `project`, `fileName`, `mimeType`, `description` |
| `download` | Fetch attachment metadata; optionally writes file to disk | `type`, `attachmentId` | `savePath` (path to save downloaded file) |
| `delete` | Permanently delete an attachment | `type`, `attachmentId` | *(none)* |

### 6. `wiki`

Manage wiki pages and page subscriptions within a project.

| Op | What it does | Required args | Optional args |
| --- | --- | --- | --- |
| `list` | List all wiki pages in a project | `project` | *(none)* |
| `get` | Inspect wiki page metadata and Markdown content | `page` (ID or slug) | `project` (required if page is a slug) |
| `create` | Create a new wiki page | `project`, `page` (slug) | `content` |
| `update` | Update wiki page content | `page` (ID or slug), `content` | `project` (required if page is a slug) |
| `delete` | Permanently delete a wiki page | `page` (ID or slug) | `project` (required if page is a slug) |
| `watch` | Watch or unwatch a wiki page | `page` (ID or slug) | `project` (required if page is a slug), `watch` (boolean, default true) |

## Reliability and Safety

- **Rate Limiting (429)**: The server retries HTTP 429 responses at most twice, honoring the server `Retry-After` header. If the required wait exceeds the 5-second ceiling (`MAX_THROTTLE_WAIT_MS`), it throws immediately with a retry message instead of sleeping.
- **5xx Errors Never Retried**: 5xx responses are never retried automatically because mutating requests (such as POST) may have already been applied on the server; repeating them risks creating duplicate records.
- **Metadata Cache**: Project metadata (slug lookups, user memberships, and taxonomy lists for statuses, priorities, severities, and issue types) is cached for 60 seconds (`METADATA_TTL_MS`) via `getMetadata`. Work items, comments, and attachments are never cached.
- **Timeouts**: HTTP requests enforce a 30-second timeout (`REQUEST_TIMEOUT_MS`).
- **HTTPS Enforcement**: The server emits a warning to stderr if `TAIGA_API_URL` uses unencrypted HTTP to a non-loopback host.
- **Restricted Attachment Downloads**: Attachment downloads are restricted strictly to the configured Taiga hostname with no redirects allowed (`maxRedirects: 0`), bounded to a maximum file size of 10 MB (`MAX_ATTACHMENT_BYTES`). The download request does not send the Taiga bearer token to media hosts.
- **File Overwrite Protection**: Attachment download with `savePath` refuses to overwrite an existing local file.
- **Single-Target Deletions**: Deletion operations accept exactly one target at a time. Batch operations are create-only (up to 20 items), preventing accidental board-wide deletions.

## Development

### File Layout

```text
src/index.ts            # Server entrypoint, stdio transport, resource registration, tool registry
src/api.ts              # Authenticated axios transport, generic HTTP helpers (get, post, patch, del), token management, retry policy, metadata cache
src/taiga.ts            # Domain helpers: resolution (projects, items, members, taxonomies, sprints) and optimistic concurrency patch
src/types.ts            # Taiga payload interfaces, tool definitions, and type contracts
src/format.ts           # Dense pipe-separated single-line renderers and detail views
src/utils.ts            # MCP response builders (createSuccessResponse, createErrorResponse, guard) and formatting helpers
src/constants.ts        # Endpoints, limits (batch size, attachment size), status labels, error messages
src/tools/index.ts      # Tool registry aggregating all tools and registering with McpServer
src/tools/projects.ts   # projects tool (list, get, whoami)
src/tools/work.ts       # work tool (list, get, create, update, link, unlink, delete across issues, stories, tasks, epics)
src/tools/sprints.ts    # sprints tool (list, get, create, stats)
src/tools/comments.ts   # comments tool (list, add, edit, delete)
src/tools/attachments.ts # attachments tool (list, upload, download, delete)
src/tools/wiki.ts       # wiki tool (list, get, create, update, delete, watch)
test/unitTest.ts        # Offline unit tests for pure helpers, formatting functions, response builders, and tool invariants
test/protocolTest.ts    # Protocol tests verifying MCP stdio handshake, server capabilities, tool count, and tools/list budget
test/apiContractTest.ts # Contract tests driving every tool op against an in-process mock Taiga HTTP server, asserting outgoing HTTP requests
test/integration.ts     # Live integration smoke test against a real Taiga instance (read-only, skips without credentials)
```

### NPM Scripts

- `npm run build`: Compiles TypeScript from `src/` and `test/` into `dist/` via `tsc`.
- `npm run check`: Type-checks TypeScript code without emitting output (`tsc --noEmit`).
- `npm run lint`: Runs oxlint across `src/` and `test/`.
- `npm start`: Runs the compiled server (`node dist/src/index.js`).
- `npm test`: Compiles and runs unit, protocol, and contract test suites in sequence.
- `npm run test:unit`: Compiles and runs offline unit tests.
- `npm run test:protocol`: Compiles and runs MCP protocol tests over stdio.
- `npm run test:contract`: Compiles and runs API contract tests against the mock Taiga server.
- `npm run test:integration`: Compiles and runs live integration tests against a live instance.
- `npm run prepublishOnly`: Runs type check, linting, and full test suite before publishing.

### Test Suites

1. **Unit Tests (`test/unitTest.ts`)**: Offline unit tests asserting pure formatting functions, response builders, identifier resolution helpers, and tool-definition invariants without network calls or credentials.
2. **Protocol Tests (`test/protocolTest.ts`)**: Protocol tests asserting the real MCP stdio handshake, server version and capabilities, tool schemas, and the `tools/list` character budget against a spawned server process.
3. **Contract Tests (`test/apiContractTest.ts`)**: Contract tests asserting that every tool and op sends the expected outgoing HTTP requests (method, endpoint, query parameters, headers, and payload) and processes responses against an in-process mock Taiga HTTP server.
4. **Integration Tests (`test/integration.ts`)**: Live integration smoke tests asserting read-only tool operations against a real Taiga instance over stdio (skipped when credentials are not configured).
