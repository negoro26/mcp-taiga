# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
