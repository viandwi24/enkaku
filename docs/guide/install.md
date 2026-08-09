# Install guide

Enkaku manages every tool it needs itself (adb, scrcpy-server, the inspector APKs). **You do not need to install adb** or set up a PATH.

## 0. Portable binary (no Bun, no checkout)

Each GitHub Release ships one self-contained binary per platform — Studio, the
database migrations, and the example plugin packs are embedded, so nothing else
is needed:

```bash
# Linux server (also: darwin-arm64, darwin-x64, linux-arm64)
curl -LO https://github.com/OWNER/REPO/releases/latest/download/enkaku-vX.Y.Z-linux-x64.tar.gz
tar xzf enkaku-vX.Y.Z-linux-x64.tar.gz
./enkaku
# open http://localhost:7700
```

On Windows: download `enkaku-vX.Y.Z-windows-x64.zip`, extract, run `enkaku.exe`
(SmartScreen will warn about the unsigned binary — "More info" → "Run anyway").

To build the archives yourself: `bash scripts/build-release.sh` (all five
targets cross-compile from any host; artifacts land in `release/`).

### The bundled plugin packs

On its first run the binary stages the example packs it carries — `networking`
(a browser-driven leak and egress check) and `tiktok` (feed auto-scroll) — and
verifies each one. They arrive **staged, not active**: open Plugins in Studio
and press Activate on the ones you want, which is what writes their scripts
(`networking/leak-test`, `tiktok/auto-scroll`) into your Scripts list.

Removing a pack is permanent. The farm records what it has already seeded in
`<dataDir>/seeded-packs.json`, so a pack you delete does not come back on the
next restart; a pack whose version changed in a core upgrade arrives as a new
staged version alongside the one you are running.

## 1. Local (easiest)

```bash
bun install
bun run dev
# open http://localhost:7700
```

On first run the core downloads adb, scrcpy-server, and the inspector APKs, verifies their sha256, then activates them. Progress is visible in Studio as it happens (usually under a minute).

Because it binds to `127.0.0.1`, auth mode is automatically `local`: no login page, one implicit admin. That is safe precisely because nothing outside your machine can reach it.

## 2. Server / homelab (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin -G plugdev enkaku
sudo mkdir -p /opt/enkaku /var/lib/enkaku && sudo chown enkaku: /var/lib/enkaku
sudo cp deploy/enkaku.service /etc/systemd/system/
sudo systemctl enable --now enkaku
```

A non-loopback bind means `server` mode, which means **login is required and TLS is required**. Two options:

- Behind a reverse proxy (Caddy or nginx) that terminates TLS: `ENKAKU_TLS_MODE=external`.
- Your own certificate: `ENKAKU_TLS_MODE=self`, `ENKAKU_TLS_CERT=/path/cert.pem`, `ENKAKU_TLS_KEY=/path/key.pem`.

Open Studio and the setup page asks for the first admin's email and password. After that the setup endpoint closes permanently.

## 3. Docker

```bash
docker compose up -d
```

USB access from a container is awkward (it needs `--device /dev/bus/usb`, udev rules, and can fight the host over the adb server). **In containers, use wireless ADB**: enroll devices with a pairing code from Studio.

## Windows fleets (5 → 20+ devices)

A farm of USB-attached Android devices on Windows has a few behaviours worth
knowing about once you pass a handful of devices.

**"Port already in use" now names who is holding it.** If `enkaku.exe`
refuses to start with `EADDRINUSE` on its HTTP port, or `enkaku doctor` flags
a bind conflict, the message now includes the actual pid and process image
name holding that port (via `netstat -ano` + `tasklist`, both read-only, no
elevation needed) — for example `port 7700 is already held by pid 21440
(adb.exe), which is not an Enkaku core`. Before, Windows hosts got only
Bun's bare `Failed to start server. Is port 7700 in use?`, with no way to
find out *what* was in the way short of running `netstat` by hand. The same
lookup runs when the core's own data-directory lock is taken over as stale
(a leftover lock file from a process that no longer exists) — it now also
probes the port itself, so "the old process is gone" and "the port is free"
are answered as the two separate questions they actually are, instead of
proceeding into a listen failure with no explanation.

**Rescan.** Next to the Discovered tray in Studio is a **Rescan** button
(also `POST /api/devices/rescan`). It asks adb directly, right now, for
every device it can see and reconciles that against what Enkaku already
knows — adopting a device adb has but the registry does not, dropping one
that vanished, and nudging any device stuck `offline` toward recovery. This
already happens automatically every `discovery.scanIntervalSec` (10s by
default), so a phone plugged in *before* the core started, or one that got
stuck in Windows' `offline`/`authorizing` transition state while the adb
server was still enumerating USB, recovers within one scan interval without
a replug. Rescan exists for the moment you do not want to wait ten seconds —
it runs the identical pass immediately and shows the result as one line
("Scanned 5 devices · adopted 1 · nothing else changed").

**Settings worth raising past ~20 devices.** Most concurrency settings scale
themselves automatically with device count and do not need to be touched —
`adb.maxConcurrent` and `adb.maxStreams` both default to `0` (auto) and grow
with the fleet up to their own ceilings (24 and 64 respectively). What is
still worth reviewing on a large farm:

- `wall.maxTiles` / `session.maxIdleSessions` / `readiness.maxHot` (all
  default 8, max 64) — these cap how many devices the fleet Wall streams
  live at once, how many idle sessions the farm keeps warm, and how many
  devices may be held "hot" simultaneously. A farm past 20 devices that
  wants to see more than one Wall page live, or wants more than 8 devices to
  stay instantly responsive between viewer visits, should raise all three
  together (they default in lockstep on purpose).
- `adb.maxHostConcurrent` (default 4, max 32) — bounds the adb **CLI**
  processes (`install`/`push`/`forward`), which have no fleet-size
  autoscaler of their own. A farm that attaches inspectors to many devices
  at once may see these queue up; raising it trades USB/CPU headroom for
  faster fan-out.
- `adb.maxInstallConcurrent` (default 2, max 16) — how many APK
  installs/pushes may run at once across the whole farm, since they share
  one USB controller's bandwidth. Raise cautiously and watch install times —
  the bound exists because unbounded concurrent installs is what saturates
  USB on a fleet attaching many inspectors at once in the first place.

## adb endpoint (power users)

While you hold a device's lease, Studio's Terminal tab can lend you a real
`adb` endpoint for that device — not a re-implementation of `adb`, an actual
impersonation of `adbd` that your own local `adb` connects to. That gets you
everything a browser terminal cannot: `adb install`, `push`/`pull`, `logcat`
piped into your own tools, and attaching a debugger.

It is **off by default**, even on a loopback install — turn it on from
Settings → Device terminal → "Allow adb endpoint". Once enabled and while you
hold the lease, open the Terminal tab and use the "adb endpoint" card:

```bash
adb connect 127.0.0.1:<port>          # the exact command is copyable in Studio
adb -s 127.0.0.1:<port> shell getprop ro.serialno
adb -s 127.0.0.1:<port> install ./app.apk
adb -s 127.0.0.1:<port> push ./f.txt /data/local/tmp/
adb -s 127.0.0.1:<port> logcat        # Ctrl-C to stop
```

The endpoint exists only for the life of your lease: releasing control,
going idle for `shell.endpointIdleSec` (default 300s) with no connection, or
disconnecting closes it automatically, and every command it carries is
recorded to that device's Logs tab.

**`shell.endpointBind` defaults to `127.0.0.1` and that default is
deliberate.** Anything else (`0.0.0.0`, a LAN address) hands out full,
unauthenticated control of the device to anyone on that network who can
reach the port — the endpoint skips `adbd`'s own RSA key challenge entirely
(§3.4 of the plan explains why), relying instead on the lease, the
permission, and the loopback binding to keep it safe. Only widen the bind
address if you understand and accept that trade-off, on a network you
already trust.

## Environment variables

| Env | What it does |
|---|---|
| `ENKAKU_DATA_DIR` | Where the database, tools, and artifacts live |
| `ENKAKU_BIND` / `ENKAKU_PORT` | Bind address (this decides the auth mode) |
| `ENKAKU_AUTH_MODE` | `auto` (default) \| `local` \| `server` |
| `ENKAKU_TLS_MODE` | `off` \| `self` \| `external` |
| `ENKAKU_ALLOW_INSECURE=1` | Allow server mode without TLS — testing only |
| `ENKAKU_TOOLS_MANIFEST_URL` | An alternative tool manifest (internal mirror or air-gapped) |
| `ENKAKU_STUDIO_DIST` | Studio build location for single-origin mode |

## Troubleshooting

**A device shows up as `unauthorized`.** Check the phone's screen: there is an "Allow USB debugging" dialog. Tick "Always allow" and tap Allow. If the dialog never appears, unplug and replug the cable; if it still does not, go to Developer options → Revoke USB debugging authorizations, then plug in again.

**A device is not detected at all.** Make sure USB debugging is on and the cable carries data (many charging cables do not). On Linux, add a udev rule for your phone's vendor.

**Conflicts with Android Studio.** Android Studio runs its own adb server on port 5037. Enkaku uses that same adb server, so this is usually fine — but do not run `adb kill-server` by hand while the farm is working: it disconnects every device.

**Provisioning fails (no internet).** The core stays up; set up a manifest mirror and point `ENKAKU_TOOLS_MANIFEST_URL` at it, or copy an already-populated `tools/` folder into the data dir — the core adopts it at start.

**Windows: `EPERM: operation not permitted, rename ...\tools\.staging\...`.** A tool was downloaded and verified, but the move into `tools\` lost a race against something holding the file — usually Windows Defender scanning what was just written, sometimes the search indexer or a sync client. It is not a permissions problem, so running as Administrator does not help. The core retries and falls back to a copy, so this should no longer surface; if it still does, add an exclusion for the data dir (`%APPDATA%\Enkaku`) in Windows Security → Virus & threat protection → Exclusions, then reinstall the tool from the Tools page. Only adb blocks the boot — a device-side tool that fails to install leaves the farm running with that feature missing.
