# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Migrated the server, client tests, and HTTP adapter to the official MCP TypeScript SDK v2.1.0 split packages.
- Enabled the 2026-07-28 MCP protocol era over stdio and HTTP while retaining stateless legacy-client compatibility.
- Converted all six tool definitions to Standard Schema objects and tightened LLM guidance around project discovery and operation-specific arguments.
- Raised finite HTTP body limits to cover base64 attachment uploads and made attachment downloads metadata-first; bytes now require `includeContent: true` or `savePath`.
- Added modern stdio and HTTP protocol negotiation coverage, including schema validation failures.
- Replaced Axios with native fetch while preserving authentication, bounded retries, timeouts, FormData uploads, and bounded attachment downloads.
- Raised the runtime baseline to Node.js 24 LTS, replaced dotenv with Node's built-in environment loader, and refreshed all direct dependencies.
- Synced the focused `no-array-filter-map` and `no-reduce-accumulator-copy` anti-slop rules from upstream while retaining the local no-comments policy.

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
