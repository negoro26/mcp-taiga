# Taiga MCP Server

[![CI](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml/badge.svg)](https://github.com/negoro26/mcp-taiga/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/mcp-taiga)](https://www.npmjs.com/package/mcp-taiga)
![Node.js](https://img.shields.io/badge/node-%E2%89%A520.11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![MCP](https://img.shields.io/badge/MCP-2025--11--25-black)

Model Context Protocol (MCP) server for Taiga project management, written in TypeScript and built on the Model Context Protocol SDK over stdio transport (with an optional streamable HTTP transport for remote and web-based clients). It connects LLM clients to Taiga instances to inspect and manage projects, work items (issues, user stories, tasks, epics), sprints, comments, attachments, and wiki pages.

The server consolidates all capabilities into 6 op-dispatching tools designed for minimal token overhead and dense, human- and LLM-readable text responses.

## Contents

| | |
| --- | --- |
| [Features](#features) · [Requirements](#requirements-and-configuration) · [Quick Start](#quick-start) · [Local checkout](#running-from-a-local-checkout) | **Install:** [Claude Code](#claude-code) · [Claude Desktop](#claude-desktop) · [VS Code / Copilot](#vs-code-and-github-copilot) · [Cursor](#cursor) · [Windsurf](#windsurf) · [Cline / Roo / Kilo](#cline-roo-code-and-kilo-code) · [Continue.dev](#continuedev) |
| [Zed](#zed) · [JetBrains](#jetbrains-ides) · [Gemini CLI](#gemini-cli) · [Codex CLI](#codex-cli) · [opencode](#opencode) · [Amp](#amp) | [HTTP transport & web clients](#remote-and-web-clients-http-transport) · [Docker](#containers) · [FAQ](#faq) · [Conventions](#conventions) |
| [Why six tools](#why-six-tools) · [Tool reference](#tool-reference): [`projects`](#1-projects) · [`work`](#2-work) · [`sprints`](#3-sprints) · [`comments`](#4-comments) · [`attachments`](#5-attachments) · [`wiki`](#6-wiki) | [Reliability](#reliability-and-safety) · [Security](#security-considerations) · [Troubleshooting](#troubleshooting) · [Development](#development) · [Contributing](#contributing) · [Changelog](#changelog) · [License](#license) |

## Features

- **Six tools, twenty-eight operation pairs** across projects, work items, sprints, comments, attachments, and wiki pages — the entire `tools/list` payload is ~10,493 characters (~2,800 tokens).
- **Human-friendly identifiers everywhere**: projects by ID or slug, work items by database ID or `#reference`, members by ID, username, full name, or `"me"`; statuses, priorities, severities, issue types, and sprint names resolve server-side.
- **Dense text output**: one line per record in listings, clean key-value detail views; empty collections are reported as data, not errors.
- **Batch creation** of up to 20 work items in a single call; deletions are deliberately single-target.
- **Reliability rails**: rate-limit retries honoring `Retry-After`, 30-second HTTP timeouts, a 60-second metadata cache, and no automatic 5xx retries (mutating requests may have landed).
- **Attachment safety**: hostname-pinned downloads, 10 MB cap, overwrite protection, and no bearer token sent to media hosts.
- **Dual transport**: stdio by default; streamable HTTP on loopback when `TAIGA_HTTP_PORT` is set.

## Requirements and Configuration

- Node.js >= 20.11
- A Taiga account on taiga.io or a self-hosted Taiga instance
- Three environment variables configured:

| Variable | Description | Default |
| --- | --- | --- |
| `TAIGA_API_URL` | Base URL of the Taiga REST API (must include `/api/v1`) | `https://api.taiga.io/api/v1` |
| `TAIGA_USERNAME` | Taiga username or email | *Required* |
| `TAIGA_PASSWORD` | Taiga account password | *Required* |

Optional transport variables:

| Variable | Description | Default |
| --- | --- | --- |
| `TAIGA_HTTP_PORT` | When set, serve MCP over streamable HTTP instead of stdio | *(unset: stdio)* |
| `TAIGA_HTTP_HOST` | Bind host for the HTTP transport | `127.0.0.1` |

## Quick Start

The fastest setup is Claude Desktop with npx (no checkout required):

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

All harness configurations below follow this shape; only the file location and wrapper syntax differ.

> **Credentials and `.env`:** a local checkout automatically loads `.env` from the repository root (see `.env.example`). An **npx install does not**: dotenv resolves relative to the package's install location inside the npm cache, so credentials passed via npx MUST be set in each harness's `env` block as shown above.

### Running From a Local Checkout

```bash
git clone https://github.com/negoro26/mcp-taiga.git
cd mcp-taiga && npm ci && npm run build
cp .env.example .env   # fill in TAIGA_USERNAME / TAIGA_PASSWORD
```

Then point any harness at the compiled entrypoint instead of npx:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-taiga/dist/src/index.js"]
    }
  }
}
```

No `env` block needed here — the server loads your repo-root `.env` itself. This repository also ships a ready-made [`.mcp.json`](.mcp.json) so coding agents opened inside the checkout can use the local build directly.

## Installation and Configuration

Per-harness setup using the published npm package. Each snippet passes credentials inline; substitute your own values.

### Claude Code

Project scope (checked into the repo, shared with your team):

```json
// .mcp.json at repository root
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

Or add from the CLI (user scope with `-s user`, local scope by default):

```bash
claude mcp add taiga \
  -e TAIGA_USERNAME=your_username \
  -e TAIGA_PASSWORD=your_password \
  -- npx -y mcp-taiga
```

Verify with `claude mcp list` or `/mcp` inside a session.

### Claude Desktop

Edit the config file — `claude_desktop_config.json` via **Claude Desktop → Settings → Developer → Edit Config**, located at `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS — and restart the desktop app:

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

On Windows, invoke npx through `cmd /c` if the direct form fails: `"command": "cmd", "args": ["/c", "npx", "-y", "mcp-taiga"]`.

### VS Code and GitHub Copilot

VS Code supports MCP servers natively (1.99+); Copilot Chat picks them up automatically.

```json
// .vscode/mcp.json (workspace) or use Command Palette: "MCP: Add Server"
{
  "servers": {
    "taiga": {
      "type": "stdio",
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

Start it from the Extensions view (`mcp.json` shows a Start button) or run **MCP: List Servers** in the Command Palette. Inputs can reference secrets with the `"inputs"` field instead of hardcoding passwords.

### Cursor

Via CLI (mirrors the Claude Code interface):

```bash
cursor mcp add taiga -e TAIGA_USERNAME=your_username -e TAIGA_PASSWORD=your_password -- npx -y mcp-taiga
```

Or edit `~/.cursor/mcp.json` (global):

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

Enable the server under **Cursor Settings → MCP & Integrations** if it does not activate immediately.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` (or **Windsurf Settings → Cascade → MCP Servers → Manage MCPs → View Raw Config**) and refresh the MCP panel afterwards:

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

### Cline, Roo Code, and Kilo Code

All three VS Code extensions read an equivalent JSON settings file, editable through each extension's MCP Servers panel (the pencil icon opens the raw file):

| Extension | Settings file (Linux paths; macOS uses `~/Library/Application Support/Code/User/...`, Windows `%APPDATA%\Code\User\...`) |
| --- | --- |
| Cline | `~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Roo Code | `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` |
| Kilo Code | `~/.config/Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json` |

Add the server inside the top-level `"mcpServers"` object:

```json
{
  "mcpServers": {
    "taiga": {
      "disabled": false,
      "timeout": 60,
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

Approve the server's tool use when the extension prompts; per-tool auto-approval can be configured in the same panel.

### Continue.dev

Continue reads MCP servers either from `mcpServers:` blocks in its config or from standalone YAML files in `.continue/mcpServers/` (it also accepts Claude/Cursor/Cline JSON configs dropped into that directory unchanged):

```yaml
# ~/.continue/config.yaml (or .continue/mcpServers/taiga.yaml with
# name/version/schema metadata fields added)
name: Assistant
version: 1.0.0
schema: v1
mcpServers:
  - name: Taiga
    type: stdio
    command: npx
    args:
      - -y
      - mcp-taiga
    env:
      TAIGA_USERNAME: your_username
      TAIGA_PASSWORD: your_password
```

MCP tools are available in agent mode.

### Zed

Add a custom context server in `settings.json` (**zed: open settings**):

```json
{
  "context_servers": {
    "taiga": {
      "command": {
        "path": "npx",
        "args": ["-y", "mcp-taiga"],
        "env": {
          "TAIGA_USERNAME": "your_username",
          "TAIGA_PASSWORD": "your_password"
        }
      }
    }
  }
}
```

### JetBrains IDEs

Open **Settings → Tools → AI Assistant → MCP** (or the dedicated MCP settings page in newer releases), click **Add**, choose *As JSON*, and paste:

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

Requires the AI Assistant plugin with MCP support enabled.

### Gemini CLI

Edit `~/.gemini/settings.json` and restart the CLI. Tools require confirmation per call unless you allowlist them:

```json
{
  "mcpServers": {
    "taiga": {
      "command": "npx",
      "args": ["-y", "mcp-taiga"],
      "env": {
        "TAIGA_USERNAME": "your_username",
        "TAIGA_PASSWORD": "your_password"
      },
      "includeTools": ["projects", "work", "sprints", "comments", "attachments", "wiki"]
    }
  }
}
```

Check registration with `/mcp list` inside the CLI.

### Codex CLI

Add a server table to `~/.codex/config.toml`:

```toml
[mcp_servers.taiga]
command = "npx"
args = ["-y", "mcp-taiga"]

[mcp_servers.taiga.env]
TAIGA_USERNAME = "your_username"
TAIGA_PASSWORD = "your_password"
```

Verify with `codex mcp list`; tools appear as `taiga_*` inside sessions.

### opencode

Add to `opencode.json` (project root or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "taiga": {
      "type": "local",
      "command": ["npx", "-y", "mcp-taiga"],
      "environment": {
        "TAIGA_USERNAME": "your_username",
        "TAIGA_PASSWORD": "your_password"
      },
      "enabled": true
    }
  }
}
```

Note the singular `environment` key and array-form `command`, which differ from the Claude-style schema.

### Amp

Prefer the CLI for user-scope servers:

```bash
amp mcp add taiga -- npx -y mcp-taiga
```

Or declare `amp.mcpServers` in `~/.config/amp/settings.json` (workspace `.amp/settings.json` variants require running `amp mcp approve taiga` first):

```json
{
  "amp.mcpServers": {
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

## Remote and Web Clients (HTTP Transport)

Set `TAIGA_HTTP_PORT` to expose the same six tools over streamable HTTP instead of stdio — useful for clients that cannot spawn local processes, or for running one shared instance:

```bash
TAIGA_HTTP_PORT=3000 npx -y mcp-taiga
# serves http://127.0.0.1:3000/mcp
```

Properties: stateless mode (no session headers), bound to `127.0.0.1` unless `TAIGA_HTTP_HOST` overrides it (non-loopback binds print a plaintext-HTTP warning to stderr), DNS-rebinding protection enabled for the advertised host, malformed JSON rejected with `-32700`, non-POST methods on `/mcp` answered `405`.

Clients connect by URL rather than command:

```json
{
  "mcpServers": {
    "taiga": {
      "url": "http://127.0.0.1:3000/mcp"
    }
  }
}
```

Continue.dev equivalent: `type: streamable-http` with `url:`; opencode: `type: "remote"` with `url:`. Because the process is launched manually rather than by the client, export `TAIGA_USERNAME`/`TAIGA_PASSWORD` in that shell (or use a systemd unit, container, etc.).

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

For an HTTP deployment, publish the port instead: `docker run --rm -p 127.0.0.1:3000:3000 -e TAIGA_HTTP_PORT=3000 --env-file .env mcp-taiga` and point URL-based clients at `http://127.0.0.1:3000/mcp`.

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

Single-purpose tool proliferation creates substantial context window overhead before any tool is invoked. Consolidating functionality into 6 op-dispatching domain tools keeps the `tools/list` payload to about 10,493 characters (~2,800 tokens).

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

## Security Considerations

- Credentials travel via environment variables or harness config files, never command-line arguments (which leak through process lists) and never the repository. Keep harness config files containing inline passwords out of version control; `.gitignore` already excludes `.env*` except `.env.example`.
- The optional HTTP transport binds to loopback by default and enables DNS-rebinding protection; binding to a routable address prints a warning because traffic is unencrypted.
- Attachment downloads never carry your bearer token off the Taiga hostname, refuse redirects, cap file size, and refuse to overwrite existing files.
- Deletion surfaces are single-target by design; there are no batch deletes.

## FAQ

**Which MCP clients can use it?**
Anything that speaks stdio MCP — the [installation guide](#installation-and-configuration) covers fifteen of them with copy-paste configs — plus URL-based clients through the [HTTP transport](#remote-and-web-clients-http-transport).

**Does it work with self-hosted Taiga?**
Yes. Set `TAIGA_API_URL` to your instance including the `/api/v1` suffix (e.g. `https://taiga.example.com/api/v1`). Everything else behaves identically; if requests 404, see [Troubleshooting](#troubleshooting).

**Can I connect more than one Taiga account or instance?**
Not within one server process — it holds exactly one credential set, read from the environment at startup. Register additional entries under `mcpServers` (e.g. `"taiga-work"`) with their own env values; each becomes an independent tool namespace like `mcp__taiga-work__work`.

**Where does my password go?**
From your env block into memory, and from there only to the configured Taiga host during the login exchange — never to command lines (which leak via process lists), logs, tool results, or attachment download hosts. See [Security Considerations](#security-considerations).

**Is it read-only?**
No: full create, update, link/unlink, and delete across work items, sprints, comments, attachments, and wiki pages. Sprint deletion and batch deletion are deliberately absent — see [Reliability and Safety](#reliability-and-safety).

**Why only six tools when other MCP servers expose dozens?**
Context-window economics: every tool definition is paid on every session start. See [Why Six Tools](#why-six-tools).

**Something broke — where do I start?**
[Troubleshooting](#troubleshooting) covers the common failure modes; beyond that, open a GitHub issue with the failing tool call and the server's stderr output.

## Troubleshooting

- **Authentication failures** — run the `projects` tool with `op: whoami`; it reports exactly which credential exchange failed. Check for stray whitespace in env values and that the account works in the Taiga web UI.
- **Self-hosted instance returns 404s** — `TAIGA_API_URL` must include `/api/v1`, e.g. `https://taiga.example.com/api/v1`.
- **Server starts but npx client sees no tools** — confirm Node.js >= 20.11 runs in the harness's environment; GUI launchers often inherit a different PATH than your shell.
- **Credentials ignored under npx** — npx installs do not load `.env`; put credentials in the harness `env` block (only local checkouts auto-load `.env`).
- **HTTP mode port conflicts** — another process owns the port; pick another `TAIGA_HTTP_PORT`. The server exits nonzero with a listen error rather than retrying.
- **Empty result sets** — listings report `<items> in <project>: 0`; that is a successful response, not an error.
- **Cursor/Windsurf server present but idle** — toggle the server enabled switch in the respective settings panel after editing config files; both cache state until refreshed.

## Development

### File Layout

```text
src/index.ts            # Entrypoint: createServer() factory, stdio vs HTTP transport selection
src/http.ts             # Streamable HTTP transport (node:http, stateless, DNS-rebinding protected)
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
test/httpTest.ts        # Transport tests verifying the streamable HTTP endpoint: handshake, tools/list, routing rejections
test/apiContractTest.ts # Contract tests driving every tool op against an in-process mock Taiga HTTP server, asserting outgoing HTTP requests
test/integration.ts     # Live integration smoke test against a real Taiga instance (read-only, skips without credentials)
```

### NPM Scripts

- `npm run build`: Compiles TypeScript from `src/` and `test/` into `dist/` via `tsc`.
- `npm run check`: Type-checks TypeScript code without emitting output (`tsc --noEmit`).
- `npm run lint`: Runs oxlint across `src/` and `test/`.
- `npm start`: Runs the compiled server (`node dist/src/index.js`).
- `npm test`: Compiles and runs unit, protocol, contract, and HTTP transport test suites in sequence.
- `npm run test:unit`: Compiles and runs offline unit tests.
- `npm run test:protocol`: Compiles and runs MCP protocol tests over stdio.
- `npm run test:http`: Compiles and runs streamable HTTP transport tests.
- `npm run test:contract`: Compiles and runs API contract tests against the mock Taiga server.
- `npm run test:integration`: Compiles and runs live integration tests against a live instance.
- `npm run prepublishOnly`: Runs type check, linting, and full test suite before publishing.

### Test Suites

1. **Unit Tests (`test/unitTest.ts`)**: Offline unit tests asserting pure formatting functions, response builders, identifier resolution helpers, and tool-definition invariants without network calls or credentials.
2. **Protocol Tests (`test/protocolTest.ts`)**: Protocol tests asserting the real MCP stdio handshake, server version and capabilities, tool schemas, and the `tools/list` character budget against a spawned server process.
3. **HTTP Tests (`test/httpTest.ts`)**: Spawns the compiled server with `TAIGA_HTTP_PORT` and asserts the real streamable HTTP handshake, protocol-version echo, stateless behavior, `tools/list` contents, and 400/404/405 routing rejections over localhost.
4. **Contract Tests (`test/apiContractTest.ts`)**: Contract tests asserting that every tool and op sends the expected outgoing HTTP requests (method, endpoint, query parameters, headers, and payload) and processes responses against an in-process mock Taiga HTTP server.
5. **Integration Tests (`test/integration.ts`)**: Live integration smoke tests asserting read-only tool operations against a real Taiga instance over stdio (skipped when credentials are not configured).

## Contributing

Pull requests target `dev`; see [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model (`dev` → `staging` → `main`), commit conventions, and the release process.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
