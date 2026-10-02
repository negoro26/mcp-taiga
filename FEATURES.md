# Feature map

Where every behaviour in this server lives. Read this before reading code.

Symbols are named, not line numbered, because symbols survive edits and line numbers do not. Search the symbol to jump to it.

## The one rule that explains the layout

**`src/api.ts` is the only file that knows a URL, a hostname, or a token exists.** No tool file writes one. When you read `src/tools/*.ts` you will never see HTTP. When you read `src/api.ts` you will never see what a task is. `src/taiga.ts` is the seam between the two, which is why every rule about Taiga meaning lives there.

```text
src/index.ts        process entry: load .env, build the server, hand over to stdio
  src/tools/index.ts  the six tools, registered in order
    src/tools/work.ts   one tool = one function that switches on op
      src/taiga.ts        resolve names to ids, enforce ownership, map types
        src/api.ts           authenticate, retry, cache, send
```

## The one table that describes the work tool

`TYPES` in `src/tools/work.ts` holds one entry per work type, and each entry answers everything the tool needs to know about that type in one place: the key it uses in `ITEM_TYPES`, its plural name, which Taiga status list it uses, and which arguments it accepts. It replaced four separate lookup tables.

## Start here

| I want to change | Open |
| --- | --- |
| What a tool tells the model | the `description` string in `src/tools/<tool>.ts` |
| What a tool accepts | `inputSchema` in the same file |
| What a tool does | `handler` in the same file |
| A Taiga API path | `API_ENDPOINTS` in `src/constants.ts` |
| Which arguments a type accepts, and everything else the work tool knows per type | `TYPES` | `src/tools/work.ts` |
| Who may change something | `assertWritable` in `src/taiga.ts` |
| Retry, timeout, auth | `request` and `fetchRequest` in `src/api.ts` |
| A list never returns more than 50 rows unless asked | `MAX_LIST_ROWS` | `src/constants.ts` |
| How output is rendered | `src/format.ts` |
| A new tool | a file in `src/tools/`, then add it to `src/tools/index.ts` |

## The six tools

Each file exports one `tools` array holding a single tool definition with `name`, `description`, `inputSchema`, `annotations`, and `register`.

| File | Tool | Ops |
| --- | --- | --- |
| `src/tools/projects.ts` | `projects` | list, get, whoami |
| `src/tools/work.ts` | `work` | list, get, create, update, link, unlink, delete |
| `src/tools/sprints.ts` | `sprints` | list, get, stats, create |
| `src/tools/comments.ts` | `comments` | list, add, edit, delete |
| `src/tools/attachments.ts` | `attachments` | list, upload, download, delete |
| `src/tools/wiki.ts` | `wiki` | list, get, create, update, delete, watch |

## Behaviours and the symbol that owns each

### Identity resolution

| Behaviour | Symbol | File |
| --- | --- | --- |
| a bare number is an ID, `#42` a reference inside the given project, with no fallback between them | `resolveItem` | `src/taiga.ts` |
| project slug or id becomes an id | `resolveProjectId` | `src/taiga.ts` |
| wiki slug or id becomes a page | `resolveWikiPage` | `src/taiga.ts` |
| `"me"`, a username, or an id becomes a user id | `resolveMemberId` | `src/taiga.ts` |
| the authenticated user's id | `currentUserId` | `src/taiga.ts` |
| a status name becomes a taxonomy id | `resolveTaxonomyId`, `findIdByName` | `src/taiga.ts` |
| a sprint name becomes an id | `resolveSprintId` | `src/taiga.ts` |

### Rules

| Behaviour | Symbol | File |
| --- | --- | --- |
| only the creator may delete; creator or assignee may update | `assertWritable` | `src/taiga.ts` |
| new stories and tasks join the current open sprint | `currentSprintId` | `src/taiga.ts` |
| points need a value from the project point deck | `resolvePointsPayload` | `src/taiga.ts` |
| an epic needs a slug-safe name and colour | `ITEM_TYPES` | `src/taiga.ts` |
| batch creation is capped at 20 items | `MAX_BATCH_SIZE` | `src/constants.ts` |
| delete accepts exactly one item | `handler`, the `delete` branch | `src/tools/work.ts` |
| sprint deletion is not offered | `inputSchema` | `src/tools/sprints.ts` |
| comment ownership, before any history write | `assertOwnComment` | `src/tools/comments.ts` |

### Transport and reliability

| Behaviour | Symbol | File |
| --- | --- | --- |
| log in and cache the token | `login`, `getToken` | `src/api.ts` |
| one retry after a 401 | `request` | `src/api.ts` |
| two retries after a 429, honouring `Retry-After` | `request` | `src/api.ts` |
| no retry after a 5xx | `request` | `src/api.ts` |
| 30 second request timeout | `REQUEST_TIMEOUT_MS`, `fetchData` | `src/api.ts` |
| 60 second cache for projects, users, taxonomies | `getMetadata` | `src/api.ts` |
| reject plain HTTP to a non-loopback host | `apiBaseUrl` | `src/api.ts` |
| a thrown error becomes an in-band error, not a crash | `guard` | `src/utils.ts` |

### Attachments

| Behaviour | Symbol | File |
| --- | --- | --- |
| MIME type from the file extension | `detectMimeType` | `src/tools/attachments.ts` |
| reject a redirect to another host | the `download` branch | `src/tools/attachments.ts` |
| cap reads and refuse to overwrite | `MAX_ATTACHMENT_BYTES`, the `download` branch | `src/constants.ts`, `src/tools/attachments.ts` |

### Rendering

Every response is plain text built in `src/format.ts`. `listing` produces a counted header plus one line per record. `details` produces aligned label and value pairs and drops empty values. `workLine` is the single record format for every work item.

## Tests

| File | Covers |
| --- | --- |
| `test/unitTest.ts` | pure helpers, formatting, the api layer in isolation |
| `test/protocolTest.ts` | the MCP handshake and tool advertisement over stdio |
| `test/apiContractTest.ts` | every tool op against an in-process fake Taiga server |
| `test/integration.ts` | live Taiga reads, only when credentials are set |

`test/apiContractTest.ts` fakes `src/api.ts` and nothing above it, so every layer above the HTTP boundary runs for real. A check that asserts no DELETE was recorded proves the write never left the process.

## Working rules

- **Comments are banned in code.** `anti-slop/no-comments` in `oxlint.config.ts` fails the build on any `//` or block comment. Shebangs are exempt. Put the reasoning here in `FEATURES.md` instead, and let names carry the rest.
- **Update this file in the same change** that adds, removes, renames, or moves a behaviour. A stale map is worse than none.
- **Adding a tool** means a file in `src/tools/`, an entry in `src/tools/index.ts`, a row in both tables above, and contract coverage in `test/apiContractTest.ts`.
