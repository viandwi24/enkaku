# Install guide

Enkaku manages every tool it needs itself (adb, scrcpy-server, the inspector APKs). **You do not need to install adb** or set up a PATH.

## 0. Portable binary (no Bun, no checkout)

Each GitHub Release ships one self-contained binary per platform — Studio and
the database migrations are embedded, so nothing else is needed:

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
