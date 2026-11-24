# Changelog

## [2.0.0](https://github.com/negoro26/mcp-taiga/compare/v1.0.0...v2.0.0) (2026-11-24)


### ⚠ BREAKING CHANGES

* **release:** the streamable HTTP transport and TAIGA_HTTP_PORT/TAIGA_HTTP_HOST are removed; the server speaks stdio only and requires Node.js 24.

### Features

* **activity:** log and audit pmdashboard time ([d5c6d14](https://github.com/negoro26/mcp-taiga/commit/d5c6d1400285f8fb823200c0ee3774bbf93cf5d3))
* modernize MCP server for v2 ([61c7240](https://github.com/negoro26/mcp-taiga/commit/61c72400ca33414b7e8027fbaac41c60afe27f3c))
* ownership guard, sprint defaults, and a simpler stdio-only server ([028e00b](https://github.com/negoro26/mcp-taiga/commit/028e00b5ef6b57972ee053590609b3e699d41427))
* sync upstream anti-slop, drop test and doc files, add pmdashboard sprint and task endpoints ([815ca1b](https://github.com/negoro26/mcp-taiga/commit/815ca1bf5df1fa70e935037b6e12175fe67816b1))


### Bug Fixes

* **activity:** mark the activity tool destructive, since it deletes entries ([9b7972f](https://github.com/negoro26/mcp-taiga/commit/9b7972faa33bd4a52a20740d8e312c8e715b9913))
* batch sprint default, cross-project containment, and honest ownership docs ([27e0897](https://github.com/negoro26/mcp-taiga/commit/27e0897d43f6983c3a9b96f40ac3aed165a0b2f2))
* declare destructiveHint on tools exposing delete operations ([cd66ebd](https://github.com/negoro26/mcp-taiga/commit/cd66ebd917bcad2da541ab71e7e116d6dbd10f88))
* **ownership:** post task add-ons after the PATCH, re-checking only if the task changed ([031a894](https://github.com/negoro26/mcp-taiga/commit/031a89414a1abece460d6ec4d623a4992789216b))
* **ownership:** re-check ownership before the retry PATCH and task add-on writes ([9c3ed82](https://github.com/negoro26/mcp-taiga/commit/9c3ed820b829a4aa0915aab795ac5ce826bc4165))
* report the package.json version in the MCP handshake ([e1153ca](https://github.com/negoro26/mcp-taiga/commit/e1153ca66f175b5761400aac7a55bbc92b8d5539))


### Continuous Integration

* **release:** tag and publish through release-please ([82df50d](https://github.com/negoro26/mcp-taiga/commit/82df50d7029b181ae95d1ef012d5960d3b2aa3b4))

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
