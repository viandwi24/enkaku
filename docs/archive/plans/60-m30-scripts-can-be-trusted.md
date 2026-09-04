# Plan 60 — M30 : A script that cannot lie about what it did

> Status: implemented — steps 60.1–60.5; `bash scripts/typecheck.sh`, `bun test` (1469 pass, 0 fail), and `bun run build:studio` are green. Step 60.6 (re-running `examples/chrome-open-url.ts` against a device) is the operator's and is not done, so acceptance criterion 6 is unproven.
> Ships: packages/drivers/src/inspector/ui-server/find-guard.test.ts
> Depends on: Plan 56 (`56-m26-ui-inspector-devtools.md` — the inspector and `Inspector.dump`), Plan 05 (the script framework), Plan 18 (the device event log).
> Spec references: §11.1 (script lifecycle), §11.2 (selectors), §7.4 (inspection layer).

---

## 0. How this was found

A script was written the way the product intends: remote the device, open the Inspect panel, read the real resource ids off the tree, then replicate the same steps as an automated job. It opened Chrome, typed `whoer.net`, waited for the page, took a screenshot, closed the tab, and returned success.

The screenshot showed a completely different site, half-loaded.

The job was green. Every assertion passed. Nothing it claimed had happened. Working out why is what this plan fixes — four separate defects, each of which hid the next.

## 1. Goals

- `find` answers **"no"** when a selector does not match, instead of returning a node that happens to exist.
- A script can read the same tree the inspector shows, so it can locate what a four-shape selector cannot.
- A script's return value is visible to the person who ran it, not only to whoever opens the database.
- The Logs tab and the Artifacts tab each show what they are for.

## 2. Non-goals

- Rewriting the on-device ui-server APK. It is a pinned third-party artefact; §3.1 fixes this host-side.
- Expanding the selector grammar (`textContains`, `className`, nth-child). §3.2 argues that `dump()` makes it unnecessary, and a grammar is a commitment that outlives its usefulness.
- Making a dump cheaper (334–584 ms measured).
- Removing the job log artefact. §3.5 explains why it must stay and what actually changes.

## 3. Context and design decisions

### 3.1 `find` returns the wrong node instead of nothing

Measured on a moto g06 power, through the product's own script runner:

```
find({ id: 'com.android.chrome:id/url_bar' })
  → className: android.widget.FrameLayout
    bounds:    0,0 → 720,1640     (the entire screen)
    clickable: false
```

The Inspect panel, dumping the same screen at the same moment, shows that id as an **EditText** at the top. So `find` and the tree disagree about the same selector, and `find` is the one that is wrong.

The damage is not the wrong bounds — it is that `tap` aims at a node's centre. A full-screen node's centre is the middle of the page, so `tap({ id: 'url_bar' })` pressed an advertisement, which navigated elsewhere. Everything after that was measuring a different page.

**A match that cannot be acted on is not a match.** `find` is host-side and can check what it was handed: a node whose bounds cover essentially the whole viewport is not a plausible answer to a specific resource id, and neither is one that is not clickable when the caller is about to tap it. The check belongs in `packages/drivers/src/inspector/ui-server/`, where `objInfo`'s answer arrives, and it returns `null` — the same answer `find` already gives for a genuine miss, so callers need no new branch.

Cross-checking against `dump()` was considered and rejected as the default: it makes every `find` cost a dump, which is the whole reason ui-server exists (`<200 ms per find`). The cheap guard catches the observed failure; the tree is available to anyone who wants certainty (§3.2).

### 3.2 A script cannot see what the inspector sees

`Inspector.dump(): Promise<UiNode>` exists (`packages/protocol/src/driver.ts:116`) and is what the Inspect panel renders. The script executor never exposes it: `packages/session/src/device-executor.ts` has cases for `find` and `waitFor`, and none for `dump`.

So the loop the inspector exists to serve — look at the tree, learn the structure, write the script — stops at the last step. The developer sees the tree; the script may only guess at one node in it.

The whoer.net page shows why this is not solved by a richer selector. The IP the operator wants is on screen, but the node holding it (`lite-your-ip-value`) carries a resource id and **no text at all**. Meanwhile the hostname node reads `FAST-INTERNET-103-186-169-250.solnet.net.id` — the same IP, dashes for dots. No selector grammar reaches that. Ordinary TypeScript over the tree does, in one line.

So `device.dump()` is added and the grammar is left alone. It also gives `find`'s answer something to be checked against, by a script that cares.

The cost is real (334–584 ms) and the API must not hide it: the method is documented with the measured range, and the SDK README shows the tree being fetched once and reused rather than called per assertion.

### 3.3 A script's return value goes nowhere

`ScriptDefinition.run`'s return value is documented as "Return value → jobs.result", and it is: the row holds `{"ok":true,"url":"whoer.net",…}`. But `GET /api/jobs/:id` never returns the field, so Studio has nothing to show, and the operator who ran the job cannot see what it reported without opening SQLite.

Confirmed from the operator's side: they looked in Summary, Logs and Artifacts and found nothing.

For a farm whose scripts exist to *report* things — an exit IP, a version, whether an element was present — a return value nobody can read is the same as no return value. It is added to the job detail response and rendered on the Summary tab.

### 3.4 Success and failure should be legible without opening a file

The runner already records phases, retries and script log lines. Today the way to see why a job failed is to open the Logs tab (which downloads the log artefact, §3.5) and read it.

The outcome — succeeded, or failed with this error at this phase — belongs on the Summary tab beside the result, with the failing line shown rather than described. The full log stays one tab away for when that is not enough.

### 3.5 The job log is not an artefact of the script's work

The Artifacts tab lists what a run produced: screenshots, pulled files, anything `ctx.artifact` saved. The `job` log is not that — it is the runner's own record, and the Logs tab is already **backed by it** (`jobs/detail/page.tsx` downloads that very artefact to render saved logs).

So it appears twice: once as the thing the Logs tab reads, and once in a list of the script's outputs where it is noise. The operator's question — *"why is there always a job.log?"* — is the right question about the wrong half.

It stays stored, because that is what the Logs tab reads and what survives a restart. It stops being **listed** as a script output. Keeping it in both places invites exactly the misreading that prompted this.

## 4. Technical design

### 4.1 The find guard

`packages/drivers/src/inspector/ui-server/find-guard.ts` (this plan's `Ships:` artefact is its test):

```ts
/** Bounds this close to the full screen are a container, not a match for a specific id. */
export function isImplausibleMatch(node: UiNode, screen: { width: number; height: number }): boolean
```

`UiServerInspector.find` returns `null` when it fires, and logs once at `warn` with the selector and what came back — silent nulls would trade one invisible failure for another.

The threshold is area-based (≥ 95% of the viewport) rather than exact-match, so a node one pixel short of full screen is caught too. `{ point: … }` selectors bypass it: a point is a coordinate, not a claim about a node.

### 4.2 `device.dump()`

- `packages/session/src/device-executor.ts`: a `dump` case calling `inspector.dump()`.
- The RPC schema, and `DeviceApi.dump(): Promise<UiNode>` in `packages/sdk/src/types.ts`, documented with the measured cost.
- No change to `Inspector` — it already has the method.

### 4.3 The result, on the way out

- `GET /api/jobs/:id` includes `result` (already on the row).
- The list endpoint does **not**: a result can be large and a list of fifty of them is not what a list is for.
- Studio's Summary tab renders it, and its failure counterpart from §3.4.

### 4.4 The Artifacts list

Studio filters `kind === 'log' && label === 'job'` out of the Artifacts tab. The API keeps returning it — the Logs tab needs it, and a filter in the API would break that.

## 5. Implementation steps

### 60.1 The find guard
- [x] `isImplausibleMatch` + `find` returning `null`, with the observed 720×1640 FrameLayout as a test case.
- Result: `find` stops answering with something unusable.

### 60.2 `device.dump()`
- [x] Executor case, RPC schema, SDK method, cost documented.
- Result: a script can walk the tree the inspector shows.

### 60.3 The result is readable
- [x] `result` on the job detail response; Summary renders it.
- Result: what a script reports reaches the person who ran it.

### 60.4 Outcome on Summary
- [x] Success/failure, phase, and the failing message on Summary.
- Result: why a job failed is answerable without opening a file.

### 60.5 The Artifacts list
- [x] Hide the runner's own log from the script-output list.
- Result: each tab shows what it is for.

### 60.6 Prove it end to end
- [ ] Re-run `examples/chrome-open-url.ts` against a device. It currently fails **honestly** (`the address bar reads "", not "whoer.net"`); with 60.1 and 60.2 it must either pass for the right reason or fail for a different one.
- Result: the script that started this plan is either correct or still honest — never green and wrong.

## 6. Acceptance criteria

1. `find` returns `null` for a selector that only matches a viewport-sized container, and says so once in the log.
2. `device.dump()` returns the same tree the Inspect panel shows for that device.
3. `GET /api/jobs/:id` includes `result`; the Summary tab shows it.
4. A failed job shows its phase and message on Summary without opening the log.
5. The Artifacts tab lists no `job` log; the Logs tab still renders it.
6. `examples/chrome-open-url.ts` no longer passes while having navigated nowhere — proven by running it.
7. `bash scripts/typecheck.sh`, `bun test`, `bun run build:studio` green; `bash scripts/check-plan-status.sh` passes.

## 7. Test plan

**Unit** — `isImplausibleMatch` against the measured node (720×1640 on a 720×1640 screen), a legitimate full-width but short node (a toolbar), and a small node; `dump` round-trips a tree through the RPC schema; the Artifacts filter keeps screenshots and drops the runner log.

**Manual smoke** (one device attached)

```bash
bun run dev
# 1. run examples/debug-node.ts with id=com.android.chrome:id/url_bar → expect found:false now
# 2. run examples/chrome-open-url.ts                                   → read Summary, not the DB
# 3. a deliberately failing script                                     → the reason is on Summary
# 4. Artifacts tab                                                     → screenshots only
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The 95% guard rejects a legitimately full-screen target. | Only for `id`/`text`/`desc`; `point` is exempt, and the rejection is logged with the node so a false negative is visible rather than mysterious. A caller that genuinely wants the root can dump and read it. |
| `dump()` is called in a loop and scripts get slow. | The measured cost is in the method's own doc, and the README shows fetching once and reusing. Not enforced: a script that wants to pay may. |
| Exposing `result` leaks something sensitive. | It is the script's own return value, already stored, already visible to anyone with database access. The list endpoint still omits it. |
| Hiding the job log from Artifacts makes it feel deleted. | It is unchanged on disk and in the API; only Studio's script-output list filters it, and the Logs tab is where it was always read. |

## 9. Open questions

1. Should `find` fall back to `dump()` + `matchSelector` when the guard fires, rather than returning `null`? Proposed: **no, not yet** — that turns a fast path into a slow one silently. Revisit if the guard proves to fire on nodes that were findable another way.
2. Should `waitFor` also refuse an implausible match? It calls `find`, so it inherits the guard and will simply keep polling — which is the right behaviour, but means a genuine timeout instead of a fast failure. Worth confirming against a real script before changing.
3. Does `examples/` belong in `scripts/typecheck.sh`? It is not typechecked today, so an example can rot silently. Proposed: yes, as its own entry — but it is a build-config change and belongs in its own change, not this one.
