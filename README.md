# Enkaku (openpf)

A device farm platform for remote control and automation of Android phones — self-hosted, zero-config. Full spec: [`docs/spec.md`](docs/spec.md); the sequential work plan: [`docs/plans/`](docs/plans/).

## Running it (prebuilt binary)

Each [GitHub Release](https://github.com/viandwi24/enkaku/releases) ships one self-contained binary per platform — Studio, the database migrations, and the example plugin packs are embedded, so nothing else is needed. No Bun, no checkout.

```bash
curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh
enkaku
# open http://localhost:7700
```

The installer picks the build for your platform (linux/darwin × x64/arm64), verifies it
against the release's `SHA256SUMS.txt`, installs it into `~/.enkaku/bin` and puts that on
PATH. Pass options through `sh -s --`:

```bash
curl -fsSL .../install.sh | sh -s -- --version v0.1.30       # a specific release
curl -fsSL .../install.sh | sh -s -- --dir /usr/local/bin    # somewhere else
curl -fsSL .../install.sh | sh -s -- --no-modify-path        # leave shell rc files alone
```

Or download an archive by hand from the [Releases page](https://github.com/viandwi24/enkaku/releases):

```bash
# Resolve the latest tag the same way install.sh does, or set it by hand —
# the Releases page lists every one.
VERSION=$(curl -fsSL https://api.github.com/repos/viandwi24/enkaku/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
curl -LO "https://github.com/viandwi24/enkaku/releases/download/$VERSION/enkaku-$VERSION-linux-x64.tar.gz"
tar xzf "enkaku-$VERSION-linux-x64.tar.gz"
./enkaku
```

On Windows: download `enkaku-<version>-windows-x64.zip` from the same release, extract, run `enkaku.exe` (SmartScreen will warn about the unsigned binary — "More info" → "Run anyway"). The installer works under Git Bash too.

Full install guide, including the systemd service and Docker: [`docs/guide/install.md`](docs/guide/install.md).

## Running it (dev)

```bash
git submodule update --init --recursive   # the guest agent vendors hev-socks5-tunnel
bun install
bun run dev
# open http://localhost:7700
```

You do not need to install adb: on first run the core downloads adb, scrcpy-server, and the inspector APKs, verifies their sha256, and activates them itself (about 15 seconds). Dev data lives in `.dev-data/` inside the project folder, so nothing leaks into your system.

### Configuration

Everything is optional — `bun run dev` works with no configuration at all. To change something, copy the template and edit:

```bash
cp .env.example .env
```

Bun loads that file automatically for anything it runs as code: the core, the cloud node, and the scripts. No dotenv package, no import. A real shell variable still wins over it (`ENKAKU_LOG_LEVEL=debug bun run dev`), matching the documented env > file > default precedence.

**One place it does not reach, and it is worth knowing before it costs you an hour:** Bun does not expand `.env` inside `package.json` script strings. `dev:studio` resolves `${NEXT_PUBLIC_ENKAKU_CORE_URL:-…}` in a shell that never saw the root file, so a value set there is silently ignored. Studio's own variables live in `packages/studio/.env`, which Next.js loads itself — see `packages/studio/.env.example`.

Both `.env` files are gitignored; both `.env.example` files are committed and are the reference for every variable the code reads.

### Toolchains

Bun is the only thing needed for the core, Studio, the SDK, and the cloud node — which is nearly everything. Two apps carry their own toolchain, and you only need it if you are working on that app:

| Toolchain | Needed for | Install |
|---|---|---|
| **Bun** ≥ 1.3 | everything under `packages/`, `examples/` | [bun.sh](https://bun.sh) |
| **Rust** (stable) | `apps/desktop` — the Tauri shell | [rustup.rs](https://rustup.rs) |
| **JDK 17** + **Android CLI** | `apps/guest-agent` — the on-device APK | `brew install openjdk@17`, then `brew tap android/tap && brew install --cask android-cli` |

JDK 17 is the minimum *and* the default for AGP 9; newer JDKs are not a drop-in substitute. The Android SDK itself is installed by the Android CLI (`android sdk install`), which also owns the project scaffolding — see [`apps/guest-agent/README.md`](apps/guest-agent/README.md).

### Commands

| Command | What it does |
|---|---|
| `bun run dev` | Core in local mode plus Studio (if built) on `:7700` |
| `bun run dev:studio` | Studio with hot reload on `:3001`, pointing at the core on `:7700` |
| `bun run build:studio` | Build Studio so the core can serve it (single origin) |
| `bun run dev:cloud` | Core in orchestrator mode (control plane, no local devices) |
| `bun run dev:node` | Cloud-mode node (needs `ENKAKU_CP_URL`) |
| `bun run dev:desktop` | The Tauri desktop app (needs Rust) |
| `bun run build:guest-agent` | Build the on-device guest agent APK (needs JDK 17 plus the Android SDK) |
| `bun run smoke:guest-agent -- --serial <S>` | Device smoke test for the guest agent (needs `ENKAKU_TEST_DEVICE=1` plus a real phone) |
| `bun run publish:example` | Publish the example script to the local farm |
| `bun run doctor` | Check the environment — toolchain integrity, adb reachability, egress |
| `bun run typecheck` | Typecheck every package |
| `bun test` | Run the test suite (`*.test.ts`, colocated in `src/`) |
| `bun run reset` | Delete all dev data |

Tests that need a physical device are gated behind `ENKAKU_TEST_DEVICE=1`, so `bun test` is safe with nothing plugged in.

### Trying each flow

**Remote control and automation (local mode).** Run `bun run dev`, plug in a phone with USB debugging enabled, then open `http://localhost:7700`. To work on the UI with hot reload, run `bun run dev:studio` in a second terminal and open `:3001`.

**Running a script.** With the core up: `bun run publish:example`, then open the Scripts page in Studio and press Run. The example scripts are in `examples/`.

**Cloud mode (two terminals).**

```bash
# terminal 1 — the control plane
bun run dev:cloud

# create an enrollment token (once)
curl -s -X POST localhost:7700/api/nodes \
  -H 'content-type: application/json' -d '{"name":"my-node"}'

# terminal 2 — the node, on the machine the phones are plugged into
ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=<token> bun run dev:node
```

The token is needed only once; after that `bun run dev:node` is enough. Full guide: [`docs/guide/cloud.md`](docs/guide/cloud.md).

### CI

`.github/workflows/ci.yml` runs `bun run typecheck` and `bun test` on every push and pull request, plus a path-conditional job that builds the guest agent APK when `apps/guest-agent/**` changes. It never touches a physical device — see below.

### Guest agent smoke test

`scripts/smoke-guest-agent.ts` drives one real phone through the guest agent's install, bootstrap, token-rotation, routing, and uninstall lifecycle over adb, asserting on what the device reports. It exists because the six defects it checks for were all found by hand on hardware and none of them showed up in `bun test` (docs/archive/plans/50-m24a-ci-and-device-smoke-test.md).

```bash
ENKAKU_TEST_DEVICE=1 bun run smoke:guest-agent -- --serial <SERIAL>
```

`--serial` is required — with more than one device attached, nothing is guessed. Set `ENKAKU_SMOKE_PROXY=socks5://user:pass@host:port` to also exercise the routing stages (skipped with a clear message otherwise). Never run in CI: GitHub runners have no phone. See [`apps/guest-agent/README.md`](apps/guest-agent/README.md#driving-it-without-studio) for details.

**Desktop app.** Needs Rust. `ENKAKU_CORE_BIN=<path to core> bun run dev:desktop`.

**Guest agent and the device proxy.** The guest agent is an APK the core installs on a farm device; its first capability is a SOCKS5 **full tunnel** that apps under test cannot bypass — which is what `settings put global http_proxy` can never give you.

```bash
bun run build:guest-agent      # once; needs JDK 17 and the Android SDK
bun run dev                    # the local build is picked up automatically
```

Then take control of a device in Studio (install and routing are lease-gated) and open **Guest Agents**: install the agent, then set the upstream.

Full install guide and troubleshooting: [`docs/guide/install.md`](docs/guide/install.md).

## Package map

| Package | Contents |
|---|---|
| `packages/protocol` | Zod envelope and messages for Core⇄Studio, driver types, binary framing, the tunnel protocol |
| `packages/adb` | adb smartsocket client, `track-devices`, per-device queue plus a semaphore |
| `packages/toolchain` | Tool provisioning: manifest, download with mandatory sha256, versions, active pointer |
| `packages/drivers` | Five engine layers: adb transport, screencap/scrcpy display, adb/UHID/SDK input, dump/ui-server inspector, guest-agent network route |
| `packages/scrcpy` | The version-locked scrcpy protocol client: H.264 demuxer, control messages, absolute HID pointer |
| `packages/sdk` | `@enkaku/sdk` — `definePlugin` plus the `enkaku init` / `publish` / `dev` CLI |
| `packages/core` | The Bun + Hono daemon: registry, queue/lease, runner, auth/ACL, API and WS |
| `packages/studio` | The Next.js web UI: dashboard, live control, scripts, jobs, clusters, schedules, topology, guest agents, tools, settings |
| `packages/node` | The cloud mini-core: enrollment plus an outbound tunnel (M8a) |
| `apps/desktop` | The Tauri desktop shell (Rust): native window, tray, the core as a child process |
| `apps/guest-agent` | The on-device helper APK (Kotlin): a `localabstract` control channel, and the SOCKS5 route the `vpn-helper` engine drives |
| `examples/` | Example automation scripts (mirroring a script author's project) |

## Developer notes

The traps that cost the most time, in rough order of how often they bite. The full rule list is in [`CLAUDE.md`](CLAUDE.md).

**After cloning, run `git submodule update --init --recursive`.** The guest agent vendors `hev-socks5-tunnel` (MIT) and its own nested submodules; without them the Android build fails with a confusing missing-`Android.mk` error.

**Run `bun run typecheck`, never `bun run scripts/typecheck.sh`.** Bun misreads the shebang and tries to execute the shell script as JavaScript. `bash scripts/typecheck.sh` works too.

**There are two TypeScript versions on purpose.** The root uses TypeScript 7 with `tsconfig.base.json`; `packages/studio` is deliberately standalone on TypeScript 5 with a tsconfig that does *not* extend the base, because Next needs the TS 5 compiler API. Do not "unify" them.

**`adb kill-server` is forbidden** outside the Toolchain Manager's adb swap. Port 5037 is shared with Android Studio, and killing it takes their session down with yours.

**The guest agent APK resolves in three tiers**, first match wins: `ENKAKU_GUEST_AGENT_PATH`, then a local Gradle build under `apps/guest-agent/app/build/outputs/apk/`, then the sha256-pinned artifact downloaded by the Toolchain Manager. Tier 2 is why `bun run dev` needs no configuration in a checkout, and it cannot fire on a deployed server, which has no `apps/` directory. It is never auto-built — Gradle needs a JDK and the Android SDK and takes minutes, so a missing APK fails with instructions instead.

**In Studio, internal links must use `next/link`.** A plain `<a>` triggers a full document navigation that remounts React, drops the WebSocket, and kills the live video stream.

**Tailwind v4 colour classes are written `bg-surface`, never `bg-[--color-surface]`.** The v3 bracket form compiles to nothing and fails silently. See [`docs/design.md`](docs/design.md).

**Studio dev on `:3001` needs no build.** Do not run `bun run build:studio` while `next dev` is running — `next build` writes into `.next` regardless of `distDir` and corrupts the dev server. The build script refuses and says so.
