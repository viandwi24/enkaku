# Owner smoke: the MVP's hardware verification, in one ordered pass

Every plan in the MVP series (`docs/plans/201` to `223`) ships one or more
goal-checklist rows marked `owner` instead of `[ ]` — a row an executing
agent cannot close because it needs a browser watching a real screen, a
phone in hand, or a farm of them. As of this document, **every one of those
rows is still open.** Nothing in this programme has ever been run against
physical Android hardware. This is the single ordered procedure that closes
them, grouped so that one device session covers everything it can, in the
order a farm actually becomes available: one phone first, then the guest
agent APK on it, then a wall of twenty.

**How to use this document.** Work session by session, top to bottom — later
sessions assume earlier ones passed (the guest agent sessions need the APK
built and installed; the farm-scale sessions need twenty devices online
already). Each row cites its plan and goal id (`21x §0 Gn`) so a failure can
be filed against the exact document that named it. Record every measured
number and every pass/fail directly into that plan's own `## 11. Handoff
report`, not only here — this document is the route through the farm, the
plan is still the system of record for whether its own goal closed.

Before starting: build the release binary (`bash scripts/build-release.sh`)
and run it on the machine that will host the farm session — every row below
assumes the real packaged artefact, not `bun run dev`.

## Session 0 — fresh install, no device required yet

Confirms the software-only owner rows that do not need a phone at all,
before any hardware is plugged in.

1. **212 §0 G12** — Settings shows all ten left-nav sections; PATCH each
   section and confirm `200`.
2. **213 §0 G2, G7, G8** — the shell's measurements match the design handoff
   pixel-for-pixel (open the handoff README beside the browser); reload and
   confirm the theme survives with no flash (`localStorage['enkaku-theme']`
   matches `<html data-theme>` on first paint).
3. **213 §0 G5** — stop the core, reload Studio: the rail keeps its five
   icons and no empty plugin separator appears.
4. **219 §0 G1** — add a throwaway top-level key (`general.smokeTest`) to
   `FarmSettingsSchema` behind a local branch, confirm a new nav entry
   appears with zero edits to `page.tsx`/`farmSections.ts`, then revert it.
5. **219 §0 G6, G7** — both plugin status pill variants render per the
   handoff; activating a staged plugin version states the consequence
   (script count) before it runs and the actual `scriptsMoved`/
   `queuedKeepingPrevious` counts after.
6. **plan 224 §7.4** (this plan) — time the fresh-install procedure end to
   end (download binary → first device visible); record the elapsed time in
   plan 224 §11. This is the moment to also confirm the status bar's health
   dot opens the doctor popover and Settings → Storage shows four non-zero
   usage rows.

## Session 1 — the first phone: enrollment, actions, jobs

Plug in exactly one phone with USB debugging enabled. This is the longest
single session in the programme — it exercises the Devices table, one
action dispatch, one job run, and the whole Device Control window on the
one device you have.

### 1a. Enrollment and the Devices table

7. **214 §0 G2** — every measurement in the handoff's "Screen: Devices"
   (§4.6–§4.13) matches, character for character (README lines 78–226 open
   beside the browser).
8. **214 §0 G5** — with ≥ 100 rows (seed synthetic rows if only one physical
   device is available), scroll at 60 fps with live task chips and no
   request fired on a timer (DevTools Performance, no frame over 16.7 ms).
9. **214 §0 G6** — selection behaves exactly as specified: a click is
   deferred 200 ms and cancelled by a double-click; marquee threshold 5 px;
   Shift/Ctrl/Cmd union select; Ctrl/Cmd+A over the filtered set; Escape
   tiers through overlays correctly.

### 1b. One action, one job, the policy warning

10. **205 §0 G15** — start a job on the device, then tap the screen while it
    runs: exactly one warning line appears in Studio and the tap still lands
    on the phone.
11. **207 §0 G17** — `POST /api/actions/adb` with `{ target:
    { deviceIds: [id] }, cmd: 'echo hi' }` answers `accepted`; `GET
    /api/operations/:id` settles to `done` with `detail.stdout` = `hi`.
12. **211 §0 G15** — re-run a settled job: the job list still shows one row,
    now with two runs, each with its own distinct result readable.
13. **216 §0 G3, G5, G6** — every action dialog's device picker matches the
    handoff (54 px collapsed picker); a `warned` device shows its policy
    sentence on its own chip and "Continue for N devices" resends with
    `force: true`; a target where every device is `forbidden` disables the
    primary button.
14. **217 §0 G3, G6, G14** — `/scripts` shows three tabs (Scripts, Workflows,
    Schedules) each with a live count; the workflow editor at
    `/scripts/editor` saves through `POST /api/workflows` (create) and `PUT
    /api/workflows/:name` (edit); the full 7-step owner smoke in that plan's
    §7 passes.
15. **218 §0 G9, G10, G11, G12, G17** — the Jobs screen's measurements match
    the handoff (README lines 324–389); re-running keeps one row with two
    runs, each holding a different `finishedAt` and its own Output; a
    workflow job shows its step rows and clicking one opens that step's own
    script job; the trace timeline scrubs and the frame strip moves the
    playhead in sync; `?compare=<runId>` renders two runs side by side.
16. **219 §0 (Agents)** / **220 §0 G12** — on the Agents page: 5 tabs load,
    an agent can be created/duplicated/deleted, an approval can be decided,
    a file can be opened and saved, and a settings field can be changed and
    saved.

### 1c. Device Control — the whole window, one phone

Open Device Control on the one phone and go through this block in order;
it is the largest single owner-row cluster in the programme (14 rows in one
plan).

17. **215 §0 G3** — the window drags by either header strip; Escape resets
    the drag offset to `{0,0}`.
18. **215 §0 G5** — retargeting the selection keeps it when the new device is
    already in it, and collapses to just the new device when it is not.
19. **215 §0 G8, G9** — clicking the canvas takes focus (`ring-2
    ring-accent`), released by an outside click, `Alt+Shift+K`, or closing
    the window; while focused, every key including Tab is swallowed by the
    canvas and reaches the device as `input.keyEvent`.
20. **215 §0 G10 / 209 §0 G22** — type a sentence: every character paints on
    the device before the next key is pressed, at 5 characters/second, with
    no batching.
21. **215 §0 G11 / 209 §0 G23** — Tab moves focus between fields on the
    device; Ctrl+A selects all; arrows move the cursor; Shift+arrow extends
    a selection.
22. **215 §0 G12 / 209 §0 G24** — the wheel scrolls a list at the pointer;
    Shift+wheel scrolls it horizontally.
23. **215 §0 G13** — right click sends Back, middle click sends Home,
    Ctrl+drag pinches — three gestures, three device reactions.
24. **215 §0 G14** — copy text on the device, then `Alt+C` puts it on the
    host clipboard; `Alt+V` pastes the host clipboard into a focused device
    field.
25. **215 §0 G15** — the Inspector tab captures a tree on Capture; selecting
    a node draws its bounds (`1.5px solid var(--accent)` over
    `var(--accent-a2)`) on the snapshot.
26. **215 §0 G16** — the compact job detail's Stop posts `/api/jobs/:id/cancel`
    on a running job; Re-run posts `/api/actions/run-script` with `jobId` on
    a settled one.
27. **215 §0 G17** — with several devices selected, the host banner reads
    "Mirroring input to N other selected devices · N+1 under control" and
    every keypress/tap fans out client-side as one `input.*` message per
    member device — zero `input.mirror` messages on the wire.
28. **215 §0 G18** — the Files section lists a device directory (breadcrumb
    `sdcard / Download`, header `N items · X% free`) and folders navigate.
29. **215 §0 G26 / 209 §0 G26** — the stats strip shows a numeric input-leg
    figure; record it into both plans' §11.
30. **209 §0 G25** — 20 taps on an on-screen button register 20 times on the
    UHID engine (if fewer register, plan 209 §9 Q3's `MIN_TAP_HOLD_MS` needs
    raising — record the observed count either way).

## Session 2 — latency measurement (the overlay and the camera)

Needs the plan 203 latency overlay switched on and, for the glass-to-glass
number, a phone camera pointed at both the device screen and the monitor.

31. **203 §0 G4** — open the overlay: `EncodedVideoChunk.timestamp` equals
    the device PTS for every chunk with `ptsUs > 0`.
32. **203 §0 G6** — the overlay renders all eight rows: `device→host`,
    `host→browser`, `decode`, `decode→paint`, `queue`, `fps`, `dropped`,
    `keyframe requests`.
33. **203 §0 G7** — toggling the overlay persists across a reload
    (`LocalPrefs.latencyOverlay`).
34. **203 §0 G12** — `ENKAKU_TEST_DEVICE=1 bun run bench:device-nfrs --
    --serial <S> --latency --skip-inspector` prints a `latency: ttfp=<N> ms`
    line; paste it into plan 203 §11.
35. **203 §0 G13** — run the H-9 experiment (plan 203 §5 step 203.13); fill
    its six-number table (30 fps and 60 fps columns, three rows) directly in
    plan 203.
36. **203 §0 G14** — with a camera, record ≥ 10 glass-to-glass samples;
    compute the median and p95; write the median into
    `docs/mvp/01-casting-latency.md` §4 step 1.

## Session 3 — the guest agent APK

Build the APK (`bun run build:guest-agent`) and install it on the same
phone. Accessibility enablement is the one step in this programme with a
documented OEM caveat (plan 200 §5 R4) — expect to fall back to the status
screen's own button on some devices.

37. **221 §0 G3** — `ENKAKU_TEST_DEVICE=1 bun run scripts/ui-tree-diff.ts
    --serial <serial>` prints `identical: N nodes` (zero differing nodes
    against ui-server's own dump of the same screen).
38. **221 §0 G6** — the same tool with `--watch 20` prints a `watch p95: <N>
    ms` line under 200 ms.
39. **221 §0 G7** — `settings get secure enabled_accessibility_services`
    contains the guest agent's service and `accessibility_enabled` is `1`.
    If the write is refused, use the status screen's "Open accessibility
    settings" button and record the OEM and the refusal text in plan 221
    §11.
40. **221 §0 G8** — the on-device status screen renders its twelve sections
    (Now, Device, Farm link, Video, Inspector, Route, Checks, Keyboard,
    Label, Location, This build) in order, omitting any it has no fact for.
41. **221 §0 G9** — start a job: the Now section shows it within 2 s of the
    push; stop the core and confirm the section goes `stale` after the
    dead-man's-switch timeout (90 000 ms).
42. **221 §0 G10** — set the soft-keyboard-with-hardware preference, `adb
    reboot`, restart the agent: the preference survived.

## Session 4 — inspector phase 2 (`ui-tree` as the live engine)

Follows directly from Session 3 — same phone, guest agent already
installed.

43. **222 §0 G15** — `ENKAKU_TEST_DEVICE=1 bun run
    scripts/bench-device-nfrs.ts --serial <serial> --skip-video --engine
    ui-tree` reports `find() p95` under 200 ms.
44. **222 §0 G16** — the same run's `dump() latency` row; paste it into plan
    222 §11 and into the SDK comment G12 names.
45. **222 §0 G17** — add `--waitfor-cycles 20`: `waitFor push p95` prints
    under 100 ms.
46. **222 §0 G18** — the Inspect tab's `inspect.status.engineId` and `GET
    /api/devices/:id`'s `liveInspection` both read `ui-tree` on this device;
    confirm a device without the guest agent still reads `ui-server`.
47. **222 §0 G12** — once G15–G18 are all filled, confirm no `TBD-222-`
    token remains anywhere those numbers were recorded.

## Session 5 — inspector phase 1's remaining device rows

These belong logically beside Session 1's device work but need either a
20-device farm or a specific manifest evaluation, so they are grouped here
instead of forced into the single-phone session above.

48. **208 §0 G9** — evaluate ui-server 2.4.0 on the lab device; either pin
    `2.4.0` with a computed sha256, `versionCode`, and a real
    `compatibleCoreRange` (removing `TODO-M4.5`), or keep the `2.3.3` pin and
    record why in plan 208 §9/§11.
49. **208 §0 G10** — a warm attach (engine already ready) completes within
    3000 ms; a cold attach (prewarm from a fresh session) completes within
    8000 ms.
50. **208 §0 G11** — `ENKAKU_TEST_DEVICE=1 bun run
    scripts/bench-device-nfrs.ts --serial <serial> --skip-video` reports
    `find() p95` under 200 ms.

## Session 6 — the farm: warm-up, scale, and 24-hour soak

Needs the owner's 20-device farm online at once. This is the session that
cannot be shortened onto fewer devices — several rows are explicitly about
what changes at that scale.

51. **206 §0 G12** — `bun run scripts/bench-device-nfrs.ts --warmup --expect
    20` prints `warm: 20/20 in S s`, S ≤ 60.
52. **206 §0 G13** — every visible Screens tile paints within one keyframe
    interval of `stream.started`, on the full farm.
53. **206 §0 G14** — Device Control shows a first frame within 100 ms of
    open while `substitute === 'wall'`, sharp within 2 s.
54. **208 §0 G12** — run a 10-minute job across all 20 devices: zero
    `device.inspector.fallback` broadcasts, zero `session.degraded` events
    with `to: 'uiautomator-dump'`.
55. **223 §0 G10** — USB plug to first painted frame is under 5 s warm,
    under 20 s on first provisioning (`GET /api/video/sessions` reaching
    `state: 'ready'`).
56. **223 §0 G11** — unplug and replug one device: the stream recovers under
    5 s with no operator action.
57. **223 §0 G12** — `ENKAKU_TEST_DEVICE=1 bun run scripts/soak.ts
    --duration-min 1440 --expect-devices 20` exits `0`, with
    `adbProcessesEnd - adbProcessesStart == 0` and the same for forwards
    (this row alone takes 24 hours — start it and come back).
58. **223 §0 G13** — during a bulk inspector attach across the farm, `GET
    /api/adb/stats`'s `hostAdb.installsByRoot[<root>].running` never exceeds
    1.
59. **223 §0 G14** — `ENKAKU_TEST_DEVICE=1 bun run scripts/soak.ts
    --duration-min 60 --expect-devices 20` exits `0` with
    `sessionsRebuilt == 0` (rotations aside — see plan 223 §3.6's caveat).
60. **223 §0 G15** — record the full 20-device run's CPU, memory, and
    latency-overlay reading into plan 223 §11.
61. **223 §0 G16** — attempt the 100-device run on the lab host; record the
    filled results table, or a stated reason for deferral, into plan 223
    §11.

## After the farm session: close the loop

- Paste every measured number into the plan that owns its goal row — this
  document is the route through the hardware, not the record of what it
  found.
- A row that could not be run (no farm access, no camera, no second OS)
  stays `owner` and unchecked; say so plainly in that plan's §11 rather than
  guessing a number.
- When every row above is closed, `docs/spec.md` §17's "not measured" column
  entries for the corresponding metrics should be replaced with the real
  numbers, by the same plan that owns each row.
