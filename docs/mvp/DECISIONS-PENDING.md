# Decisions waiting on the CEO

> Compiled 2026-09-03 after the MVP plan series (`docs/plans/200`–`224`) was written.
> **Answered by the CEO the same day.** Every item below now carries its decision. Items 1 to 4 are closed; item 5 is explained rather than decided; item 6 was never a question.

## 1. The lab device — DEFERRED (CEO, 2026-09-03)

**Decision: no lab device now. Finalising the MVP is the focus.**

**Consequence, stated plainly so nobody is surprised later:** every plan still ships its software, but the checklist rows marked `owner` stay open. That means the MVP **cannot claim a measured latency number, a measured attach number, or a measured device-per-host number** until hardware time exists. Plans 203, 208, 221, 222 and 223 build the instruments and leave the readings blank; plan 224's spec finalisation lists them as unmeasured rather than quoting the old promises. Anything that would have been *fixed* because a measurement exposed it is also deferred, and that is the real cost: we ship a farm we believe is fast, not one we have proved is fast.

**What still works without it:** all software acceptance, every unit test, every removal grep, and a smoke on the owner's existing 20-device farm for anything that does not require unplugging a cable.

**Original ask, for the record:** one Android 16 (API 36) device dedicated to the lab, not the production farm.

**Why:** nine plans carry checklist rows marked `owner` that cannot be closed without it. The owner's 20-device farm is a sealed OTG box where a disconnect costs a hardware teardown, so it cannot be experimented on.

**What it unblocks:** the latency measurement (203), whether openatx 2.4.0 runs on API 36 at all (208 — this closes a question open since plan 129), accessibility enablement from adb (221), the inspector's push `waitFor` timing (222), and every scale and soak number (223).

## 2. Agents and Nodes — DECIDED (CEO, 2026-09-03)

**Decision: they are not in the handoff, so the CTO adds them, following the design that already exists.** Agents is the fifth rail icon (`AGENTS_IN_RAIL = true`, already shipped by plan 213). Nodes needs no design for the MVP because cloud mode is after it.

**The rule this sets for every undesigned surface:** derive it from the handoff's own language and name which element each part copies. Never invent a second visual vocabulary. Plan 220 §3 already works this way (Runs borrows the Jobs page's 268px list plus detail, the Roster borrows the Plugins table, Settings borrows the two-column pattern), and plan 217's schedule dialog and plan 216's action dialogs do the same.

## 3. Three design revisions — DECIDED (CEO, 2026-09-03)

**Decision: layout and style copy the handoff exactly. The fields and data are ours. Where the handoff has no element for something we need, the CTO derives one from the handoff's own language.**

So Settings keeps the handoff's two-column layout, its 236px nav, its group headings and its three field shapes to the pixel, and renders this document's field list inside them. The same rule applies everywhere the two disagree.

| Handoff draws | Your decision that contradicts it | What ships instead |
|---|---|---|
| Scripts table with Latest, Versions, Published and an Enabled switch | scripts have no version and come only from plugins (MVP 03 §2) | Name, Plugin with a version chip, Params, Last run, Run |
| Jobs detail with no run selector | a job keeps every run (MVP 14) | a run picker in the detail header's meta line |
| Settings with about 40 fields including Scripts auto-update and version pinning | 15 visible plus 11 advanced (MVP 12) | the handoff's two-column layout, this document's field list |

A fourth was found while writing plan 217 and needs no decision, only your awareness: the workflow card's active/paused/draft badge is dropped, because the `workflows` table has no status column.

## 4. Feature scope confirmations

| Item | Proposed | Where |
|---|---|---|
| Cloud mode (control plane, nodes, enrollment) | after the MVP, not deleted; excluded from the definition of done | MVP 06 §4.1 |
| AI agents | kept in core, compacted to one page | MVP 06 §4.2, decided |
| Recordings | **deferred, confirmed by the CEO 2026-09-03**; code parked, not deleted, not in the nav | MVP 06 §4.3 |
| Workflows in the MVP | one device, sequential steps only | MVP 05 §4 |
| Live cast in the Screens grid | live at every card width | MVP 15 §4.3 |

## 5. Four small calls, in plain terms

The CEO asked what these were. They are not product questions; they are loose ends the plan authors refused to decide on their own. The CTO decides them here, and each is one line of work.

| # | In plain terms | Decision |
|---|---|---|
| 1 | **Which key is the shortcut key in Device Control?** Alt+H for Home, Alt+V to paste, and so on. On a Mac the natural choice is Cmd, but Cmd+A, Cmd+C and Cmd+V must reach the *phone*, not the browser | **Alt on every platform.** A user who wants Cmd can change it later; correctness first |
| 2 | **Two API routes nobody calls.** They let one AI agent grant another the right to spawn a child agent | **Delete the routes, keep the rule.** Corrected by the CTO after reading plan 220 §3.5: the enforcement is `canSpawn` in `agent/tree/store.ts`, checked by the `agent.spawn` capability in `agent/runner.ts`, and it is untouched by deleting the routes. An agent still may not spawn children by default. What goes is three HTTP endpoints no screen has ever called; `grantSpawn`/`revokeSpawn` stay in the store, ready to wire the day a screen needs them. The CTO's first answer, "give them a surface", was based on the wrong belief that the routes *were* the feature |
| 3 | **Where the "add a device by IP" dialog lives** now that its old page is gone | **On the Devices screen**, beside the Discovered sheet. It is a device action, not a setting |
| 4 | **One line in the guest agent's README disagrees with the toolchain manifest** about the APK's signing hash | **Trust the manifest, fix the README.** The manifest is what the code reads |

## 6. What needs no decision

The plan series is written and frozen: 25 documents, `docs/plans/200`–`224`, about 2.4 MB, each with a mechanically verifiable goal checklist, a removal table proven by grep, and a handoff report template. Execution order, parallelism and the testing policy are settled in plan 200 §8. Work can begin on wave 0 (plans 201, 202, 203, 204) without any of the answers above.
