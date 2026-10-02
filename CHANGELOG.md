# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Ownership checks on every mutating operation. `work.update`, `link`, and `unlink` allow the creator or the assignee; `work.delete`, `wiki.update`, `wiki.delete`, and `attachments.delete` allow only the creator; `comments.edit` and `comments.delete` allow only the comment's author. Records Taiga returns without an owner are refused instead of written.
- `FEATURES.md`, a map from every behaviour to the file and symbol that owns it, plus `AGENTS.md` for coding agents. Both are linked from the README and CONTRIBUTING guide.
- An `anti-slop/no-comments` lint rule that fails the build on any comment in `src` or `test`, so reasoning lives in `FEATURES.md` instead of in the source.

### Changed

- `work.create` now places new user stories and tasks in the project's current open sprint unless `sprint` is given, so items no longer land in the backlog by default.
- `work.list` now returns at most 50 rows by default instead of the whole project. The header reports both the page size and the true total, so an agent can raise `limit` deliberately. A 200-item project went from about 7,225 tokens per call to about 1,788.
- Tightened the six tool descriptions into compact operation tables, removed the optional-argument columns that repeated the JSON Schema word for word, and trimmed the three longest property descriptions. `tools/list` fell from 9,897 to 9,036 characters, about 215 tokens off every turn, with no capability lost. Server `instructions` were shortened from 462 to 149 characters for the same reason.
- Collapsed four parallel type lookup tables in `work.ts` into one `TYPES` table, so everything the tool knows about a work type sits in one place.
- Migrated the server and client tests to the official MCP TypeScript SDK v2.1.0 split packages.
- Enabled the 2026-07-28 MCP protocol era over stdio while retaining legacy-client compatibility.
- Converted all six tool definitions to Standard Schema objects and tightened LLM guidance around project discovery and operation-specific arguments.
- Raised finite request body limits to cover base64 attachment uploads and made attachment downloads metadata-first; bytes now require `includeContent: true` or `savePath`.
- Added modern stdio protocol negotiation coverage, including schema validation failures.
- Replaced Axios with native fetch while preserving authentication, bounded retries, timeouts, FormData uploads, and bounded attachment downloads.
- Raised the runtime baseline to Node.js 24 LTS, replaced dotenv with Node's built-in environment loader, and refreshed all direct dependencies.
- Synced the focused `no-array-filter-map` and `no-reduce-accumulator-copy` anti-slop rules from upstream while retaining the local no-comments policy.

### Fixed

- A bare numeric `item` is now always an ID and `#42` is always a reference. Previously a bare number that returned 404 was silently retried as a reference in the supplied project, so one argument could resolve to two different items depending on what Taiga happened to contain, and deleting the wrong one was possible when that wrong item happened to be yours.

### Removed

- The optional streamable HTTP transport, along with `TAIGA_HTTP_PORT`, `TAIGA_HTTP_HOST`, `src/http.ts`, and `test/httpTest.ts`. The server speaks stdio only, which removes a transport layer and roughly 320 lines from the codebase. Remote and browser-based MCP clients need a stdio-capable client or a bridge.
- Three unused helpers, `formatDate`, `getStatusLabel`, and `getSafeValue`, along with the `STATUS_LABELS` constant that only they read. Two were single-expression wrappers of the kind the anti-slop rules exist to prevent, kept alive only by their own unit tests.
- A dead `oxlint` override for `test/**/*.js`, a glob that matches no file because the suite is TypeScript.

## [1.0.0] - 2026-08-24

### Added

- Taiga MCP server in TypeScript over the Model Context Protocol: stdio transport by default, optional streamable HTTP transport when `TAIGA_HTTP_PORT` is set (loopback-bound, enables remote and web-based MCP clients).
- Six op-dispatching tools covering 28 operation pairs: `projects`, `work`, `sprints`, `comments`, `attachments`, `wiki`.
- Project slug / work-item `#reference` / human-readable taxonomy resolution with a 60-second metadata cache.
- Rate-limit retry honoring `Retry-After`, 30-second request timeouts, HTTPS enforcement warning, hostname-restricted attachment downloads with size caps and overwrite protection.
- Two-stage non-root Dockerfile.
- Test suites: offline unit tests, MCP protocol tests, API contract tests against an in-process mock Taiga server, HTTP transport tests, and an optional live integration smoke test.
- CI workflow running type check, lint, and the full test suite on every push to `main`, `staging`, and `dev` and on all pull requests.
- Branching model (`dev` → `staging` → `main`) documented in `CONTRIBUTING.md`.
- Per-harness installation guide covering Claude Code, Claude Desktop, VS Code, Cursor, Windsurf, Cline/Roo Code/Kilo Code, Continue.dev, Zed, JetBrains IDEs, Gemini CLI, Codex CLI, opencode, Amp, and Docker/HTTP clients.
- npm publish workflow triggered by `v*` tags after full verification.
