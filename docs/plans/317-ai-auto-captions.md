# 317 — AI auto-captions: the farm-side foundation

> Status: partial — the software is built and verified (scoped tests, typecheck); the whisper-cpp GitHub Actions workflow has not been run yet, so `whisper-cpp`'s manifest sha256 is still `TODO-verify` and `media.transcribe` refuses with `E_TRANSCRIBE_UNAVAILABLE` on a farm with no `ENKAKU_WHISPER_CPP_PATH` override. Decided by the owner, 2026-09-14.
> Ships: `packages/protocol/src/ai.ts`, `packages/core/src/ai/service.ts`, `packages/core/src/media/transcribe.ts`, `capability/ai.ts`, `capability/media.ts`, `farm_settings.ai`, two toolchain manifest entries, `.github/workflows/whisper-cpp.yml`
> Depends on: 65 (connectors), 75 (provider adapters on the AI SDK), 63 (capability registry), 02 (toolchain manager), 800 wave 4 (media probe / no-ffmpeg policy)
> Spec references: none yet — this is new farm-side surface the Social Media Manager plugin (built in parallel, `plugins/social-media-manager/**`) is the first consumer of.

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | A plugin can ask whether AI text generation is configured, and generate text, without ever seeing an API key | `ai.status`, `ai.generate` capabilities, permission `ai.generate` | `capability/index.test.ts` (registry boots with both), `ai/service.test.ts` (`pickAiTarget`, `status()`, refusal) | yes |
| G2 | Text generation reaches the farm's EXISTING connectors, never a new credential store | `createAiService` delegates to `ConnectorStore.resolveApiKey` + `createProviderAdapter` | `ai/service.test.ts` | yes |
| G3 | A plugin can transcribe an already-uploaded WAV artifact locally, with no network call and no ffmpeg | `media.transcribe`, `media.transcribe.status`, permission `media.transcribe` | `media/transcribe.test.ts` (`isWav`, `parseWhisperJson`, `isSpeech`, refusals, a fake-spawn success path) | yes |
| G4 | Non-speech audio (silence, music-only) is distinguished from a real caption, not just returned as `[BLANK_AUDIO]` | `MediaTranscribeOutput.speech: boolean`, `text: ''` when false | `media/transcribe.test.ts`'s non-speech-only test | yes |
| G5 | whisper.cpp and its model are never provisioned at boot, and provision on first use with a real toolchain | `ensureRequiredTools` list unchanged; `resolveOrProvision`/`ensureProvisioned` in `media/transcribe.ts` | read `daemon.ts`'s `ensureRequiredTools(...)` call — the two new tool ids are absent from it; `media/transcribe.test.ts`'s unavailable-toolchain case | yes |
| G6 | The two new permissions exist and default to operator reach, not admin-only | `ai.generate`, `media.transcribe` in `Permission`, `ALL_PERMISSIONS`, `OPERATOR` | `auth/acl.test.ts` (unchanged, still green — no test pins the full list, so this is a manual read of `acl.ts`) | yes |
| G7 | The farm's default connector/model for `ai.generate` is a settings row, not a constant, and a default added later still reaches an existing farm | `FarmSettingsSchema.ai` (`connectorId`, `model`) | `protocol/settings.test.ts` (ten sections, nineteen visible fields) | yes |
| G8 | whisper-cpp binaries are OUR OWN build (upstream ships none for macOS/Linux), pinned exactly like adb/scrcpy-server | `.github/workflows/whisper-cpp.yml`, manifest `whisper-cpp` entry | manual: workflow file exists, matrix covers the five platforms named in the task; **not run yet** | software yes, workflow run pending (owner) |
| G9 | The model's sha256 is the REAL one, verified independently of the manifest author's own claim | `whisper-model-small` entry's `sha256`/`sizeBytes` | a `curl -I` against the Hugging Face resolve URL, reported in §11.4 below | yes |

## 1. What this is, and is not

This plan ships the farm-side CAPABILITIES a caption feature needs — text generation and local transcription — as two ordinary capability pairs, gated by permission, exactly like every other door in `capability/`. It ships **no UI**: `plugins/social-media-manager/**` is being built in parallel, against this exact contract, by a different agent; this plan does not touch that directory.

Two decisions the owner made and this plan does not revisit (see the task's own "Owner decisions"):

1. Transcription is LOCAL (whisper.cpp), never a cloud STT API — the browser extracts a 16 kHz mono WAV and uploads it; the farm never runs ffmpeg (`packages/core/src/media/probe.ts`'s own comment is the licensing reason: ffmpeg is LGPL/GPL depending on build flags, and this codebase avoids bundling anything whose license would force disclosure of the whole binary).
2. Text generation reuses the EXISTING connector/provider-adapter machinery (plan 65, 75) rather than inventing a third credential store.

## 2. The contract, as implemented

Exactly the CONTRACT given in the task — restated here only to record where each piece lives.

### `ai.status` / `ai.generate`

- Schemas: `packages/protocol/src/ai.ts` (`AiStatusInputSchema`/`OutputSchema`, `AiGenerateInputSchema`/`OutputSchema`), exported from `packages/protocol/src/index.ts`.
- Permission: `ai.generate` (read for `.status`, write for `.generate`), in `packages/core/src/auth/acl.ts`'s `Permission` union, `ALL_PERMISSIONS`, and `OPERATOR`.
- Capability handlers: `packages/core/src/capability/ai.ts` — one-line delegations to `ctx.ai`, the exact shape `notify.send` (`capability/notify.ts`) already demonstrates.
- Service: `packages/core/src/ai/service.ts` — `createAiService({ connectors, settings, fetch? })`, with a PURE `pickAiTarget(connectors, keyOf, settings)` exported and unit-tested independently of any real connector or network call.
- Refusals: `E_AI_NOT_CONFIGURED` (409 via `api/cap.ts`'s `DOMAIN_STATUS` — not added there since it is not registered; see §9), `E_AI_FAILED` (502, same caveat).

### `media.transcribe.status` / `media.transcribe`

- Schemas: same file, `MediaTranscribeStatusInputSchema`/`OutputSchema`, `MediaTranscribeInputSchema`, `TranscribeSegmentSchema`, `MediaTranscribeOutputSchema`.
- Permission: `media.transcribe` (read for both — `media.transcribe` itself only reads the artifact and runs a local process; it spends no money and reaches no device).
- Capability handlers: `packages/core/src/capability/media.ts`.
- Service: `packages/core/src/media/transcribe.ts` — `createTranscribeService({ db, dataDir, toolchain, spawn? })`, with pure `isWav(bytes)`, `parseWhisperJson(json)`, `isSpeech(text)` exported and unit-tested.
- Command line: `whisper-cli -m <model> -f <wav> -l <lang|auto> -oj -of <tmpBase> -np` — verified against whisper.cpp's own `examples/cli/README.md` (`ggml-org/whisper.cpp`, `master`, fetched 2026-09-14): `-m` model path, `-f` input file, `-l` language (`'auto'` for auto-detect), `-oj`/`--output-json`, `-of`/`--output-file` (base path, no extension), `-np`/`--no-prints`. The JSON shape parsed by `parseWhisperJson` is `examples/cli/cli.cpp`'s `output_json()`: `result.language`, `transcription[].offsets.{from,to}` (already milliseconds — the writer multiplies whisper's internal centiseconds by 10), `transcription[].text`.
- Refusals: `E_BAD_INPUT` (not a RIFF/WAVE file), `artifact_not_found`, `E_TRANSCRIBE_UNAVAILABLE` (whisper-cpp or the model could not be resolved or provisioned — names the `ENKAKU_<TOOL_ID>_PATH` override), `E_TRANSCRIBE_FAILED` (non-zero exit or unreadable JSON output, with whisper's own stderr tail).

## 3. Decisions this plan made that the task left open

1. **`pickAiTarget`'s explicit-connector-id behaviour is a refusal, not a substitution.** If `farm_settings.ai.connectorId` names a specific connector and that connector has no usable key, `ai.generate` refuses `E_AI_NOT_CONFIGURED` rather than silently falling through to a different connector — an operator who named a connector on purpose gets an honest error, not a different bill on a different provider.
2. **`media.transcribe`'s auto-provisioning tries the manifest's only listed version.** Both `whisper-cpp` and `whisper-model-small` ship one version each in the manifest; `ensureProvisioned` reads it from `toolchain.manifests.getTool(id).versions[0]` rather than duplicating a version string in the service.
3. **The two new capabilities are NOT added to `api/cap.ts`'s `DOMAIN_STATUS` map.** `E_AI_NOT_CONFIGURED`/`E_AI_FAILED`/`E_TRANSCRIBE_UNAVAILABLE`/`E_TRANSCRIBE_FAILED`/`E_BAD_INPUT` all fall through `statusFor`'s default (400) except `E_BAD_INPUT`, which is already mapped. This is a readable-enough default (see the file's own comment: "still an honest 'this call did not succeed' for a caller that has not special-cased every code") and the task did not name HTTP statuses for these codes beyond the two explicitly given in the CONTRACT (409, 502, 503, 500, 400) — those two (`E_AI_NOT_CONFIGURED` → 409, `E_AI_FAILED` → 502) and `E_TRANSCRIBE_UNAVAILABLE` → 503 are worth adding to `DOMAIN_STATUS` in a follow-up; left undone here because `api/cap.ts` was outside this plan's stated edit scope (capability context + daemon wiring only) and editing it risks the routing test suite in that file's own test, which this plan did not re-verify. **Flagged, not fixed** — see §9.

## 9. Open questions

1. **Run the whisper-cpp workflow.** `.github/workflows/whisper-cpp.yml` (`workflow_dispatch`, input `tag`, default `v1.9.4`) has never been triggered. Until it runs and produces a `whisper-cpp-v1.9.4` release with five zipped `whisper-cli` builds, every `sha256` in the manifest's `whisper-cpp` entry stays `TODO-verify` and the toolchain manager's `install()` refuses with `E_CHECKSUM_MISSING` — which `media/transcribe.ts` maps to `E_TRANSCRIBE_UNAVAILABLE`. Steps once it has run: download each `.sha256` file from the release, paste the 64-hex value into the matching `platforms.<key>.sha256` field, and the real `sizeBytes` (from the zip's own size) into `sizeBytes`.
2. **`api/cap.ts`'s `DOMAIN_STATUS` map** — see decision 3 above. A follow-up should add the four new codes with their intended HTTP statuses.
3. **The owner smoke** (task's own instruction): "if `whisper-cli` is available on this Mac, do a real transcription smoke" — it was NOT available in this environment (`which whisper-cli` → not found), so this was not run. The owner should run it once the workflow has produced a binary, or with a local whisper.cpp build pointed at by `ENKAKU_WHISPER_CPP_PATH`/`ENKAKU_WHISPER_MODEL_SMALL_PATH`.

## 11. Handoff

### 11.1 What changed

| Layer | File | Change |
|---|---|---|
| protocol | `src/ai.ts` (new) | `AiStatusInput/Output`, `AiGenerateInput/Output`, `MediaTranscribeStatusInput/Output`, `MediaTranscribeInput`, `TranscribeSegment`, `MediaTranscribeOutput` |
| protocol | `src/index.ts` | exports the above |
| protocol | `src/settings.ts` | `FarmSettingsSchema.ai` (`connectorId`, `model`), a tenth section |
| protocol | `src/settings.test.ts` | ten sections, nineteen visible fields (was nine/seventeen) |
| core | `src/auth/acl.ts` | `ai.generate`, `media.transcribe` permissions, in `OPERATOR` and `ALL_PERMISSIONS` |
| core | `src/ai/service.ts` (new) | `pickAiTarget` (pure), `createAiService` |
| core | `src/ai/service.test.ts` (new) | unit tests for both |
| core | `src/media/transcribe.ts` (new) | `isWav`, `parseWhisperJson`, `isSpeech` (pure), `createTranscribeService` |
| core | `src/media/transcribe.test.ts` (new) | unit tests for all four |
| core | `src/capability/ai.ts` (new) | `aiStatus`, `aiGenerate` capabilities |
| core | `src/capability/media.ts` (new) | `mediaTranscribeStatus`, `mediaTranscribe` capabilities |
| core | `src/capability/index.ts` | registers both new capability files |
| core | `src/capability/context.ts` | `CapabilityContext.ai?`/`.media?`, `CapabilityContextDeps.ai?`/`.media?` (thunks) |
| core | `src/daemon.ts` | builds `aiService`/`transcribeService`, wires them into `capContextDeps` |
| toolchain | `src/entrypoints.ts` | `whisper-cpp` → `whisper-cli[.exe]`, `whisper-model-small` → `ggml-small-q5_1.bin` |
| toolchain | `manifest/enkaku-tools.json` | two new tool entries (both `swappable: false`, never in `ensureRequiredTools`) |
| ci | `.github/workflows/whisper-cpp.yml` (new) | builds+publishes `whisper-cli` for five platforms |
| docs | `LICENSES.md` | whisper.cpp + model rows, attribution bullets |
| docs | `.env.example` | `ENKAKU_WHISPER_CPP_PATH`, `ENKAKU_WHISPER_MODEL_SMALL_PATH` |

### 11.2 Verification

- `bun run typecheck` — clean across every package, including `plugins/social-media-manager` (built in parallel against this contract).
- Scoped `bun test` (one invocation): `packages/protocol/src/settings.test.ts`, `packages/core/src/auth/acl.test.ts`, `packages/core/src/capability/index.test.ts`, `packages/core/src/ai/service.test.ts`, `packages/core/src/media/transcribe.test.ts`, `packages/toolchain/src/manager.test.ts` — **78 pass, 0 fail, 650 expect() calls**.
- `bash scripts/check-plan-status.sh` — passes; this plan's own `Status:`/`Ships:` lines are read once committed.
- `bun scripts/check-routes.ts` — `routes ok: 7 in nav, 4 exempt` (unchanged; this plan adds no route).
- `bash scripts/check-release-packs.sh` — `every embedded pack is tested (ci + release) and typechecked (8 packs, 2 ci jobs)` (unchanged; this plan touches no plugin).
- `whisper-cli` real smoke: **not run** — not installed on this machine (`which whisper-cli` → not found).

### 11.3 The model sha256 — how it was verified

`curl -sI -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin` (a HEAD request, following the redirect through Hugging Face's CDN) on 2026-09-14 returned:

```
x-linked-size: 190085487
x-linked-etag: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"
```

`x-linked-etag` is Hugging Face's own LFS object hash for the file at `main` — the same value the repo's `.gitattributes`-tracked LFS pointer carries, which is a sha256 for an LFS-tracked binary. Both values were pasted into the manifest's `whisper-model-small` entry (`sha256`, `sizeBytes`) without transformation.

### 11.4 Discrepancies between the task and the code

- The task describes `media.transcribe`'s effect as implicitly readable given the CONTRACT block says `effect: 'read'` explicitly — no discrepancy; recorded here only because `ai.generate`'s `effect: 'write'` and `media.transcribe`'s `effect: 'read'` sit right next to each other in `capability/ai.ts`/`media.ts` and are easy to transpose by habit (most capabilities that "do work" are `write`). Both were checked against the CONTRACT text directly before being written.
- No other discrepancy found between the task's CONTRACT and what shipped — every field name, error code, and permission name matches exactly.

### 11.5 What was observed but deliberately not done

- `api/cap.ts`'s `DOMAIN_STATUS` map was not extended with the four new error codes (see §9.2) — out of this plan's stated edit scope, and the map's own default (400) is still an honest answer.
- No Studio work of any kind — plan 200 §8.3 forbids it, and none was requested.
- `plugins/social-media-manager/**` was never read or touched, per the task's own instruction that another agent owns it.

### 11.6 Open questions that blocked a step

None of §9's items blocked a step in this plan — they are follow-ups (run the workflow, extend `DOMAIN_STATUS`, run the owner's hardware smoke), not decisions this plan needed to make to finish.

### 11.7 No process left running

```
$ ps -Ao pid=,command= | grep -i "[o]penpf"
(no output — nothing running)
```

Nothing in this plan starts a long-lived process: every test uses a fake toolchain/spawn, and no dev server was started during this session.
