# MVP 09 — Additional scope proposed by the CTO

> Status: proposed 2026-09-03 in answer to the CEO's question "what else should we improve and finalise in this MVP".
> These items were observed while researching documents 01–08 and were not raised by investors or clients. Ranked by how early a client would notice them.

---

## 1. Spec reset

`docs/spec.md` is 220 KB, `docs/plans/` holds 129 milestone plans, and the repo rule is that the spec wins over the code. After the rebuild decided in documents 03–08, most of §10, §11, §19 and parts of §7 will contradict the shipped product, and any contributor or agent following the rule will reintroduce what was removed.

Proposal: write a new, compact `docs/spec.md` from the decisions in this directory once they are final; move the current spec and every plan to `docs/archive/` as history, referenced but not authoritative; keep `docs/design.md` and update it with the CEO's new UI design. The MVP documents then become plans under `docs/plans/` again, numbered from 200, each with the "Removed" section the README requires.

## 2. Device lifecycle reliability

Every field incident found today lives in this layer: the five-minute ghost holder (04 §1.3), leaked `adb forward`s (02 §2.7 F20), five concurrent `stream.start` triggering two unbounded installs per device and a restart cascade (02 §2.7 H5), the instrumentation that never starts on API 36 (02 §0), a 22 s worst case to open the video socket (01 §1.1).

Proposal: one plan with measured targets on the lab device and the owner's farm:

| Metric | Target |
|---|---|
| USB plug to first painted frame | under 5 s warm, under 20 s on first provisioning |
| USB unplug and replug to recovered stream | under 5 s, no operator action |
| adb child processes and forwards after 24 h of use | equal to the count at boot |
| Concurrent installs per USB root | serialised, never more than one |
| Wall of 20 tiles, all live, for 1 h | zero decoder rebuilds except on rotation, zero session restarts |

## 3. One honest vocabulary for status and errors

Plan 129 found an error that reported a 5 ms connection refusal as a 20 s timeout, and spec §7.9 already has to insist that `unverified` is never worded as success. Today each subsystem invents its own states and codes.

Proposal: one table in `@enkaku/protocol` of device states (03 §0 and 04 §1.1), activity states, job states, and error codes with the sentence each is allowed to render, validated by Zod at every boundary. A status word never appears in the UI unless it is in the table. `docs/design.md`'s writing rules reference the table instead of restating it.

## 4. First run and packaging

- The release workflow does not build or pin the guest agent APK (plan 43 §5.11 still open), so a released core cannot install the agent it depends on for the network layer and the IME text path.
- The desktop app (`apps/desktop`, Tauri) wraps the same web stack; whether the MVP ships as a single binary plus a browser, or as the desktop app, is undecided.
- Target: a client installs and sees the first device in under five minutes without reading the guide. `bun run doctor` becomes the first screen, not a CLI.

Proposal: decide the packaging (CTO recommendation: single binary plus browser for the MVP, desktop app after), finish plan 43 §5.11, and make provisioning progress the first thing Studio shows on a fresh install.

## 5. Test strategy reset

Studio has about 170 isolated test processes taking 80 s per run, which is why `CLAUDE.md` forbids full-suite runs and records an overheating incident. The rebuild is the moment to change the shape rather than the rules:

- **Decided 2026-09-03 (CEO):** Studio and `@enkaku/ui` have zero tests; the whole web suite and its DOM toolchain are deleted in plan 201. Backend tests exist only for the critical list in plan 200 §8.3 (protocol schemas and framing, policy and resolvers, migrations, queue and runs, demuxer and HID encoders, the plugin pipeline, the inspector lifecycle, toolchain verification). UI verification is typecheck, the design handoff, and an owner smoke at each wave gate.
- One hardware smoke suite on the lab device, run by a self-hosted CI runner on every merge to main, replacing the `ENKAKU_TEST_DEVICE=1` gate that CI never exercises.
- A full suite under two minutes on a laptop is the acceptance criterion; the "never run a full suite" rule is retired when it is met.

## 6. Data retention

Jobs, logs, trace frames, UI captures, artifacts, recordings, and audit rows grow without bound; the only control is a manual "Clear history". A 20-device farm with scheduled jobs fills a disk in weeks.

Proposal: retention settings per kind with defaults (jobs and logs 30 days, trace frames 7 days, artifacts 30 days or a size cap, audit 90 days), a nightly sweeper, and a Storage row in Settings showing usage per kind.

## 7. A scale number the MVP promises

Spec §16 says 10–15 devices per N100 host; the wall's decode ceiling of 24 tiles is a documented placeholder that was never measured (01 §1.2). Clients ask for one number.

Proposal (amended after MVP 11): the CEO's stated target is **100 devices per host, all sessions always on**. Measure in two steps: first the owner's 20-device farm (20 live wall tiles, 20 concurrent script jobs, one Device Control session, one hour, CPU, memory, and the latency overlay from 01 recorded), then a 100-device run on the lab host with the USB topology documented. The number goes into the README and the sales material only after it is measured; until then the promise is the measured one.

## 8. Deliberately not proposed for the MVP

Internationalisation of the UI, richer multi-role authorisation, cloud mode (06 §4.1), mirror (06 §1), a native desktop client (01 §5).
