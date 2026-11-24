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
| `OwnedAtRetryPatch` | holds | The version-conflict retry re-checks ownership, so it lands only on your item. |
| `NoWriteAfterRefusal` | holds | Nothing lands after the first `assertWritable` refuses. |
| `OwnedAtAddonWrite` | violated, known finding | A task `points` or `priority` write can still land on a colleague's item. |

Read every TLC result with `/skill:statechart`. Give it a scratch copy of the spec, and a config that lists all four rules as `INVARIANT`. It checks them one at a time, and tells each violation as its shortest path in plain words. If that skill is not available to you, read the trace that `check.sh` prints.

## Known finding

**Task points and priority.** After the PATCH, the update op re-reads the task. If its `version` differs from the PATCH response (or from the first read, when nothing was patched), the op re-checks ownership. A colleague can still reassign the task in the gap between that re-read and the POSTs. The POSTs carry no version, so Taiga saves them. The gap is one request wide, and the client cannot close it. Only pmdashboard can, by taking a version or checking ownership itself.

`npm test` ends with `node verify/ownership/replay.mjs`. It drives the built server against a fake Taiga on 127.0.0.1. Each scenario says when the colleague reassigns (after which GET of the task) and the expected outcome:
- `refused`: the guard caught it.
- `reproduced`: the known finding still happens.

It exits 1 on any other outcome.

If pmdashboard closes the gap, move `OwnedAtAddonWrite` from `known` to `holds` in `verify/ownership/check.sh`, change its `reproduced` scenario in `replay.mjs` to `refused`, and delete this section. Never move a rule into `known`, and never flip a scenario to `reproduced`, to make a run pass. A new violation is a bug report for the user, not a change to the model.

## Model to code

The spec is `verify/ownership/WorkUpdateOwnership.tla`. Each action is one HTTP request or one local decision in the code. Model each new GET as its own action that copies from `item`. Model each new write as its own action that calls `Land(kind)`. A colleague's step can then fall between them.

| Action | Code |
| --- | --- |
| `ResolveItem` | `resolveItem` in `src/taiga.ts`, called at the start of `if (op === 'update')` in `src/tools/work.ts` |
| `AssertWritable` | `assertWritable` in `src/taiga.ts` (creator, or `assigned_to` / `assigned_users`) |
| `PatchWithSeenVersion` | `patchItem` in `src/taiga.ts`, first PATCH with `existing.version`; on success `seen` becomes the PATCH response |
| `RefetchAndRecheck` | `patchItem`, GET in the `status === 400` branch, then `assertWritable` when the caller passes `ownedAs` |
| `PatchWithFreshVersion` | `patchItem`, second PATCH with `fresh.version` |
| `RereadForAddon` | `resolveItem(internalKey, existing.id)` in the `hasTaskAddonWrite` branch, after the PATCH; skips `assertWritable` only when `current.version` equals `updated.version`; refusing ends in `refusedLate` |
| `PostTaskAddon` | `post(API_ENDPOINTS.TASK_POINTS / TASK_PRIORITY)`, one action for both POSTs |
| `HumanReassigns`, `HumanEditsOtherField` | a colleague in the Taiga UI, each bumping `version` |

## Scope

TLC explores every order of these steps. The item starts in each combination of you and a colleague as creator and assignee. A colleague makes at most 2 edits (`MaxHumanEdits = 2`). There are 568 states.

It assumes:
- Taiga's permission check is by role, so it accepts any member's write.
- Taiga checks and bumps `version` atomically.
- The creator never changes.
- The agent's own payload does not reassign the item.
- `assigned_users` is folded into one assignee.
- Taiga always returns `version` on reads and on the PATCH response. The code re-checks when `version` is missing; the model does not model that case.

It leaves out:
- `link`, `unlink`, `delete`, the wiki and attachment guards, and `comments` (which skips the guard by design). `wiki update` passes `ownedAs` to `patchItem` too, but only the work flow is modeled.
- Retries on 401 and 429. Taiga rejected those requests before applying them.

A late refusal (`refusedLate`) at the add-on re-read can follow a PATCH that already landed while you held the task. The tool then reports an error even though the PATCH fields were saved. No rule covers that partial write.

## Real bug or modeling error

Replay the shortest path against the real code before you report it. Add a scenario to `SCENARIOS` in `verify/ownership/replay.mjs`, or adapt its fake Taiga so the colleague's step happens at the same point. Then run `npm run build && node verify/ownership/replay.mjs`, which drives `node dist/src/index.js` over stdio. If the real code does not reproduce the path, treat the model as wrong until you show otherwise. Fix the action that differs from the code, not the rule.

## Keep it in step

`verify/ownership/coverage.mjs` compares each covered region at the sync commit with the working tree:
- `resolveItem`, `assertWritable`, and `patchItem` in `src/taiga.ts`
- the `if (op === 'update')` block in `src/tools/work.ts`

`CHANGED` means re-read that region against the table above. If the behavior changed, edit the matching action, then rerun. Move the sync commit forward only after the model matches the code at the new commit, and the rules match their expected results there. When a new step joins the flow, add its region to `REGIONS` in `coverage.mjs` and to the table above.

Sync commit: `031a894`
