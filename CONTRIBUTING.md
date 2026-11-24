# Contributing

Thanks for your interest in improving the Taiga MCP server.

## Branching and releases

Branch off `main` and open a pull request to `main`.

Releases are automatic. On every push to `main`, release-please opens or updates a release PR that bumps `package.json` and writes `CHANGELOG.md` from the commit messages. Merging it tags `v<version>`, creates the GitHub release, re-runs type check, lint, and tests, and publishes to npm through trusted publishing.

`feat` bumps the minor version, `fix` the patch, and `feat!` or a `BREAKING CHANGE:` footer the major.

## Commit Format

[Conventional Commits](https://www.conventionalcommits.org/): `<type>: <description>` with types `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`. Example: `feat: add points validation`.

## Development Setup

Requirements: Node.js >= 24.

```bash
npm ci
npm run build     # compile src/ and test/ into dist/
npm test          # protocol + contract suites (offline)
```

Copy `.env.example` to `.env` for local runs — the server loads it automatically from a local checkout. See the README for architecture notes, the tool reference, and the reliability model before proposing changes.
