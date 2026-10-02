# Agent rules for mcp-taiga

Read [FEATURES.md](FEATURES.md) before reading any source. It maps every behaviour in this server to the file and symbol that owns it. Use it as the table of contents; it is more accurate than grepping.

## Layout in one line

`src/index.ts` starts the process, `src/tools/*.ts` decide what a tool does, `src/taiga.ts` resolves Taiga names and holds every rule about Taiga, `src/api.ts` is the only file that knows URLs and tokens exist.

## Rules

- **No comments in code.** `//` and block comments fail `npm run lint` via the `anti-slop/no-comments` rule. Shebangs are exempt. Make names carry the meaning and put the reasoning in `FEATURES.md`.
- **Update `FEATURES.md` in the same change** that adds, removes, renames, or moves a behaviour. Add a tool and you owe a file in `src/tools/`, an entry in `src/tools/index.ts`, two table rows in `FEATURES.md`, and contract coverage in `test/apiContractTest.ts`.
- **Do not add an HTTP client or framework.** `src/api.ts` already uses native `fetch`. The server speaks stdio only; there is no HTTP transport.
- **Never weaken an ownership check.** `assertWritable` in `src/taiga.ts` refuses writes to items the caller does not own, and fails closed when Taiga reports no owner.
- **Verify with the suite, not by hand.** `npm run check && npm run lint && npm test`. Do not call the live Taiga API to test a write.
- **Test through the fake Taiga in `test/apiContractTest.ts`.** For a refusal, assert both the error text and that no mutating request was recorded.
- **Conventional commits**, `<type>: <description>`. Pull requests target `dev`.

## Style

Match the file you are editing: no comments, no defensive wrappers around values that cannot be wrong, error messages that name the offending value and list the valid ones.
