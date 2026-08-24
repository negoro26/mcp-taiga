# Contributing

Thanks for your interest in improving the Taiga MCP server.

## Branching Model

Three long-lived branches, promoted in one direction only:

```text
feature/* ──► dev ──► staging ──► main ──► tag v* (npm release)
```

| Branch | Purpose | Stability |
| --- | --- | --- |
| `dev` | Default integration branch. All feature work lands here first. | May break. |
| `staging` | Release candidate. Integration and soak testing. | Should work; not guaranteed. |
| `main` | Production. Matches the latest published npm release. | Always releasable. |

Workflow:

1. Branch off `dev`: `git switch -c feature/my-change dev`
2. Open a pull request targeting **`dev`**.
3. When `dev` is coherent, open `dev` → `staging`.
4. To cut a release: open `staging` → `main`, update `CHANGELOG.md` and the version in `package.json`, then tag on `main`.

Tagging `v*` on `main` triggers the publish workflow, which re-runs type check, lint, and the full test suite before publishing to npm (`NPM_TOKEN` secret required).

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <description>` with types `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Example: `feat: add streamable HTTP transport`.

## Development Setup

Requirements: Node.js >= 20.11.

```bash
npm ci
npm run build     # compile src/ and test/ into dist/
npm test          # unit + protocol + contract suites (offline)
npm run test:integration   # optional live smoke test; needs TAIGA_USERNAME/TAIGA_PASSWORD
```

Copy `.env.example` to `.env` for local runs — the server loads it automatically from a local checkout. See the README for architecture notes, the tool reference, and the reliability model before proposing changes.
