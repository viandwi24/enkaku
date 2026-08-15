# @enkaku/adb

A thin client for the adb server's smartsocket protocol (`127.0.0.1:5037`). The
only CLI spawn this package ever makes is `adb start-server`, when the
connection is refused. `adb kill-server` is forbidden repo-wide except inside
the Toolchain Manager's version-swap flow (spec §10.4) — this package does not
go near it.

## Two budgets that look alike and are not

`AdbClient` enforces two separate farm-wide concurrency budgets. Both answer
"how many adb things may happen at once", but they exist to prevent different
failures, are implemented by different structures, and must never be
confused with each other.

### The exec semaphore (`Semaphore` + `PerDeviceQueue`)

Guards `exec()` / `execOut()` — one-shot commands (`getprop`, an input tap, a
screencap) that return a bounded amount of output and end on their own. Each
device keeps its own FIFO queue (one command in flight per device, unchanged
since plan 01); a farm-wide `Semaphore` additionally caps how many devices can
have a command in flight *simultaneously*, so a large fleet does not hit the
adb server's dispatcher all at once.

Auto-scale formula (`computeAutoConcurrency`, `packages/core/src/device/adb-scaling.ts`):

```
computeAutoConcurrency(n) = clamp(ceil(n * 0.75), 6, 24)
#  4 devices → 6 (floor — unchanged from before plan 23)
# 10 devices → 8
# 20 devices → 15
# 32+ devices → 24 (ceiling)
```

Controlled by the farm setting `adb.maxConcurrent` (default `0` = auto; a
non-zero value pins it and the autoscaler leaves it alone). `setMaxConcurrent()`
is the runtime knob the daemon calls as fleet size changes or the setting is
edited; the constructor's `maxConcurrent` option only sets the starting point
before the first autoscale pass.

### The streaming lane (`StreamLane`)

Guards `execStream()` — long-lived commands (`logcat`, `top`, the ui-server's
own instrumentation session) that stay open for the life of a session instead
of returning once. It is a structurally separate budget: `execStream()` never
touches `PerDeviceQueue` (plan 24 §3.1) — a stuck `logcat` must never be able
to park a per-device exec slot. Over budget, `acquire()` throws
`E_ADB_STREAM_LIMIT` **synchronously**; it never queues, because handing back
a plain "no" right now is the entire point of a dedicated lane.

Auto-scale formula (`computeAutoStreams`, `packages/core/src/device/adb-scaling.ts`):

```
computeAutoStreams(n) = clamp(ceil(n * 2.5), 8, 64)
#  5 devices → 13
# 10 devices → 25
# 20 devices → 50
# 26+ devices → 64 (ceiling — the adb server itself, not this budget, is the limit past here)
```

Controlled by the farm setting `adb.maxStreams` (default `0` = auto, since
plan 85; a stored `4` from before that plan is rewritten to `0` on the first
boot after upgrading — a tracked removal, see `docs/plans/00-overview.md`
§9). `setStreamLimits()` is the runtime knob. `maxStreamsPerDevice` (default
4) is the companion **per-device** cap on the same lane — a device may not
exceed it even when the farm-wide budget has room.

### Why the two formulas differ

`computeAutoConcurrency`'s constant (`0.75`, floor 6, ceiling 24) exists so
the exec semaphore keeps ahead of *bursty* one-shot traffic — a device that
is not actively streaming barely touches this budget between commands.

`computeAutoStreams`'s constant (`2.5`, floor 8, ceiling 64) is derived from
what a device actually **holds at steady state**, not a round number: the
ui-server instrumentation (plan 34) and the always-on crash watcher (plan 37,
`logcat -b crash,main`) each hold one stream slot for the entire life of a
session, deliberately never released early. That is 2 slots per
fully-instrumented device before a human ever opens a Monitor tab or starts a
file transfer, plus half a slot of headroom for exactly that kind of bursty
use — `2 (steady state) + 0.5 (headroom) = 2.5` per device.

The old fixed value, `4`, was a leftover from plan 24's original
single-device worked example. Nobody re-derived it once the ui-server and the
crash watcher each started holding a slot permanently, so it quietly capped
the whole farm at **two** fully-instrumented devices — past that point, every
further stream request failed with `E_ADB_STREAM_LIMIT` (`the farm already
has 4 adb stream(s) running (max 4)`, the exact line a five-device Windows
field report hit). See `docs/plans/85-m50-windows-fleet-scale.md` §3.1 and
§4.2 for the full derivation and its evidence.

Also new since plan 85, but **not** part of this package: `adb.maxHostConcurrent`
(default 4) and `adb.maxInstallConcurrent` (default 2) bound the adb **CLI**
(`adb install`/`push`/`forward`), spawned through
`packages/core/src/device/host-adb.ts` — a different process entirely from
this package's smartsocket client. See `packages/core/README.md`.

## Other things this package owns

- `DeviceTracker` — the long-lived `host:track-devices` event stream.
- `shell,v2,raw` framed shell with a legacy `shell:` fallback, cached per
  serial once the framed service is confirmed unsupported (plan 53).
- `listDevices()` / `reconnectOffline()` (`host:devices-l` /
  `host:reconnect-offline`) — added by plan 85 for
  `packages/core/src/registry/reconcile.ts`'s discovery reconciler; neither
  is `kill-server` and neither disturbs another tool's session on port 5037.
- `listDevices()`'s parsing gained two fields it used to throw away (plan 88
  §3.1, §5 step 88.1, fixes F6): `TrackedDevice.usb` and `.transportId`, read
  from `host:devices-l`'s trailing `key:value` fields (`usb:3-1.4.3`,
  `transport_id:10`). `usb:` is adb's own signal that a transport is USB
  rather than TCP — the exact field the registry's `deriveConnection()` (see
  `packages/core/README.md`) needs to tell `kind: 'usb'` from `kind: 'tcp'`
  without guessing from the shape of the serial string alone.
- `connectDevice(hostPort)` / `disconnectDevice(hostPort)` (`host:connect:<host:port>`
  / `host:disconnect:<host:port>`) already existed for the `adb-tcp` transport
  engine and the wireless pairing flow; plan 88 adds their first **operator-facing**
  callers — the reconnect ladder and per-device Disconnect/Reconnect
  (`packages/core/src/registry/reconnect.ts`) — and changes what
  `disconnect()` means for a live session: `AdbTcpTransport.disconnect()` is
  now a documented no-op, since a session closing must never drop the farm's
  adb transport out from under it (plan 88 §3.7). Neither call is
  `kill-server`; both operate on one transport, never the shared server.
