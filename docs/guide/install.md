# Install guide

Enkaku manages every tool it needs itself (adb, scrcpy-server, the inspector APKs). **You do not need to install adb** or set up a PATH.

## 0. One-line install (no Bun, no checkout)

Each GitHub Release ships one self-contained binary per platform — Studio, the
database migrations, and the example plugin packs are embedded, so nothing else
is needed. An install script fetches the right one.

On **Linux and macOS** (and Windows under Git Bash):

```bash
curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh
enkaku
# open http://localhost:7700
```

On **Windows**, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/viandwi24/enkaku/main/install.ps1 | iex
enkaku
```

There are two scripts rather than one because native PowerShell and `cmd` have
no `sh` to pipe into — the shell one-liner cannot run there at all. `install.sh`
does cover Windows under Git Bash / MSYS / Cygwin, where `uname` reports
`MINGW*`/`MSYS*`/`CYGWIN*`; `install.ps1` is for everyone else on Windows.

`install.sh` detects your platform (`linux`/`darwin` × `x64`/`arm64`), downloads
that archive from the latest release, **verifies it against the release's
`SHA256SUMS.txt` and refuses to install on a mismatch**, then puts the binary in
`~/.enkaku/bin` and adds that directory to your PATH. `curl` and `tar` are the
only requirements; `jq` is used when present and not needed when it is absent.

`install.ps1` does the same with `Invoke-WebRequest`, `Get-FileHash` and
`Expand-Archive` — all built in, nothing to install first. It writes to
`%USERPROFILE%\.enkaku\bin` and appends to the **user** PATH (never the machine
one), so it never needs an elevated prompt. The release builds `windows-x64`
only; Windows on ARM gets that build and runs it under emulation, which the
script says out loud rather than silently.

Because it is piped into `sh`, options go through `sh -s --`:

```bash
# a specific release, including a downgrade
curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh -s -- --version v0.1.30
# install somewhere else (a directory you can write to)
curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh -s -- --dir /usr/local/bin
# leave every shell rc file untouched — you manage PATH yourself
curl -fsSL https://raw.githubusercontent.com/viandwi24/enkaku/main/install.sh | sh -s -- --no-modify-path
```

The same values are also readable from the environment (`ENKAKU_VERSION`,
`ENKAKU_INSTALL_DIR`, `ENKAKU_OS`, `ENKAKU_ARCH`, and `ENKAKU_REPO` for a fork),
which is what you want from a provisioning script or a Dockerfile.

`irm | iex` cannot pass parameters at all, so on Windows the environment is the
way in (`ENKAKU_NO_MODIFY_PATH=1` stands in for `--no-modify-path`):

```powershell
$env:ENKAKU_VERSION = 'v0.1.30'
$env:ENKAKU_INSTALL_DIR = 'C:\enkaku'
irm https://raw.githubusercontent.com/viandwi24/enkaku/main/install.ps1 | iex
```

Saved to a file, `install.ps1` also takes them as ordinary parameters:
`.\install.ps1 -Version v0.1.30 -Dir C:\enkaku -NoModifyPath`.

Three things it does on purpose:

- **The PATH line is written once.** It is added only when the install directory
  is not already on PATH, only to the rc file your `$SHELL` actually reads, and
  it is marked, so re-running the installer never leaves a second copy behind.
- **The old binary is kept** at `<binary>.bak` when you re-run it over an
  existing install.
- **It replaces the binary with a rename, not a copy** — copying over a running
  executable fails on Linux with `ETXTBSY` ("Text file busy"), which is exactly
  what re-running an installer on a live farm would hit. A running core keeps
  its own open inode and carries on **on the old version until you restart it**.
  `install.ps1` moves the old binary aside for the same reason: Windows refuses
  to overwrite a running `.exe` but does allow renaming one.

It also drops `enkaku-update.sh` next to the binary, so [updating](#updating) is
already set up.

If you would rather read the archive URL yourself, the Releases page lists every
tag:

```bash
# Resolve the latest tag the same way install.sh does, or set it by hand —
# the Releases page lists every one.
VERSION=$(curl -fsSL https://api.github.com/repos/viandwi24/enkaku/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4)
curl -LO "https://github.com/viandwi24/enkaku/releases/download/$VERSION/enkaku-$VERSION-linux-x64.tar.gz"
tar xzf "enkaku-$VERSION-linux-x64.tar.gz"
./enkaku
```

On Windows the archive is `enkaku-<version>-windows-x64.zip` — extract it and run `enkaku.exe`
(SmartScreen will warn about the unsigned binary — "More info" → "Run anyway"). `install.ps1`
above does all of that for you, checksum included.

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
- A certificate Enkaku manages: `ENKAKU_TLS_MODE=self` **and nothing else**. On the first start it generates a
  self-signed pair into `<dataDir>/tls/self-signed.crt` and `.key`, loads it, and reuses that same pair on every later
  start — it only regenerates when the file is missing, unreadable, or within 30 days of expiry. It needs `openssl` on
  `PATH` (present on macOS and every mainstream Linux); if it is missing, the error prints the exact command to run and
  the two variables to set. **A self-signed certificate encrypts the connection and proves no identity**, so every
  browser warns on first visit — right for a trusted LAN, wrong for anything reachable from the internet, which is what
  `external` above is for.
- Your own certificate: `ENKAKU_TLS_MODE=self`, `ENKAKU_TLS_CERT=/path/cert.pem`, `ENKAKU_TLS_KEY=/path/key.pem`. Set
  both or neither — one alone is refused at boot.

Open Studio and the setup page asks for the first admin's email and password. After that the setup endpoint closes permanently.

### Upgrading an already-deployed unit file (Restart Enkaku, plan 120)

Studio's Tools page has a **Restart Enkaku** button — the whole core process, not just the adb server — for when a plugin or code change on disk isn't taking effect and the instinct is "just restart it." Under systemd it works by exiting a distinct code (`75`) that the unit declares as a voluntary, non-crash restart request. **If you deployed `enkaku.service` before this feature shipped, add these two lines to your already-installed unit file** — without them, clicking Restart Enkaku exits the process and systemd does **not** bring it back (a plain `exit(0)`/non-declared exit code is either ignored or misreported as a crash), leaving the farm down until someone notices:

```bash
sudo systemctl edit --full enkaku
# Add, right after `RestartSec=5`:
#   SuccessExitStatus=75
#   RestartForceExitStatus=75
sudo systemctl daemon-reload
sudo systemctl restart enkaku
```

Or simply re-copy the current `deploy/enkaku.service` from this repo over `/etc/systemd/system/enkaku.service` and run the same `daemon-reload`/`restart` — it already has both lines.

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

## Farm networks and scanning for devices

Any device Enkaku reaches over the network — Wi-Fi debugging, or a wired OTG
chassis — is more useful once you tell Enkaku what your network actually
looks like. **Settings → Discovery & monitoring → Farm networks** is one list of
CIDR ranges, each with a label, a medium (**wired** or **wireless**), and
whether it should be included in a scan:

```
10.20.0.0/24    Chassis A     wired      scan: on
192.168.1.0/24  Office Wi-Fi  wireless   scan: off
```

This one list is *designed* to feed two separate things, though only one is
wired up as shipped (see the callout below):

- **Badges.** A device whose address falls inside a listed network is meant
  to show as **OTG** or **WI-FI** — matching that network's medium — instead
  of the honest-but-vague **TCP** badge ("on the network, medium unknown").
  **Not yet true in practice:** as shipped, every network device reads TCP
  regardless of what you configure here; the badge does not read the network
  list back yet. Configure it anyway — the second bullet already works, and
  the badge will start reflecting it without any further action once that
  wiring lands.
- **The scan's address space.** Only networks with **scan: on** are ever
  probed, and only when you explicitly ask — pressing **Scan network** next
  to the Discovered tray's Rescan button, or `POST /api/devices/scan`. There
  is no automatic, timer-driven network scan, and no setting turns one on:
  Enkaku only scans when a person asks it to.

**What a scan does.** For every scanned network, Enkaku sends a cheap TCP
probe (300 ms timeout by default) to each address, skipping anything adb
already knows about. Only addresses that actually answer get a real `adb
connect` attempt. Results are reported as one line — *"Scanned 254 addresses
on Chassis A · 21 answered · 1 new phone in Discovered"* — and the whole
pass is capped at `scan.maxAddresses` (1024 by default, i.e. four `/24`
networks) across everything you have ticked. Trying to save a network list
that adds up to more than the cap is rejected at save time, naming both
numbers, rather than failing partway through a scan at 2 a.m.

**What a scan does not do.** It never enrols a device — a phone a scan finds
that nobody has admitted lands in the **Discovered** tray, exactly like a
newly plugged-in USB phone, and waits for a person to name it and add it.
It never touches an address outside the networks you have ticked; your host
machine's own subnets are deliberately *not* auto-detected, so a laptop on a
corporate `/16` cannot accidentally trigger a 65,536-address sweep by
pressing one button. And it never runs unless you (or, once the guided OTG
cutover ships, an actively armed cutover window) ask it to.

**Before scanning a shared or corporate network**, clear it with whoever
owns that network first. A subnet sweep — even a small, bounded one — can
look like reconnaissance to a firewall or an intrusion-detection system.
Setting `discovery.scan.mode` to `off` disables scanning entirely, including
from any future guided flow, while leaving the address book and the
automatic reconnect-from-last-known-address behaviour untouched — most
farms that only ever add and remove devices by hand at the chassis do not
need scanning turned on at all.

## Egress binding: one proxy per way out

This is a recipe, not a product feature description — it lives here because the mechanism it
depends on is entirely at the operating-system level, and nothing in Enkaku or the
`proxy-manager` plugin pack sets it up for you. If your host only ever reaches the internet one
way, skip this section; it has nothing to offer you.

**The idea.** Some hosts have more than one way out — a second NIC, a USB LTE dongle, several
addresses on the same interface each policy-routed to a different upstream. If your host's own
addresses are already wired to distinct physical or logical paths, `proxy-manager`'s `direct`
upstream can bind a proxy to any one of them: create a record, set `Upstream protocol` to
**Direct** (no vendor account, no upstream host or port), and fill in `Bind address` with one of
your host's own addresses. Every connection that record's listener carries leaves the machine
bound to that address (`net.connect({ localAddress })` and nothing more exotic), so if that
address maps to link A, the connection goes out link A. Twenty such records, one per address, is
what "one proxy per way out" means. The **range generator** on the Catalogue tab writes several of
these at once from a label pattern, a starting port, and a starting address — with a preview of
every row before anything is saved.

**What Enkaku does and does not do here.** The plugin reads `os.networkInterfaces()` to check that
an address you named actually exists on the host before it will start a listener on it
(`E_PROXY_BIND_ADDRESS_UNAVAILABLE` if it does not) — that is the entire extent of its interest in
your network. It never writes a route, a VLAN, an interface, or a firewall rule, on this host or on
any router. Making a host address actually lead out a particular physical path is **entirely your
job**, done once, in whatever your infrastructure already is: a second NIC with its own default
gateway, IP aliases on one NIC paired with source-based routing rules, separate VRFs, or a router's
own policy routing keyed on the host's source address. `proxy-manager` has no opinion on which of
these you use and no code path that could — see "Why this stays generic" below.

### Adding extra addresses to a host

**Linux — an IP alias on an existing interface:**

```bash
sudo ip addr add 192.0.2.11/24 dev eth0        # add
ip addr show dev eth0                          # confirm it is there
sudo ip addr del 192.0.2.11/24 dev eth0        # remove
```

This survives until reboot; make it permanent with your distribution's normal interface
configuration (`netplan`, `systemd-networkd`, `NetworkManager`, or a distro-specific
`interfaces` file — whichever one already manages `eth0` on this host). If each address needs to
leave by a different upstream, pair the alias with a source-based routing rule
(`ip rule add from 192.0.2.11 table <n>`, `ip route add default via <gateway> table <n>`) or give
it its own physical NIC instead — either is a normal Linux networking setup with nothing
Enkaku-specific about it.

**Windows — an additional IP on an existing adapter:**

```powershell
netsh interface ipv4 add address name="Ethernet" addr=192.0.2.11 mask=255.255.255.0
netsh interface ipv4 show addresses name="Ethernet"   # confirm
netsh interface ipv4 delete address name="Ethernet" addr=192.0.2.11
```

(Or Settings → Network & Internet → your adapter → Edit IP settings → add another manual address.)
As on Linux, making a specific address route out a specific path beyond the default gateway needs
your own routing configuration — Windows supports per-route metrics and `route add` with a source
address, but the exact setup depends entirely on your topology.

### Audit by counting, not by trusting a pasted block

However you configure the host-to-link mapping, **verify it by counting afterward**, not by
trusting that a pasted block of commands ran the way it looked like it would. A command block
pasted into a router or shell terminal can silently drop its first line — this happened twice in
one real farm build-out, caught only because every stage ended in a count that was supposed to
match the number of links and didn't. See finding #2 in
[`docs/archive/tmp-try-arch-mikrotik.md`](../archive/tmp-try-arch-mikrotik.md) for the incident. After any change,
re-list the addresses/routes/rules you expect and count them — twenty links should show twenty
entries in whatever list proves the mapping exists, every time, not just the first time you set it
up.

`docs/archive/tmp-try-arch-mikrotik.md` is one operator's own worked log of doing exactly this for a farm
of twenty LTE modems behind a MikroTik router and switch, including the bug that setup hit and how
it was found and fixed — it is linked here as a real example to read, not as a config to copy. No
first-party document, including this one, describes any particular router, VLAN scheme, or modem
model; the recipe above is deliberately generic so it applies equally to two NICs on a workstation
and to twenty modems on a rack.

### Why this stays generic

`proxy-manager` never reads a router and never writes one (no vendor client, no rule polling, no
credential store for infrastructure that isn't a phone or a proxy). Two reasons, not one: writing
router configuration is exactly where a silently-dropped line goes unnoticed, so it should be
applied by a person who then audits it themselves; and the pack's own egress probe — the public
address actually observed dialling out through a record — already answers the question that
matters more than a router's route-health flag ever could, which is *which address does this path
actually come out of*, not merely *does the gateway answer a ping*. A record that has not passed
that probe reads `unverified` on the Catalogue tab, never as if it had.

## The guest agent

Every device you admit gets a small first-party helper app (`enkaku-guest-agent`) installed automatically — not only devices you route through a proxy. It carries the enforcing network route, the physical screen label, the on-device keyboard for non-ASCII text, and mock GPS, in one package. You never install it by hand; the core does it at admission, re-checks it on every reconnect, and repairs it if it drifts.

**What "the agent failed to install" means, and what still works anyway.** Open a device's **Agent** tab to see its state. A `failed` state carries the exact reason (never a vague error) and is deliberately **not treated as a device fault**: it never quarantines the device, never blocks it, and never changes scheduling. A device with a failed or absent agent still streams video, takes input, runs jobs, and answers a shell exactly as before — only the four agent-backed facets above are unavailable, and each says so as a named, fixable precondition (e.g. "install the guest agent to type Japanese") rather than a red error.

**Why it might fail on a fresh, from-a-release install.** Until the project owner publishes a signed guest-agent release and pins its checksum in the toolchain manifest, the on-device APK cannot be verified, so provisioning fails closed with a state naming `E_CHECKSUM_MISSING` — deliberately, rather than installing something unverified. This is expected on a released binary today, not a bug in your setup. Two ways around it while that is pending:

- Set `ENKAKU_GUEST_AGENT_PATH` to point at a `.apk` you trust.
- Run from a checkout with a local Gradle build present (`bun run build:guest-agent`, see `apps/guest-agent/README.md`) — the core picks that up automatically in dev, with a warning that it is doing so.

**How to fix a failed install once a real release exists.** Check the reason shown on the Agent tab first — most causes are transient (a busy USB bus, a device that briefly went offline mid-install) and clear on the next automatic reconnect pass. To force a retry immediately, press **Retry** on the device's Agent tab, or **Provision all** on Settings → Guest agent for the whole fleet (`POST /api/guest-agent/provision`). If the reason names a checksum or signature mismatch instead, that is a farm-wide configuration problem, not a per-device one — it means the toolchain manifest's pinned hash does not match what was actually installed, and no amount of retrying one device fixes it.

Provisioning can also be turned off or made manual farm-wide from Settings → Guest agent (`guestAgent.provision`: `auto` (default) / `manual` / `off`) — `manual` installs only when you press a button; `off` reproduces the original behaviour, where only applying a network route ever installs the agent.

## Assisting a running job

A script's lease is exclusive — while a job runs, ordinary input is refused. **Assist** is the narrow exception: it lets you tap, swipe, type, and press keys on a device a job is still driving, without taking the job's control away from it. Use it for the moment a script gets stuck behind something it cannot see past — a permission dialog, an update prompt, a captcha — rather than cancelling the job and starting over.

Open the device page for a device running a job. A banner names the running script and offers **Assist**. Confirming it does **not** pause the job, does **not** take its lease, and does **not** change the device's status — the job keeps running exactly as it was, and everything you do lands on the same screen at the same time as whatever the script is doing. The canvas border turns amber with a persistent **Assisting — the job still has control** label and a countdown while you are connected.

Assisting stops on its own after 5 minutes with no input from you (or immediately if you click **Stop assisting**, if the job finishes, or if the job's lease is otherwise taken over). Only one person may assist a given device at a time by default — a second person trying is told who already has it.

**Everything you do while assisting is on the record.** The job's own detail page gets an **Assisted by** card listing each action, who did it, and when; `jobs.assistCount` badges the job list so an assisted run is never mistaken for one that succeeded entirely on its own; and Settings → Audit gets a `device.assist` row naming the job for both the start and the end of your session. A script can react to being assisted if its author wrote it to — most scripts do not, and run identically whether or not anyone ever assists them.

Two switches control who may do this at all: Settings → **Assisting** (`coControl.mode`) is `off` / `admin` / `operator` (default) farm-wide, and a script's own author can mark it un-assistable, which disables the button on its jobs with a tooltip naming the script.

## Controlling many devices

The Wall (`/?view=wall`) can drive several phones from one set of taps instead of one at a time — useful for confirming the same in-app dialog, or walking a fleet through the same few screens, without scripting it.

Turn on **Select devices** and check the ones you want; a small badge follows your cursor showing how many are selected. **Double-click** one of the selected tiles to open a focus panel over the Wall — the phone underneath is still live, still visible on its own tile (now reading **Controlling here**), and every other tile keeps streaming behind the panel. If that device is idle, control opens immediately; if it is running a job or held by someone else, you go through the same Assist confirmation described above.

Turn on **Mirror** in the panel's side rail. You are shown exactly what you are about to do — how many of the selected devices are free (you take control of them), how many are running jobs or held by someone else (you assist those; their jobs or holders keep control), and how many are left out and why (offline, mid-install). Confirm, and every tap, swipe, key press, or typed character you send goes to all of them at once, landing at the same place on each screen regardless of resolution — because the position is sent as a fraction of the screen, not a pixel.

**Two things are worth knowing before you rely on this.** First, a device whose screen is rotated differently from the one you are looking at is skipped for taps and swipes — landing a fractional position on a portrait phone and a landscape one does not put it on the same button, so Enkaku refuses rather than guessing; that device's tile says so by name, and a key press or typed text still reaches it (a keycode has no orientation to disagree about). Second, **you are driving many phones by sight, not by proof** — if one device has drifted onto a different screen than the rest, a tap that dismisses a dialog on nineteen phones can do something else entirely on the twentieth. Every member keeps its own live tile precisely so you can see that happening; hold **Alt** (or flip **Focused only** in the rail) to send your next action to only the device you are looking at.

Nothing you send through Mirror is ever silent: the rail shows a running `ok/total` count after every action, and clicking it names exactly which devices did not receive it and why. A device that fails three actions in a row leaves the group on its own, with a message naming it. Closing the panel ends the mirror group and stops it driving any device.

Mirror deliberately does **not** carry a shell command, a clipboard paste, or a reboot to every selected device — those are bulk operations, not an input verb, and are refused here structurally rather than by convention. Installing an APK across many devices already has its own path today (**Install on selected**, on the devices list, which reports success/failure per device); a fan-out shell command now has its own path too — the fleet command console below, gated by its own opt-in — but a bulk clipboard paste or reboot still does not, and Mirror is not it.

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

## Fleet commands (bulk adb)

The device Terminal already lets a lease holder run one `adb shell` command
on the one device they hold. Settings → Device terminal → **"Allow fleet
commands"** is a *separate* opt-in that lets an operator type one command
once and send it to a selection, a cluster, a tag set, or the whole farm —
each device runs it independently and reports its own exit code, stdout,
and stderr, and any device that could not run it (offline, held by someone
else, running a job) is named in the report with the reason, never silently
dropped.

**This is a security default, not a preference, and it follows the exact
same instinct as the rest of this guide's TLS section above.** Auth mode is
derived from the bind address: a non-loopback bind means server mode, and
server mode means login and TLS are required whether you want them or not
(§2, above) — the Zod settings schema cannot see the bind address, so that
override happens at config load, not as a default value. `shell.fanoutEnabled`
gets the identical treatment: it defaults to `true` on a loopback install
(a single-user laptop farm gets the feature with no discovery step, the
same way `shell.mode` itself defaults to `'admin'` there) and is forced to
`false` in server mode by `createFarmSettingsStore`, alongside `shell.mode`
itself being forced to `'off'`. **A fresh server-mode install therefore
ships with both the terminal and fleet commands off**, and turning fleet
commands on is a deliberate act an admin takes from Settings, not a bug you
work around or a step the installer forgot.

Turning it on does not, by itself, widen who may run what: `POST
/api/command-runs` still requires the same role and the same `shell.mode`
gate a single-device command already needs, still refuses a device someone
else is controlling (naming them, never taking it over), and still asks for
an explicit typed confirmation — worded as a scale confirmation, not a
security judgement — before running a command the built-in guard recognises
as high-consequence (`pm uninstall`, `pm clear`, and similar) against more
than one device at once. `shell.fanoutMaxDevices` (Settings → Device
terminal → Fleet commands, default unlimited) is the separate knob for
capping how large a single fan-out may be, independent of turning the
feature on at all.

**As of this release, the fleet command console itself
(`/console` in Studio) and bulk file push/pull are built and gated this
way; the fleet toolbar's own Push file…/Pull file… buttons and the
batch-detail page's collected-files table are not shipped yet** — bulk
install (Install on selected, described above under Mirror) is the one
bulk operation with a finished Studio surface today.

## Workspace: what opens how

Opening a file in `/workspace` does not put every file through the same
text box. Studio picks a **presenter** for the file from its content type,
and that presenter decides what you can do with it:

- **Text files** (scripts, JSON, config, anything `text/*`) open in an
  editor and can be saved — the same compare-and-swap save the workspace
  has always used, so a conflicting edit from someone else (or an agent)
  is caught, never silently overwritten.
- **Images and videos** open in a viewer, and **cannot be edited** — not
  because the feature is missing, but because no image or video editor is
  installed. The file's header states this in words when it's open, so it
  is never a Save button that quietly isn't there.
- **A video plays and seeks** like any other video on the web: the core
  streams it in ranges rather than sending the whole file at once, which
  is also what lets the browser start playback before the download
  finishes.

**A file type with no viewer is not an error.** It is named, sized, and
offered as a download — the normal outcome for a type nobody has written a
presenter for yet, not a broken page.

**Large files fall back to metadata.** Each presenter has its own size
ceiling (the text editor's is small, since a huge file in a `Textarea`
would hang the tab; image and video are much larger, since the browser
streams those rather than loading them into memory here). Past that
ceiling, the page shows the file's details — type, size — and a download
link, instead of trying to open it.

**Uploaded content can never execute in Studio's own page.** Studio and
the core share one origin, so a file the workspace serves back to your
browser (`GET /api/workspace/file`) always carries `X-Content-Type-Options:
nosniff` and a sandboxing `Content-Security-Policy`, and only a fixed
allow-list of types (`text/*`, `image/*`, `video/*`, `audio/*`, JSON) is
served inline at all — with `text/html`, `application/xhtml+xml`, and
`image/svg+xml` carved back out of that list specifically because each can
carry script. Everything outside the allow-list, and everything carved
out of it, downloads instead of opening. This is about the browser tab a
teammate's uploaded file renders in, not about protecting you from files
you uploaded yourself.

## Backup and restore

`enkaku backup` writes one `.tar.gz` containing a consistent snapshot of
`enkaku.db` and — when the farm has one — `secrets.key`, the key that
decrypts every credential this farm has ever stored (connector API keys,
network proxy credentials, webhook secrets, secret KV entries).

```bash
./enkaku backup                      # ./enkaku-backup-<timestamp>.tar.gz in the current directory
./enkaku backup /path/to/backups/    # into a directory (created if it does not exist)
./enkaku backup my-backup.tar.gz     # an explicit file name
```

It refuses to overwrite a file already at the target path, and it never
leaves a partial or corrupt file behind on failure — a failed backup cleans
up after itself rather than blocking the next attempt. The command's own
output ends with a loud warning for a reason: **whoever holds this file can
decrypt every credential this farm has ever stored.** Treat it like the
credentials themselves — restrict who can read it, never send it over chat
or email unencrypted, encrypt it at rest if it leaves this machine, and
delete copies you no longer need.

### A starting point for running it

`scripts/enkaku-example-run.sh` is a copy-and-edit example, not a wrapper to
keep: it binds to the LAN and lets Enkaku manage its own TLS certificate.

```sh
export ENKAKU_BIND=0.0.0.0
export ENKAKU_TLS_MODE=self
exec ./enkaku "$@"
```

That is the whole of it, with the rest of the file being comments on what each
line does and which variables to uncomment next (`ENKAKU_DATA_DIR`,
`ENKAKU_PORT`, bring-your-own certificate). Arguments pass through, so
`./enkaku-example-run.sh doctor` works.

Two things it does on purpose:

- **No `ENKAKU_ALLOW_INSECURE=1`.** That variable only does something when TLS
  is `off` in server mode — it is the "yes, plain HTTP, passwords in the clear"
  override. With `self` there is no insecurity to allow, so setting it is a
  no-op that teaches the wrong habit.
- **`exec`, not a plain call.** Without it the core is a child process that
  never receives Ctrl-C or systemd's stop signal, and shuts down uncleanly.

### Updating

`scripts/enkaku-update.sh` downloads the latest release binary and swaps it in.
`install.sh` already put it next to your `enkaku` binary; if you installed by
hand, copy it there. It needs no checkout, no Bun, and no running core, which
matters because "the core will not start" is exactly when you reach for it.
(Re-running `install.sh` upgrades in place too — the updater is the smaller
tool for the job, and the one that still works with no network path to
raw.githubusercontent.com.)

```bash
./enkaku-update.sh                     # update to the latest release, if newer
./enkaku-update.sh --check             # say what would happen, change nothing
./enkaku-update.sh --force             # reinstall the same version
./enkaku-update.sh --version v0.1.30   # a specific tag, including a downgrade
```

`curl` and `tar` are the only requirements; `jq` is used when present and not
needed when it is absent. OS and architecture are detected (`linux`/`darwin`
× `x64`/`arm64`, plus `windows-x64` under Git Bash) and can be overridden with
`ENKAKU_OS`/`ENKAKU_ARCH`. Point it at a different binary with `ENKAKU_BIN`, or
a fork with `ENKAKU_REPO`.

**On native Windows there is no `enkaku-update.sh`** — it is a POSIX shell
script, so it runs under Git Bash and nowhere else. Update by re-running the
installer, which fetches the latest release and swaps the binary the same way:

```powershell
irm https://raw.githubusercontent.com/viandwi24/enkaku/main/install.ps1 | iex
```

This works with the farm up. Windows refuses to *overwrite* a running `.exe`
but does allow *renaming* one, so the script moves the old binary aside to
`enkaku.exe.bak` rather than replacing it in place — the running core keeps its
own loaded image and carries on **on the old version until you restart it**,
exactly as on Linux and macOS. If the move is refused anyway, it says so and
installs nothing instead of leaving you half-upgraded.

It verifies the download against the release's `SHA256SUMS.txt` and refuses to
install on a mismatch. When the sums file or a hashing tool is missing it says
so out loud rather than skipping quietly.

Two details worth knowing:

- **The old binary is kept** at `<binary>.bak`. An update you cannot undo is a
  worse outage than the one it was meant to fix.
- **It replaces the binary with a rename, not a copy.** Copying over a running
  executable fails on Linux with `ETXTBSY` ("Text file busy") — which is
  precisely the case an updater meets, since the farm is usually up while you
  update it. A rename swaps the directory entry; the running core keeps its own
  open inode and carries on unharmed **on the old version until you restart
  it**. The script says so when it detects one still running.

### Resetting a data directory

`enkaku reset` deletes parts of a data directory on purpose — the answer to
"the database will not open" or "this farm has 500 GB of traces I no longer
need" that does not involve guessing which files are safe to remove.

```bash
./enkaku reset                       # lists every scope and its size. Deletes nothing.
./enkaku reset --cache --logs        # still deletes nothing — it shows what --yes would remove
./enkaku reset --cache --logs --yes  # actually deletes those two
./enkaku reset --all --yes           # everything below
```

Scopes: `--db`, `--artifacts`, `--traces`, `--cache`, `--logs`, `--plugins`,
`--tools`, `--workspace`, and `--all` for every one of them.

Three things it will not do:

- **Delete anything without `--yes`.** With no flag, or with scopes but no
  `--yes`, it prints what it would remove, how big each scope is, and what
  the consequence would be.
- **Touch a data directory a core is using.** Deleting `enkaku.db` under a
  live SQLite connection does not stop that core — it keeps writing to an
  unlinked file and loses everything on exit. The command refuses with the
  pid instead.
- **Delete `secrets.key` or `network-credentials.key`**, under any scope,
  including `--all`. Those keys decrypt the credentials inside a backup you
  took *before* the reset; removing them would silently turn every existing
  backup into an unreadable one. Delete them by hand if you truly mean to.

`--cache`, `--logs` and `--traces` are safe at any time. `--db` starts the
farm over: phones come back as Discovered, and scripts, jobs, users, tokens
and settings are gone. Take an `enkaku backup` first if any of it still
matters.

### This backup does not include your workspace's video/media files

`enkaku backup` archives `enkaku.db` and `secrets.key` — nothing else. Most
workspace files (scripts, `captions.txt`, anything small and text) live
*inside* `enkaku.db` and are covered. **A video, or anything else uploaded
into the workspace above the inline-storage threshold, is not**: its bytes
live on disk under `<data dir>/workspace-content/`, addressed by content
hash, and this command never touches that directory. Restoring only
`enkaku.db` after a disk loss brings back every workspace file's catalogue
row — name, size, folder — pointing at bytes that are simply gone. If your
workflow uploads video or other large media into the workspace, back up
`workspace-content/` yourself (a plain recursive copy is fine — it is
content-addressed, so a partial copy the format did not corrupt is a
partial loss, never a wrong answer, but a copy taken while the core is
actively writing new files can still miss ones written after you started).

### Why not `cp enkaku.db backup.db`

`cp` looks like a backup and is not one, for two independent reasons:

- The core runs SQLite in WAL mode unconditionally, so a live database is
  really three files (`enkaku.db`, `enkaku.db-wal`, `enkaku.db-shm`).
  Copying them non-atomically while the core is writing can produce a torn,
  unrecoverable set — and copying `enkaku.db` alone silently drops whatever
  is sitting in `-wal` but has not yet been checkpointed into the main file.
- `secrets.key` lives next to `enkaku.db`, not inside it. Without it, every
  encrypted credential in a restored database becomes permanently
  unreadable — this codebase has already lost secrets exactly this way once
  (see `packages/core/src/secrets/store.ts`'s note on its old key file).

`enkaku backup` avoids both: it takes the snapshot through SQLite's own
`VACUUM INTO`, run over a **read-only** connection, which is safe to call
while the core is up and devices are busy — it never writes to `enkaku.db`
itself, and it correctly captures any committed write still sitting only in
the WAL. Then it bundles that snapshot together with `secrets.key` into one
archive, so the two cannot be separated by accident.

### Restoring

There is no `enkaku restore` command. Restore is rare, deliberate, and only
ever safe with the core stopped — once you have the archive, it is two file
copies, not something that benefits from a dedicated code path. The one
real trap: leftover `-wal`/`-shm` files in the **target** data directory
will try to replay frames that belong to a different database on top of the
file you just restored, corrupting it. Steps:

```bash
# 1. Stop the core.
# 2. Extract the archive:
tar xzf enkaku-backup-*.tar.gz -C /tmp/enkaku-restore

# 3. Remove any WAL leftovers from the TARGET data directory first.
rm -f "$ENKAKU_DATA_DIR/enkaku.db-wal" "$ENKAKU_DATA_DIR/enkaku.db-shm"

# 4. Copy the restored files into place — both from the SAME archive.
cp /tmp/enkaku-restore/enkaku.db "$ENKAKU_DATA_DIR/enkaku.db"
cp /tmp/enkaku-restore/secrets.key "$ENKAKU_DATA_DIR/secrets.key"   # if the archive has one

# 5. Start the core. Pending migrations (if the backup predates an
#    upgrade) run automatically at boot, same as any other enkaku.db.
```

(No `ENKAKU_DATA_DIR` set means the platform default: `~/Library/Application
Support/Enkaku` on macOS, `%APPDATA%\Enkaku` on Windows,
`~/.local/share/enkaku` elsewhere.) Restore `enkaku.db` and `secrets.key`
from the **same** archive, never mixed from two different backups: a
database restored with the wrong key file is exactly the "looks fine, is
not" failure this command exists to prevent.

## The wall and video quality

`/` opens on the **Wall** — every device's screen, live, in a grid — for
every farm, unconditionally. There is no setting that changes what a fresh
browser tab lands on; **Settings → Devices → Video** only tunes *how much
picture* the wall and the device page each ask for, never *whether* the
wall is what you see first.

Two profiles, tuned separately, because the device page is being *driven*
and the wall is only being *watched*:

- **Device page picture** (`controlPreset`) — Sharp / Balanced / Light.
  Sharp (1600px · 30fps · 4 Mbit/s, the shipped default) is what you want
  while actually operating one phone.
- **Wall tile picture** (`wallPreset`) — Detailed / Balanced / Light /
  Minimal. Balanced (480px · 5fps · 800 kbit/s, the shipped default) is
  tuned for scanning a grid, not for reading fine text on any one tile.

**On a laptop, on a slow link, or watching a very large farm:** turn the
wall preset **down** (Light or Minimal). A lower bitrate costs less
bandwidth per tile and — because of the coupling below — buys you *more*
live tiles at once, not fewer.

**On a dedicated wall display with a fast wired connection and a handful
of devices to watch closely:** turn the wall preset **up** (Detailed), or
open the Advanced fields under either preset and type exact numbers. A
wall display usually has room to spare on both the network and the GPU
that a shared laptop does not.

**Why raising quality lowers the tile count.** The wall never lets picture
quality and tile count be chosen independently, on purpose: one browser
tab has a fixed video budget (20 Mbit/s, by default), and the number of
tiles that can be live at once is that budget divided by what one tile
actually costs. Raising the wall bitrate makes each tile cost more, so
fewer of them fit the same budget — this is arithmetic, not a bug, and it
is what keeps "pick your favourite preset" from being able to melt a
browser tab regardless of farm size:

```
live tiles ≈ 20 Mbit/s ÷ (wall tile bitrate)
   Minimal   (200 kbit/s) → up to 32 tiles live at once
   Light     (400 kbit/s) → up to 32 tiles live at once
   Balanced  (800 kbit/s, default) → 25 tiles live at once
   Detailed  (1.5 Mbit/s) → 13 tiles live at once
```

The Video settings section shows this projection live as you adjust the
preset or type a number into Advanced — watch the "N live tiles at these
settings" line move before you save. **Max live wall tiles** can still be
pinned to an exact number instead of left on the automatic default (`0`);
a pinned number always wins over the projection, for a farm on an
unusually fast or slow link that needs to override the formula outright.

Changing a video setting takes effect on devices already streaming, not
only on new sessions: the wall tile (or device page) goes soft for about a
second, shows *"applying new video settings"*, and comes back at the new
numbers — without the browser reconnecting. A device with a job running
on it is left alone until the job finishes; the settings page's toast
after **Apply to live sessions** names exactly which devices that applies
to, by label, never just a count.

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

`.env.example`'s own "Support overrides" section (plan 212) lists about
seventy more — values that used to be Settings fields and are now constants
because they do not differ between farms. None of them appears in Studio;
set one only when support asks you to. An invalid value fails the boot with
`E_BAD_CONFIG` naming the variable, never a silent fallback.

## Troubleshooting

**A device shows up as `unauthorized`.** Check the phone's screen: there is an "Allow USB debugging" dialog. Tick "Always allow" and tap Allow. If the dialog never appears, unplug and replug the cable; if it still does not, go to Developer options → Revoke USB debugging authorizations, then plug in again.

**A device is not detected at all.** Make sure USB debugging is on and the cable carries data (many charging cables do not). On Linux, add a udev rule for your phone's vendor.

**Conflicts with Android Studio.** Android Studio runs its own adb server on port 5037. Enkaku uses that same adb server, so this is usually fine — but do not run `adb kill-server` by hand while the farm is working: it disconnects every device. If the shared server itself is wedged (reachable but not answering), use **Tools → Restart adb server** in Studio instead of a manual kill: it drains live sessions and leases first, restarts the server, and dials every remembered network device back afterward — reconnecting far more of the farm than a bare `kill-server` would leave you to recover by hand. It still disconnects Android Studio's own adb connection for a few seconds, the same as a manual restart would.

**Something is stuck and restarting adb didn't help — a plugin update on disk isn't taking effect, or the core itself just feels wedged.** Use **Tools → Restart Enkaku** — the whole core process, not just the adb server. It is a materially bigger action (every live session/stream drops, every in-flight job is interrupted, the farm is briefly fully unreachable), so Studio confirms it separately from the adb restart button and states, from the response, what actually happens next: on Docker or systemd the process exits and the existing supervisor relaunches it automatically; running bare (`bun run dev`, or a release binary with no systemd unit) it starts a fresh copy of itself and only switches over once that copy answers healthy — if it never does, the original process keeps running and Studio shows an honest error rather than a silent failure.

**Provisioning fails (no internet).** The core stays up; set up a manifest mirror and point `ENKAKU_TOOLS_MANIFEST_URL` at it, or copy an already-populated `tools/` folder into the data dir — the core adopts it at start.

**Windows: `EPERM: operation not permitted, rename ...\tools\.staging\...`.** A tool was downloaded and verified, but the move into `tools\` lost a race against something holding the file — usually Windows Defender scanning what was just written, sometimes the search indexer or a sync client. It is not a permissions problem, so running as Administrator does not help. The core retries and falls back to a copy, so this should no longer surface; if it still does, add an exclusion for the data dir (`%APPDATA%\Enkaku`) in Windows Security → Virus & threat protection → Exclusions, then reinstall the tool from the Tools page. Only adb blocks the boot — a device-side tool that fails to install leaves the farm running with that feature missing.
