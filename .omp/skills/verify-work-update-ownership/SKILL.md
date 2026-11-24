---
name: verify-work-update-ownership
description: Model-check that work update writes only items you own or are assigned to, even while a colleague edits the same item. Use before changing resolveItem, assertWritable, or patchItem in src/taiga.ts, or the update op in src/tools/work.ts, and whenever `npm run verify:ownership` reports a covered region as CHANGED.
---

# Verify work update ownership

**Rule.** A write from `work op=update` lands only while the item's creator or assignee is you.
**Harm.** If the rule breaks, the agent edits a colleague's item that was reassigned away from you seconds earlier, and reports `Updated`.

The guard is sound only because the PATCH carries the `version` that `assertWritable` checked. Taiga rejects the PATCH if anything changed in between.

## Run

```sh
npm run verify:ownership
```

This needs Java 11 or later, curl, and node. The first run downloads TLC 1.7.4 (pinned by SHA-256) to `~/.cache/mcp-taiga/`. A run takes about 3 seconds. It prints one line per covered region, then one line per rule. It exits 0 only when every region is in sync and every rule matches its expected result. For an unexpected result it prints TLC's trace. Each `State N: <Action ...>` line names the step.

| Rule | Expected | Meaning |
| --- | --- | --- |
| `OwnedAtFirstPatch` | holds | The first PATCH, sent with the checked version, lands only on your item. |
| `NoWriteAfterRefusal` | holds | Nothing lands after `assertWritable` refuses. |
| `OwnedAtRetryPatch` | violated, known finding 1 | The version-conflict retry can land on a colleague's item. |
| `OwnedAtAddonWrite` | violated, known finding 2 | A task `points` or `priority` write can land on a colleague's item. |

Read every TLC result with `/skill:statechart`. Give it a scratch copy of the spec, and a config that lists all four rules as `INVARIANT`. It checks them one at a time, and tells each violation as its shortest path in plain words. If that skill is not available to you, read the trace that `check.sh` prints.

## Known findings

Both reproduce on the real server. `npm run build && node verify/ownership/replay.mjs` replays them through a fake Taiga on 127.0.0.1. It exits 0 while both still reproduce.

1. **Retry.** You pass the ownership check. A colleague reassigns the item. Taiga rejects the PATCH because the version is stale. `patchItem` re-reads only the version (`src/taiga.ts`, the `status === 400` branch) and PATCHes again without re-checking ownership. Taiga saves the edit. To fix it, re-run `assertWritable` on the refetched item before the second PATCH. A model with that fix passes `OwnedAtRetryPatch`.
2. **Task points and priority.** You pass the ownership check. A colleague reassigns the task. `POST /task-points` or `POST /task-priority` carries no version, so Taiga saves it. The client cannot close this window. It needs a version or an ownership check on the server.

When a fix lands, move that rule from `known` to `holds` in `verify/ownership/check.sh`, drop its scenario from `replay.mjs`, and delete its entry here. Never move a rule into `known` to make a run pass. A new violation is a bug report for the user, not a change to the model.

## Model to code

The spec is `verify/ownership/WorkUpdateOwnership.tla`. Each action is one HTTP request or one local decision in the code. Model each new GET as its own action that copies from `item`. Model each new write as its own action that calls `Land(kind)`. A colleague's step can then fall between them.

| Action | Code |
| --- | --- |
| `ResolveItem` | `resolveItem` in `src/taiga.ts`, called at the start of `if (op === 'update')` in `src/tools/work.ts` |
| `AssertWritable` | `assertWritable` in `src/taiga.ts` (creator, or `assigned_to` / `assigned_users`) |
| `PatchWithSeenVersion` | `patchItem` in `src/taiga.ts`, first PATCH with `known.version` |
| `RefetchVersion` | `patchItem`, GET in the `status === 400` branch |
| `PatchWithFreshVersion` | `patchItem`, second PATCH with `fresh.version` |
| `PostTaskAddon` | `post(API_ENDPOINTS.TASK_POINTS / TASK_PRIORITY)` after the PATCH in the update op |
| `HumanReassigns`, `HumanEditsOtherField` | a colleague in the Taiga UI, each bumping `version` |

## Scope

TLC explores every order of these steps. The item starts in each combination of you and a colleague as creator and assignee. A colleague makes at most 2 edits (`MaxHumanEdits = 2`). There are 568 states.

It assumes:
- Taiga's permission check is by role, so it accepts any member's write.
- Taiga checks and bumps `version` atomically.
- The creator never changes.
- The agent's own payload does not reassign the item.
- `assigned_users` is folded into one assignee.

It leaves out:
- `link`, `unlink`, `delete`, the wiki and attachment guards, and `comments` (which skips the guard by design).
- Retries on 401 and 429. Taiga rejected those requests before applying them.

## Real bug or modeling error

Replay the shortest path against the real code before you report it. Add a scenario to `SCENARIOS` in `verify/ownership/replay.mjs`, or adapt its fake Taiga so the colleague's step happens at the same point. Then run `npm run build && node verify/ownership/replay.mjs`, which drives `node dist/src/index.js` over stdio. If the real code does not reproduce the path, treat the model as wrong until you show otherwise. Fix the action that differs from the code, not the rule.

## Keep it in step

`verify/ownership/coverage.mjs` compares each covered region at the sync commit with the working tree:
- `resolveItem`, `assertWritable`, and `patchItem` in `src/taiga.ts`
- the `if (op === 'update')` block in `src/tools/work.ts`

`CHANGED` means re-read that region against the table above. If the behavior changed, edit the matching action, then rerun. Move the sync commit forward only after the model matches the code at the new commit, and the rules match their expected results there. When a new step joins the flow, add its region to `REGIONS` in `coverage.mjs` and to the table above.

Sync commit: `633a048`
