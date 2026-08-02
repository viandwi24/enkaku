# Enkaku (openpf)

A device farm platform for remote control and automation of Android phones — self-hosted, zero-config. Full spec: [`docs/spec.md`](docs/spec.md); the sequential work plan: [`docs/plans/`](docs/plans/).

## Running it (dev)

```bash
bun install
bun run dev
# open http://localhost:7700
```

You do not need to install adb: on first run the core downloads adb, scrcpy-server, and the inspector APKs, verifies their sha256, and activates them itself (about 15 seconds). Dev data lives in `.dev-data/` inside the project folder, so nothing leaks into your system.

### Commands

| Command | What it does |
|---|---|
| `bun run dev` | Core in local mode plus Studio (if built) on `:7700` |
| `bun run dev:studio` | Studio with hot reload on `:3001`, pointing at the core on `:7700` |
| `bun run build:studio` | Build Studio so the core can serve it (single origin) |
| `bun run dev:cloud` | Core in orchestrator mode (control plane, no local devices) |
| `bun run dev:agent` | Cloud-mode agent (needs `ENKAKU_CP_URL`) |
| `bun run dev:desktop` | The Tauri desktop app (needs Rust) |
| `bun run publish:example` | Publish the example script to the local farm |
| `bun run typecheck` | Typecheck every package |
| `bun run reset` | Delete all dev data |

### Trying each flow

**Remote control and automation (local mode).** Run `bun run dev`, plug in a phone with USB debugging enabled, then open `http://localhost:7700`. To work on the UI with hot reload, run `bun run dev:studio` in a second terminal and open `:3001`.

**Running a script.** With the core up: `bun run publish:example`, then open the Scripts page in Studio and press Run. The example scripts are in `examples/`.

**Cloud mode (two terminals).**

```bash
# terminal 1 — the control plane
bun run dev:cloud

# create an enrollment token (once)
curl -s -X POST localhost:7700/api/agents \
  -H 'content-type: application/json' -d '{"name":"my-agent"}'

# terminal 2 — the agent, on the machine the phones are plugged into
ENKAKU_CP_URL=http://localhost:7700 ENKAKU_ENROLL_TOKEN=<token> bun run dev:agent
```

The token is needed only once; after that `bun run dev:agent` is enough. Full guide: [`docs/guide/cloud.md`](docs/guide/cloud.md).

**Desktop app.** Needs Rust. `ENKAKU_CORE_BIN=<path to core> bun run dev:desktop`.

Full install guide and troubleshooting: [`docs/guide/install.md`](docs/guide/install.md).

## Package map

| Package | Contents |
|---|---|
| `packages/protocol` | Zod envelope and messages for Core⇄Studio, driver types, binary framing, the tunnel protocol |
| `packages/adb` | adb smartsocket client, `track-devices`, per-device queue plus a semaphore |
| `packages/toolchain` | Tool provisioning: manifest, download with mandatory sha256, versions, active pointer |
| `packages/drivers` | Four engine layers: adb transport, screencap/scrcpy display, adb/UHID/SDK input, dump/ui-server inspector |
| `packages/scrcpy` | The version-locked scrcpy protocol client: H.264 demuxer, control messages, absolute HID pointer |
| `packages/sdk` | `@enkaku/sdk` — `defineScript` plus the `enkaku publish` CLI |
| `packages/core` | The Bun + Hono daemon: registry, queue/lease, runner, auth/ACL, API and WS |
| `packages/studio` | The Next.js web UI: dashboard, live control, scripts, jobs, tools, settings |
| `packages/agent` | The cloud mini-core: enrollment plus an outbound tunnel (M8a) |
| `examples/` | Example automation scripts (mirroring a script author's project) |
