# 318 — Speech management: whisper.cpp, its models, and a doctor

> Status: partial — the software is built and verified (scoped tests, typecheck, every gate, a real run of the doctor against the owner's Homebrew whisper-cli and the dev farm's small model); the owner smoke of the Studio panel on a restarted core is still open. Asked for by the owner, 2026-09-14.
> Ships: `packages/studio/src/components/settings/SpeechPanel.tsx`, `packages/core/src/media/transcribe.ts` (`check()`), `media.transcribe.check`, `farm_settings.ai.whisperCliPath`/`whisperModel`, three model manifest entries, `POST /api/tools/:id/deactivate`
> Depends on: 317 (transcription foundation), 02 (toolchain manager), 63 (capability registry), 219 (Settings page), 403 (AndroidSdkPanel, the precedent for a dedicated host-tool panel)
> Spec references: none — farm-side surface added after the MVP spec.

## 0. Goal checklist

| # | Goal | Parameter | Verified by | Done |
|---|---|---|---|---|
| G1 | An operator can point Enkaku at their own whisper-cli, and a path that does not run is refused by the setting's name — never silently skipped | `ai.whisperCliPath`; resolution setting → `ENKAKU_WHISPER_CPP_PATH` → managed tool | `transcribe.test.ts` (bad setting wins over a working managed CLI; env then managed) | yes |
| G2 | Four multilingual models, each pinned to its real sha256 and size | `whisper-model-{tiny,base,small,medium}` | `manager.test.ts` (swappable, raw, 64-hex sha, size, no `.en`); §11.3 HEAD requests | yes |
| G3 | The model is a setting, and only the SELECTED model ever downloads on its own | `ai.whisperModel` (default `small`); `provisionInBackground([modelId])` | `transcribe.test.ts` (installs == `['whisper-model-base']` only) | yes |
| G4 | Install, activate and uninstall go through the existing tool routes | whisper tools `swappable: true`; `POST /api/tools/:id/deactivate` so a one-version model can be deleted | `manager.test.ts` deactivate → remove; `routes.test.ts` unchanged, green | yes |
| G5 | whisper-cli's health is a real run, not a file test | `checkWhisperCli` (`--help`, 10 s) in `manager.check()`/`activate()` | `health.test.ts` (5 cases on fake scripts); live: `usage: /opt/homebrew/bin/whisper-cli [options] file0 file1 ...` | yes |
| G6 | A doctor proves CLI + model + a real transcription work together, and downloads nothing | `media.transcribe.check` (read, 120 s) | `transcribe.test.ts` (all-ok, missing CLI, bad sha); live run §11.2 | yes |
| G7 | `media.transcribe.status` tells a UI everything it needs, additively | `cli`, `modelId`, `models[]`, `provisioning`; `available`/`model`/`reason` unchanged | typecheck (the SMM plugin still compiles against it); live output §11.2 | yes |
| G8 | One page to manage it all, where the SMM plugin can link | `SpeechPanel` under the AI form, `/settings?tab=ai` | typecheck, `build:studio`; owner smoke pending | software yes, smoke pending |

## 1. The request

"Isn't there a dedicated page to manage Whisper — like adb or the Android SDK have — where I can install, download, uninstall, point at a CLI path, run a doctor/check, etc.?" — the owner, 2026-09-14. Plan 317 shipped the capability with exactly one knob (an env var) and a tool list that refused every whisper action (`swappable: false`).

## 3. Decisions

1. **The panel lives under the AI form, at `/settings?tab=ai`** (placement decided by the parent session; the Social Media Manager links there as "Manage speech & AI"). The two whisper fields are removed from that section's generic form in Studio (`withoutSpeechFields`, `app/settings/page.tsx`) so one value never has two editors on one screen; they remain ordinary settings fields in the schema.
2. **A set `whisperCliPath` wins and is never skipped.** If it is not an executable file, transcription is unavailable and the reason names the setting, even when a managed CLI exists. An operator who typed a path meant that binary.
3. **Resolution order: setting → `ENKAKU_WHISPER_CPP_PATH` → managed.** The env var's meaning is unchanged except that the setting now outranks it; `.env.example` says so.
4. **The whisper tools become `swappable: true`.** Nothing else assumed a non-swappable tool is boot-managed for them: they were never in `REQUIRED_TOOLS`/`ensureRequiredTools`, and `ToolchainSection`'s "Pinned to the core version" card no longer lists them (they now render as ordinary version cards, with a hint pointing at Settings → AI and, for `whisper-cpp`, "No verified build is pinned for this host yet").
5. **`deactivate` is a new manager method and route**, not a relaxation of `remove`'s active-version guard. A model has one version and is active the moment it is installed, so without it nothing could ever be uninstalled. It refuses adb and every version-locked tool (`E_DEACTIVATE_REFUSED`, 403) and is audited as `tool.deactivate`.
6. **Status says at once what cannot be downloaded.** With no whisper-cli and no pinned build for the host (today's reality), `status()` no longer claims "Downloading whisper.cpp"; it names Homebrew and the setting. The selected model still downloads meanwhile.
7. **The doctor never provisions.** A check that starts a 540 MB download is not a check. Steps: `cli-found`, `cli-runs`, `model` (the toolchain's sha256 check; an env-override model is only checked for existence), `transcribe` (1 s of generated 16 kHz mono silence, 90 s kill), `timing`. `ok` is false exactly when a step failed; a step after a failure is `skip`, never `ok`.
8. **Whisper hearing words in silence is not a failure.** The live run heard "you" in one second of zeros — a known Whisper hallucination on silence. The step stays `ok` and says so; exit 0 plus readable JSON is what proves the pipeline.
9. **`checkFileHash` streams** (a medium model is 540 MB and was read whole to hash it) and its success detail is now English (`sha256 matches`, was `sha256 cocok`).
10. **No migration.** `farm_settings` is a JSON row; the two new keys are defaults added later, so they reach existing farms. The `ai` object default was widened to the full object because Zod 4 returns a `.default()` value as-is.

## 9. Open questions

1. **Owner smoke** — restart the dev core, open `/settings?tab=ai`, set the CLI path to `/opt/homebrew/bin/whisper-cli`, install `tiny`, switch to it, Run check, uninstall it.
2. **The managed whisper-cpp build** — still plan 317 §9 item 1 (run `.github/workflows/whisper-cpp.yml`, pin five sha256s). Until then the panel's note tells the operator to use Homebrew.
3. **Download progress for a background provision** — the panel polls status every 3 s while `provisioning` is true and shows per-model progress from `tool.install.progress`; an install started from the panel reports percent, a status-triggered one only shows "downloading".

## 11. Handoff

### 11.1 What changed

| Layer | File | Change |
|---|---|---|
| protocol | `src/settings.ts` | `WHISPER_MODEL_NAMES`, `WhisperModelNameSchema`; `ai.whisperCliPath`, `ai.whisperModel`; full `ai` default |
| protocol | `src/settings.test.ts` | twenty-one visible fields (was nineteen) |
| protocol | `src/ai.ts`, `src/index.ts` | status output `cli`/`modelId`/`models`/`provisioning`; `MediaTranscribeCheckInput/Output`, `TranscribeCheckStep`, `WhisperCliSource`, `WhisperModelEntry` |
| toolchain | `manifest/enkaku-tools.json` | `whisper-model-tiny`/`-base`/`-medium` added; all whisper tools `swappable: true` |
| toolchain | `src/entrypoints.ts` | four model filenames |
| toolchain | `src/health.ts` (+ new `health.test.ts`) | `checkWhisperCli`; streamed `checkFileHash`, English detail |
| toolchain | `src/manager.ts`, `src/errors.ts`, `src/index.ts` | `healthFor` (adb, whisper-cpp, by format); `deactivate()`; `E_DEACTIVATE_REFUSED`; export `checkWhisperCli` |
| toolchain | `src/manager.test.ts` | whisper manifest test; deactivate → remove test |
| core | `src/media/transcribe.ts` (+ test) | settings/env resolution, extended status, selected-model-only provisioning, `silentWav`, `check()` |
| core | `src/capability/media.ts`, `capability/index.test.ts` | `media.transcribe.check` |
| core | `src/tools/routes.ts`, `src/auth/audit.ts` | `POST /api/tools/:id/deactivate`, `tool.deactivate` |
| core | `src/daemon.ts` | transcribe service reads `settingsStore.get().ai` |
| studio | `components/settings/SpeechPanel.tsx` (new) | status rows, CLI path, model picker with install/uninstall/use, Run check |
| studio | `app/settings/page.tsx` | mounts `SpeechPanel` in the `ai` section; strips its two fields from the form |
| studio | `components/settings/ToolchainSection.tsx` | no-pinned-build hint; pointer to Settings → AI for whisper tools |
| docs | `.env.example`, `317-ai-auto-captions.md` §9 | resolution order; pointer to this plan |

No `api/cap.ts` change: the doctor reports failures as steps, and the codes it can throw (`E_NOT_SUPPORTED`) are already mapped.

### 11.2 Verification

- `bun run typecheck` — every package OK, including `social-media-manager`.
- One scoped `bun test`: `media/transcribe.test.ts`, `protocol/settings.test.ts`, `toolchain/health.test.ts`, `toolchain/manager.test.ts`, `capability/index.test.ts`, `tools/routes.test.ts` — **107 pass, 0 fail, 740 expect() calls**.
- `bun scripts/check-design-tokens.ts` — ok (no icon added). `bun scripts/check-routes.ts` — `routes ok: 7 in nav, 4 exempt`. `bash scripts/check-release-packs.sh` — ok (8 packs). `bun scripts/check-agent-docs.ts` — ok. `bun run build:studio` — ok.
- **Live, on the owner's Mac** (a read-only script: a `ToolchainManager` over `.dev-data` with no `init()`, settings `{ whisperCliPath: '/opt/homebrew/bin/whisper-cli', whisperModel: 'small' }`): `status()` → `available: true`, `cli: { source: 'setting', detail: null }`, small installed and active; `check()` → `ok: true`, all five steps `ok` — `sha256 matches`, `exit 0, heard "you" in silence…`, `522 ms for 1 s of audio with the small model, including model load`.
- The running dev core was NOT restarted (it runs the pre-318 build), so `media.transcribe.check` over HTTP returns 404 there until it is.

### 11.3 The model sha256s — how each was verified

`curl -sI -L https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<file>` on 2026-09-14; the 302 response carries Hugging Face's LFS object headers, pasted without transformation:

| Tool | File | `x-linked-etag` (sha256) | `x-linked-size` |
|---|---|---|---|
| `whisper-model-tiny` | `ggml-tiny-q5_1.bin` | `818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7` | 32152673 |
| `whisper-model-base` | `ggml-base-q5_1.bin` | `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898` | 59707625 |
| `whisper-model-small` | `ggml-small-q5_1.bin` | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` (unchanged from 317) | 190085487 |
| `whisper-model-medium` | `ggml-medium-q5_0.bin` | `19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f` | 539212467 |

`small` was additionally proven end to end: the dev farm's installed file passed `checkFileHash` against that value in the live run above. The other three were not downloaded in this session; `downloadVerified` refuses a mismatch at install.

### 11.4 Open

See §9: the owner smoke on a restarted core, and the managed whisper-cpp build (plan 317 §9.1).
