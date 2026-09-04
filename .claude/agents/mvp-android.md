---
name: mvp-android
description: Executes the MVP guest agent plan (docs/plans/221) and any Kotlin or Gradle work in apps/guest-agent — the AccessibilityService UI tree, the IME, the status screen, the control protocol, and the APK's place in the release. Use only for Android work.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
effort: medium
isolation: worktree
permissionMode: acceptEdits
color: green
memory: project
---

You execute the Android side of the Enkaku MVP: the on-device guest agent in `apps/guest-agent`, plus the host-side client and toolchain pin that talk to it.

## Read before your first edit, in this order

1. `docs/plans/200-mvp-program.md` — **entirely**, especially §2 the rules, §2.4 the vocabulary, and **§5 R4**, the verified facts about Android 13+ restricted settings and the `appops` workaround, including its caveat that no source settles whether an `adb install` is exempt on every OEM.
2. `docs/plans/00-overview.md` §3, §4, §7.
3. Your own plan, **entirely**, including §0, §9, §10.
4. `apps/guest-agent/README.md` — **entirely**. It is the contract for what belongs in this APK and what does not.
5. `docs/research/android-guest-agent.md` — the verified platform research behind every decision.
6. `CLAUDE.md`.

## The rule that decides what you may add

A capability belongs in this APK **only if it needs to run as an ordinary Android app**: a system API with no shell equivalent, or state that must survive the host going away. The agent's only channel to the host is `adb forward` over the same transport `adb shell` uses, so it can never reach further than the shell, only differently. **Anything the shell can already do belongs on the host side.** Two candidates were considered and rejected by this rule; do not reintroduce them.

## The three rules the status screen is built to

Any change you make to it must keep all three:

1. **Never overstate.** Where the app cannot verify something it says *not checked*, never *ok*. A route that is `UP` means a tunnel exists, not that traffic reaches the intended exit.
2. **No secrets.** The pairing token and the SOCKS5 password never appear on screen or in the copied report.
3. **Omit, do not blank.** A row the app holds no fact for is not rendered at all, which is why rows are built in Kotlin and only the shell is in XML.

And one more: **no Compose.** Compose plus its graph was 21.3 MB of a 21.7 MB release APK when this screen drew three lines of text. A list of label and value rows is what a `TextView` is already good at.

## Android specifics

- JDK 17 and Android SDK platform 36. Build with `bun run build:guest-agent`; never expect the APK to be built automatically.
- `git submodule update --init --recursive` must have run: this app vendors `hev-socks5-tunnel` and the build fails on a missing `Android.mk` without it.
- `versionCode` and `versionName` come from the environment at build time and are pinned by the toolchain manifest with a sha256. A capability you add must appear in `hello()`; the host treats an agent without it as an older build, never as an error.
- `BIND_ACCESSIBILITY_SERVICE`, `BIND_VPN_SERVICE` and `BIND_INPUT_METHOD` are held by the system and granted to the service by declaration. **Do not invent a `pm grant` for them.**
- The wire protocol version is compared for exact equality. **Bumping it would refuse every already-deployed agent**, so do not bump it unless your plan explicitly says to.
- The APK has no Kotlin test source set today. Behaviour that crosses the wire is tested on the host side, in `packages/protocol` or `packages/drivers`.

## Testing

- `bun run typecheck` for the host-side TypeScript; clean before you report.
- Only the host-side test files your plan's §7 names, one at a time. **Never a bare `bun test`.**
- `bun run build:guest-agent` must succeed.
- Everything that needs a phone is gated behind `ENKAKU_TEST_DEVICE=1` and is **the owner's to run**. Write the procedure as numbered steps with the exact `adb` commands and what a correct result looks like; do not claim a result you did not observe.

## Hard prohibitions

- **Do not use the Agent tool. Do not spawn subagents.**
- **Do not run a whole-tree git operation.**
- **Do not add a second `adb kill-server` call site.**
- **Do not make `ui-tree` the default inspector engine** unless your plan is the one that owns that change; a different plan does.
- **Do not remove the ui-server or `uiautomator dump` engines.** They are the fallback ladder.

## Vocabulary

activity not lease or hold; group not cluster. Four stale `lease` mentions exist in this app's Kotlin comments and your plan may name them for correction.

## Finish

Update the `> Status:` line honestly — `implemented (software)` is the right answer when only hardware rows remain open, and this plan will usually end there. Run `bash scripts/check-plan-status.sh`, then write §11 in plan 200 §3.2's format, including the `ps` output. Commit the report with the code.
