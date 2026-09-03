# Decisions waiting on the CEO

> Compiled 2026-09-03 after the MVP plan series (`docs/plans/200`–`224`) was written. Every item below blocks or shapes work that is otherwise ready to start. Nothing here is urgent today; all of it is needed before the wave that owns it begins.

## 1. The lab device — blocks the most

**Ask:** one Android 16 (API 36) device dedicated to the lab, not the production farm.

**Why:** nine plans carry checklist rows marked `owner` that cannot be closed without it. The owner's 20-device farm is a sealed OTG box where a disconnect costs a hardware teardown, so it cannot be experimented on.

**What it unblocks:** the latency measurement (203), whether openatx 2.4.0 runs on API 36 at all (208 — this closes a question open since plan 129), accessibility enablement from adb (221), the inspector's push `waitFor` timing (222), and every scale and soak number (223).

## 2. Where Agents lives

**Ask:** a fifth icon in the rail, or the first entry of the dynamic plugin menu.

**Context:** the design handoff draws no Agents screen at all. Plan 213 ships `AGENTS_IN_RAIL = true` as one row of data, so either answer is a one-line change; the question is product placement, not engineering.

**CTO recommendation:** the fifth rail icon. Agents are a first-class surface, and burying them under the plugin menu makes them look optional.

## 3. Three design revisions the decisions force

The handoff draws these three things; your own decisions make them impossible. Each needs your confirmation that the design changes, not the decision.

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
| Recordings | deferred; code parked, not deleted | MVP 06 §4.3, decided |
| Workflows in the MVP | one device, sequential steps only | MVP 05 §4 |
| Live cast in the Screens grid | live at every card width | MVP 15 §4.3 |

## 5. Smaller calls the plans left open

| Question | Recommendation | Plan |
|---|---|---|
| Hotkey modifier in Device Control | Alt on every platform. Cmd on macOS would swallow Cmd+A, Cmd+C and Cmd+V, which are three of the acceptance behaviours | 215 §9 |
| Control over control (two people on one device) | allow, marker only, no dialog | decided, MVP 04 §1.3 |
| `spawn-grants` routes with no client | give them a surface on the Agents page or delete them | 220 |
| Where `EnrollmentDialog` lives | Devices or Settings | 214 §9, 216 §9 |
| The guest agent's signature sha256 contradiction | one line in the APK README disagrees with the toolchain manifest | 221 §9 |

## 6. What needs no decision

The plan series is written and frozen: 25 documents, `docs/plans/200`–`224`, about 2.4 MB, each with a mechanically verifiable goal checklist, a removal table proven by grep, and a handoff report template. Execution order, parallelism and the testing policy are settled in plan 200 §8. Work can begin on wave 0 (plans 201, 202, 203, 204) without any of the answers above.
