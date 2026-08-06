# Plan 11 — M8 : Cloud & Driver Tambahan

> Status: partial — M8a (packages/agent mini-core, outbound WSS tunnel with backoff, ENKAKU_MODE=orchestrator) and M8d (redroid via adb-tcp, scrcpy-aoa, appium) are built; M8b's WebRTC relay also exists but was implemented under Plan 13, not this plan's own design; M8c (per-job container isolation / security boundary) is not built — no docker/podman runtime, and tenant scoping is two unenforced `tenantId` columns.
> Ships: packages/node/src/index.ts
> **Depends on:** Plan 01–10 (semua acceptance criteria lulus). Khususnya: Plan 04 (lease/queue), Plan 05 (runner subprocess + IPC), Plan 08 (scrcpy display + WS video), Plan 09 (auth/TLS/Docker image), Plan 10 (AUP/lisensi).
> **Referensi spec:** §20 baris M8, §5.3–5.4 (cloud mode & WebRTC), §11.3 (trust model & isolasi), §18 (security boundary cloud), §9 (input modes, `scrcpy-aoa`), §9.5 (capability locks), §6.3 (Appium), §7.1 (engine `cloud-tunnel`, `adb-tcp`), §13 (protokol), §14 (keamanan).
>
> **Catatan skala:** ini milestone terbesar dan paling riset-berat di seluruh roadmap. Plan ini memecahnya menjadi **empat sub-fase berurutan (M8a → M8b → M8c → M8d)**; tiap sub-fase punya langkah implementasi, acceptance criteria, dan test plan sendiri. Sub-fase boleh di-commit & dirilis terpisah (`feat(m8a): ...` dst). Detail API library eksternal yang belum diverifikasi ditandai **`TODO-verify`** — jangan mengarang API saat implementasi; verifikasi dulu ke dokumentasi/sumber resmi.
>
> **Renamed in plan 61:** `packages/agent` shipped here became `packages/node`, the `agents` table became `nodes`, and every "agent" reference below documents what this plan actually shipped at the time — it is left as written rather than silently rewritten.

---

## 1. Goals

Setelah plan ini selesai, semua pernyataan berikut TRUE:

- **M8a — Agent & tunnel**
  - `packages/agent` berisi **mini-core** yang bisa jalan di mesin dekat device (subset core: adb, toolchain, driver, DeviceSession lokal) **tanpa** Studio dan tanpa DB penuh.
  - Agent membuka **outbound WebSocket tunnel** ke control plane; tidak ada port-forward/inbound port di sisi agent (tembus NAT).
  - Auth agent memakai **enrollment token per-agent**; token sekali pakai ditukar credential jangka-panjang.
  - Agent **reconnect otomatis** dengan exponential backoff + jitter; device yang di-handle agent muncul/hilang di Studio cloud sesuai status tunnel.
  - Core bisa jalan dalam **mode `orchestrator`** (control plane): tanpa device lokal, me-relay message & stream antara browser dan agent memakai protokol multiplex yang sudah ada (envelope diperluas dengan routing `agentId`/`deviceId`).
- **M8b — WebRTC video**
  - Video device yang berada di balik agent bisa ditonton dari browser lewat internet publik memakai **WebRTC** (H.264 scrcpy → RTP, RFC 6184), dengan signaling via WS dan STUN/TURN (default deployment: coturn self-host).
  - Pada packet loss 2–5% (disimulasikan `tc netem`), video WebRTC tetap bergerak; jalur WS pada kondisi sama terbukti freeze (bukti klaim spec §5.3 head-of-line blocking).
  - Kalau negosiasi WebRTC gagal (ICE fail total), client **fallback ke WS** (degraded, tapi jalan). LAN/local mode tetap WS+WebCodecs, tidak berubah.
- **M8c — Security boundary per-job**
  - Eksekusi bundle script bisa dijalankan dalam **container per job** (Docker/Podman) sebagai security boundary pertama untuk multi-tenant.
  - IPC runner⇄core dari Plan 05 sudah **transport-agnostic** (stdio → socket), sehingga proses script bisa hidup di dalam container/host lain tanpa mengubah kontrak `ctx.device/artifact/log`.
  - Multi-tenancy data: entitas utama (devices, scripts, jobs, artifacts, users, agents) ter-scope per tenant di DB dan di-enforce di query layer (server-authoritative).
- **M8d — Driver tambahan**
  - **redroid** bisa didaftarkan sebagai device via transport `adb-tcp` (dokumen provisioning + catatan emulator-detection spec §5.4).
  - **`scrcpy-aoa`** tersedia sebagai InputSink opt-in (USB AOA HID, butuh kabel, tanpa adb untuk jalur input).
  - **`appium`** tersedia sebagai engine opt-in (Inspector WebView/hybrid + InputSink), diinstall via Toolchain Manager sebagai tool opsional, dengan locks `['instrumentation','input-injection']` yang ditolak session manager kalau bentrok.
- **Deployment**: control plane punya container image + dokumen deploy (config, TURN, TLS/domain).

## 2. Non-goals

- **Billing / seat / subscription / license metering SaaS** — di luar scope; masuk Open questions (§9). Plan 10 hanya menyiapkan license/activation self-host.
- **WebTransport (HTTP/3/QUIC)** sebagai transport video — spec §5.3 menyebutnya "minimal", tapi M8 memilih WebRTC; WebTransport dicatat sebagai future.
- **gVisor / Firecracker microVM production-ready** — didesain di matrix (§4.5) dan disiapkan jalurnya (runtime pluggable), tapi implementasi M8c berhenti di container. gVisor = tahap berikut (cukup ganti runtime `runsc`), microVM = future.
- **Audio streaming** lewat WebRTC — video dulu; audio menyusul (Open question).
- **Multi-region / HA control plane** — single instance dulu.
- **iOS, marketplace script, CI integration** — spec §22, bukan M8.
- **Reset-device-antar-lease otomatis penuh** (spec §14 data hygiene) — hook-nya ada sejak Plan 04; kebijakan cloud-tenant lengkap = Open question.

## 3. Konteks & keputusan desain

### 3.1 Topologi split control plane (spec §5.3)

Prinsip yang tidak berubah: **core harus dekat device**. Yang naik ke cloud adalah control plane (Studio hosted + orchestrator + relay). Di lokasi device, yang jalan adalah **agent** = mini-core.

```
        LOKASI DEVICE (kantor customer)                CLOUD (kamu host)                 USER
  ┌──────────────────────────────────────┐   ┌──────────────────────────────────┐   ┌──────────┐
  │  [Device A]──USB──┐                  │   │  Control Plane                   │   │ Browser  │
  │  [Device B]──WiFi─┤                  │   │  (core mode=orchestrator)        │   │ (Studio) │
  │                   ▼                  │   │  ┌───────────┐  ┌────────────┐   │   │          │
  │        ┌─────────────────┐  outbound │   │  │ API + WS  │◄─┼─ WSS ──────┼───┼───┤ control  │
  │        │ Agent (mini-core)│═══WSS════╪═══╪═►│ router    │  │            │   │   │ /queue   │
  │        │ adb+toolchain+   │  tunnel  │   │  ├───────────┤  │  SQLite    │   │   │          │
  │        │ driver+session   │ (no port │   │  │ Relay:    │  │  (tenant-  │   │   │          │
  │        └─────────────────┘  forward) │   │  │ WS remux +│  │   scoped)  │   │   │          │
  │                                      │   │  │ WebRTC    │◄─┼─ SRTP/UDP ─┼───┼───┤ video    │
  └──────────────────────────────────────┘   │  │ terminate │  └────────────┘   │   │ (WebRTC) │
                                             │  └───────────┘   ┌──────────┐    │   └──────────┘
                                             │                  │ coturn   │◄───┼──── TURN bila
                                             │                  │ (STUN/   │    │     UDP diblok
                                             │                  │  TURN)   │    │
                                             │                  └──────────┘    │
                                             └──────────────────────────────────┘
```

Keputusan kunci:

1. **Agent = subset core, bukan program baru.** Modul adb (Plan 01), toolchain (Plan 02), drivers (Plan 03/08), DeviceSession (Plan 04) sudah package terpisah — agent tinggal merakitnya tanpa Studio, tanpa queue/scheduler penuh, tanpa DB penuh (hanya state file kecil). Orkestrasi (lease, queue, job, user) tetap milik control plane: **server-authoritative tidak berubah**, agent hanya "tangan" yang mengeksekusi perintah bertanda routing.
2. **Protokol tunnel = protokol Core⇄Studio yang sudah ada, diperluas.** Spec §4 memilih message-based WS justru "supaya transport gampang dipindah ke model relay/tunnel". Kita tepati: envelope JSON `{type,id,payload}` (overview §4.3) diperluas dengan `agentId`/`deviceId` untuk routing, binary frame diperluas dengan channel table. Tidak ada protokol kedua.
3. **Core satu codebase, dua mode.** `ENKAKU_MODE=local` (default, perilaku Plan 01–10) vs `ENKAKU_MODE=orchestrator` (tanpa adb/device lokal, plus tunnel router + relay). Menghindari fork codebase.

### 3.2 Kenapa jalur video internet ≠ WS (spec §5.3)

WebSocket = TCP. Di internet, satu packet loss membuat TCP menahan **semua** byte setelahnya sampai retransmit selesai (head-of-line blocking) — seluruh video freeze, lalu "meloncat". Untuk remote control real-time ini fatal. WebRTC (`RTCPeerConnection`) memakai UDP/SRTP: frame yang hilang bisa di-recover (NACK/PLI → scrcpy IDR request) tanpa menahan frame berikutnya, plus congestion control bawaan. Konsekuensi arsitektur (spec §5.3): **relay di control plane men-terminate WebRTC** ke browser dan me-repackage H.264 scrcpy menjadi RTP. Kontrol/queue/inspector tetap lewat WS — loss di situ tidak sekritis video, dan request-reply butuh reliability.

Kenapa terminate di control plane (bukan P2P browser⇄agent): (a) agent di balik NAT korporat, P2P sering butuh TURN juga; (b) satu sisi WebRTC saja yang harus kita implement di server; (c) relay bisa fan-out satu stream ke banyak viewer. Trade-off: bandwidth lewat cloud — diterima untuk v1 (Open question: mode P2P opsional).

### 3.3 Trust model → security boundary (spec §11.3, §18)

Plan 05 memberi **crash containment** (child process + hard-timeout kill), dan spec jujur: itu bukan security boundary. Cloud multi-tenant = script author **tidak lagi tepercaya** terhadap operator control plane maupun tenant lain. Maka M8c wajib ada sebelum multi-tenant dibuka. Keputusan: **bertahap** — container per job dulu (cukup untuk memisahkan fs/network/proses antar-job dan dari host), runtime dibuat pluggable supaya gVisor (ganti runtime) dan microVM (future) tidak butuh desain ulang. Matrix lengkap di §4.5.

### 3.4 Urutan sub-fase

```
M8a (agent+tunnel) ──► M8b (WebRTC)      ──► M8d (driver tambahan)
        └────────────► M8c (isolation)  ──┘
```

- **M8a duluan**: semua yang lain butuh topologi cloud hidup.
- **M8b setelah M8a**: relay WebRTC butuh stream video sampai di control plane via tunnel.
- **M8c setelah M8a** (paralel dengan M8b boleh, tapi default urut): tenant scoping menyentuh DB & auth yang juga dipakai M8a — kerjakan setelah tunnel stabil.
- **M8d terakhir**: redroid paling berguna di cloud (butuh M8a); appium/aoa independen tapi ditaruh akhir karena opt-in.

## 4. Desain teknis

### 4.1 `packages/agent` — mini-core

Struktur:

```
packages/agent/
  package.json                  # @enkaku/agent, private
  src/
    index.ts                    # entrypoint: load config → connect tunnel → run
    config.ts                   # Zod schema config agent + load/save state file
    tunnel/
      client.ts                 # WS client: connect, auth, reconnect+backoff
      mux.ts                    # (re-export/pakai) multiplex dari @enkaku/protocol
    bridge/
      device-bridge.ts          # map perintah tunnel → DeviceSession lokal
      session-host.ts           # rakit Transport/Display/Input/Inspector (reuse @enkaku/drivers)
    enroll.ts                   # tukar enrollment token → agent credential
    agent.test.ts / *.test.ts
  README.md
```

- **Dipakai ulang dari core:** `@enkaku/adb`, `@enkaku/toolchain`, `@enkaku/drivers`, `@enkaku/scrcpy`, `@enkaku/protocol`. Agent **tidak** import `@enkaku/core` utuh — kalau ada logika yang dibutuhkan dua-duanya (mis. DeviceSession factory, probe stableId), **ekstrak dulu** ke package yang sudah ada (`@enkaku/drivers` atau package internal baru `@enkaku/session` — keputusan di langkah A.1) supaya tidak duplikasi.
- **State agent** = satu file JSON (`<data-dir>/agent.json`, Zod-validated): `{ agentId, credential, controlPlaneUrl, dataDir }`. Tidak ada SQLite di agent (device registry milik control plane; agent hanya melaporkan apa yang dia lihat dari `track-devices`).
- **Yang TIDAK ada di agent:** Studio, queue/scheduler, users/auth lokal, script storage. Runner job: eksekusi bundle tetap **di sisi agent** (dekat device, latency inspector rendah) — bundle dikirim control plane → agent spawn runner (kontrak IPC Plan 05, nanti jadi socket di M8c). Lease & keputusan scheduling tetap di control plane.
- **Config via env/flag:** `ENKAKU_CP_URL`, `ENKAKU_ENROLL_TOKEN` (sekali pakai), `ENKAKU_DATA_DIR`.

### 4.2 Protokol tunnel (perluasan `packages/protocol`)

**Envelope JSON** — file baru `packages/protocol/src/tunnel.ts`:

```ts
// Perluasan envelope overview §4.3 — backward compatible:
// pesan lama tanpa field routing tetap valid (local mode tidak berubah).
export const RoutedEnvelope = z.object({
  v: z.literal(1),                    // versi protokol tunnel
  type: z.string(),                   // discriminated union dari message yang sudah ada
  id: z.string().optional(),          // request-reply correlation (tetap)
  agentId: z.string().optional(),     // diisi CP saat route ke/dari agent
  deviceId: z.string().optional(),    // target device (stableId-based internal id)
  tenantId: z.string().optional(),    // diisi CP (server-side only; agent/browser tak boleh set)
  payload: z.unknown(),
})

// Message baru khusus tunnel (ditambahkan ke discriminated union protocol):
// agent → CP : 'agent.hello'        { agentVersion, platform, toolVersions }
// CP → agent : 'agent.hello.ack'    { agentId, serverTime, pinnedScrcpyVersion }
// agent → CP : 'agent.devices'      { devices: DeviceInfo[] }   // snapshot + delta dari track-devices
// CP → agent : 'session.start'      { deviceId, engines: {...} }
// CP → agent : 'session.stop'       { deviceId }
// CP → agent : 'job.dispatch'       { jobId, deviceId, bundleRef, params }  // M8c: + isolation
// dua arah   : 'tunnel.ping'/'tunnel.pong'  { t }               // keepalive 20s, deteksi half-open
```

**Binary frame** — Plan 03/08 memakai prefix 1-byte channel per koneksi WS. Di tunnel, satu koneksi WS agent membawa banyak device, jadi channel jadi dinamis:

```
frame = [ 0x02 ][ channelId: uint16 BE ][ payload... ]

alokasi channel via JSON:
  CP → agent : 'tunnel.channel.open'  { channelId, deviceId, kind: 'video'|'audio'|'control-raw' }
  CP ⇄ agent : 'tunnel.channel.close' { channelId }
```

Relay di CP me-remux: frame channel `video` device X → (LAN-mode viewer) frame prefix video di WS browser, atau (cloud) → RTP packetizer M8b. Backpressure: relay memantau `ws.bufferedAmount` per koneksi; kalau melewati high-watermark, **drop frame video non-IDR** (video boleh drop; JSON tidak pernah di-drop).

**Enrollment & auth** (spec §14 "tunnel agent pakai token"):

1. Admin di Studio cloud: "Add agent" → CP buat record `agents` + **enrollment token** acak (tampil sekali; DB simpan hash argon2 — reuse util Plan 09).
2. Agent start pertama: `POST /api/agents/enroll` `{ token, name, platform }` → CP verifikasi, tandai token terpakai, balas `{ agentId, credential }` (credential = secret jangka-panjang, hash-nya di DB).
3. Koneksi tunnel: `GET /agent/ws` dengan header `Authorization: Bearer <agentId>.<credential>`; CP verifikasi hash. Salah → close code 4401, agent **tidak** retry-loop cepat (backoff penuh) dan log jelas.
4. Revoke: admin hapus/disable agent → CP putus tunnel, token/credential mati.

**Reconnect + backoff:** exponential 1s, 2s, 4s, ... cap 60s, full jitter (`delay = rand(0, min(cap, base*2^n))`). Reset counter setelah koneksi stabil ≥ 60s. Saat tunnel putus: CP tandai semua device agent itu `offline`, broadcast `device.status`; lease/job yang sedang jalan di agent → kena mekanisme lease-expiry Plan 04 (tidak ada jalur khusus).

### 4.3 Control plane: core mode `orchestrator`

- `packages/core/src/mode.ts`: `mode: 'local' | 'orchestrator'` dari `ENKAKU_MODE`. Orchestrator **tidak** menginisialisasi subsistem adb lokal/track-devices/toolchain-provision-device; menginisialisasi `tunnel/` router + `relay/`.
- File baru di core:
  ```
  packages/core/src/tunnel/registry.ts    # Map<agentId, AgentConn> + Map<deviceId, agentId>
  packages/core/src/tunnel/router.ts      # route RoutedEnvelope browser⇄agent, isi/validasi agentId
  packages/core/src/tunnel/channels.ts    # alokasi channelId, remux binary
  packages/core/src/relay/ws-relay.ts     # fan-out video ke viewer WS (fallback & LAN parity)
  packages/core/src/relay/webrtc/*        # M8b
  ```
- DB (Drizzle migration, `packages/core/src/db/`):
  ```ts
  export const agents = sqliteTable('agents', {
    id:            text('id').primaryKey(),
    tenantId:      text('tenant_id'),                    // M8c
    name:          text('name').notNull(),
    tokenHash:     text('token_hash'),                   // enrollment token (null setelah dipakai)
    credentialHash: text('credential_hash'),
    status:        text('status').default('pending'),    // pending|online|offline|disabled
    version:       text('version'),
    platform:      text('platform'),
    lastSeen:      integer('last_seen', { mode: 'timestamp' }),
    createdAt:     integer('created_at', { mode: 'timestamp' }),
  })
  ```
  Tabel `devices` tambah kolom `agentId` nullable (null = device lokal, mode local).
- **Server-authoritative tetap:** lease-check, `busy`-reject, capability-locks validation semua terjadi di CP sebelum pesan diteruskan ke agent. Agent juga memvalidasi ulang locks lokal (defense in depth), tapi keputusan resmi di CP.

### 4.4 M8b — Relay WebRTC (spec §5.3)

**Pipeline:**

```
scrcpy-server (device, H.264 Annex B)
  → agent: DisplaySource.onFrame(chunk, meta)         # sudah ada sejak Plan 08
  → tunnel binary channel 'video'                      # M8a
  → CP relay: AnnexB split → NAL units
  → RTP packetizer RFC 6184 (payload type H264):
      - NAL ≤ MTU(±1200B payload): Single NAL Unit Packet
      - NAL > MTU: FU-A fragmentation (FU indicator+header, S/E bits)
      - SPS/PPS: kirim in-band sebelum tiap IDR + advertise sprop-parameter-sets di SDP
      - timestamp clock 90 kHz dari meta.pts scrcpy; marker bit di paket terakhir access unit
  → RTCPeerConnection (server-side) → SRTP/UDP → browser <video> / ontrack
```

**Signaling** via WS yang sudah ada (message baru di protocol):

```
browser → CP : 'video.webrtc.request' { deviceId }
CP → browser : 'video.webrtc.offer'   { sdp }          // CP = offerer, sendonly H.264
browser → CP : 'video.webrtc.answer'  { sdp }
dua arah     : 'video.webrtc.ice'     { candidate }    // trickle ICE
CP → browser : 'video.webrtc.failed'  { reason }       // → client fallback WS
browser → CP : 'video.webrtc.stop'    { deviceId }
```

Keyframe recovery: `RTCPeerConnection` server menerima RTCP **PLI/NACK** → relay terjemahkan jadi request IDR ke scrcpy via agent (scrcpy control message reset/IDR — **TODO-verify** mekanisme persis di versi scrcpy yang di-pin core; kalau tak ada, fallback: restart display stream).

**STUN/TURN:** default deployment note = **coturn self-host** (container sebelah CP), long-term credentials. CP expose `GET /api/webrtc/ice-config` → `{ iceServers }` untuk browser; server-side PC pakai config sama. Tanpa TURN, klien di balik NAT simetris/UDP-blocked akan gagal → fallback WS (jalan, tapi rentan freeze — tampilkan badge "degraded" di Studio).

**Fallback:** state machine di Studio player: `webrtc-connecting → webrtc | ws-fallback`. Trigger fallback: `video.webrtc.failed`, ICE `failed`, atau tidak ada frame 10s. LAN/local mode: player langsung WS+WebCodecs (tidak ada perubahan dari Plan 08).

**Kandidat library WebRTC server-side** (keputusan final = Open question #2, dengan rekomendasi):

| Kandidat | Bentuk | Plus | Minus | Kompatibilitas Bun |
|---|---|---|---|---|
| **werift** | Pure TypeScript (npm) | Tanpa native deps; API RTCPeerConnection-like; bisa raw RTP injection | Maturity < libwebrtc; performa CPU untuk banyak stream perlu diukur | Kemungkinan besar jalan (pure TS) — **TODO-verify** di Bun (dtls/crypto API) |
| node-webrtc (`wrtc`) | Native binding libwebrtc | Battle-tested stack | Maintenance historis tersendat; native module Node-ABI | Diragukan di Bun (N-API coverage) — **TODO-verify** |
| GStreamer sidecar (`webrtcbin`) | Proses eksternal | Sangat matang; sekalian dapat depacketize/jitter | Dependency ops besar; distribusi binary per-platform; IPC tambahan | Netral (proses terpisah) |

**Rekomendasi:** mulai **werift** (paling selaras dengan self-contained & Bun); kalau verifikasi/benchmark gagal, sidecar GStreamer sebagai plan B (di-manage Toolchain Manager sebagai tool opsional). Jangan hardcode pilihan: bungkus di interface internal `RtcPeer` (subset: createOffer/setRemoteDescription/addIceCandidate/sendRtp/onRtcp) supaya swap murah.

### 4.5 M8c — Security boundary per-job

**Matrix opsi isolasi** (spec §11.3: container/gVisor/microVM/user OS):

| Opsi | Startup latency | Kekuatan isolasi | Kompleksitas ops | Catatan |
|---|---|---|---|---|
| Child process (status quo Plan 05) | ~10 ms | ❌ crash containment saja | nol | Tetap default **mode local single-tenant** |
| User OS terpisah per job | ~10 ms | ⚠️ lemah (fs permission saja, network & /proc tetap terlihat) | rendah | Tidak cukup untuk multi-tenant; tidak dipilih |
| **Container (Docker/Podman)** | ~0.5–2 s (image warm) | ✅ namespace kernel: fs/net/pid terpisah; seccomp/caps drop | menengah | **Pilihan M8c tahap 1** |
| gVisor (`runsc`) | container + ~ratusan ms | ✅✅ syscall interception, kernel host terlindung | menengah (install runtime) | Tahap 2: drop-in `--runtime=runsc`, desain sudah kompatibel |
| microVM (Firecracker) | ~125 ms boot + siapkan rootfs/snapshot | ✅✅✅ hardware boundary | tinggi (KVM, Linux-only, image mgmt) | Future; jangan diblokir oleh desain |

Angka latency = order-of-magnitude untuk penentuan desain — **TODO-verify** ulang di benchmark A/C M8c.

**Rekomendasi bertahap:** container dulu (Docker **atau** Podman — deteksi mana yang ada; abstraksi `ContainerRuntime` tipis: `run/kill/wait`). `IsolationMode = 'process' | 'container'` per konfigurasi farm: mode local default `process` (tidak mengubah UX zero-config), mode orchestrator/multi-tenant **wajib** `container` (CP menolak start kalau runtime tak tersedia).

**Redesain IPC runner (dari Plan 05): transport-agnostic.**

Plan 05: `Bun.spawn` child + IPC stdio (JSON-lines). Masalah: proses dalam container tidak berbagi stdio semantik yang sama & kelak bisa beda host. Solusi:

```ts
// packages/core/src/runner/ipc.ts  (refactor dari Plan 05)
interface RunnerTransport {
  send(msg: RunnerMessage): void            // RunnerMessage = Zod union yang SUDAH ada di Plan 05
  onMessage(cb: (msg: RunnerMessage) => void): void
  close(): Promise<void>
}
// impl 1: StdioTransport   (existing, mode 'process' — perilaku Plan 05 tidak berubah)
// impl 2: SocketTransport  (TCP listener di core/agent, loopback/bridge network only,
//                           auth: token sekali-pakai per job di env RUNNER_TOKEN)
```

Flow mode `container` (berjalan **di agent** — job dieksekusi dekat device, lihat §4.1):

1. Agent terima `job.dispatch` → tulis bundle ke dir kerja job.
2. Agent listen socket IPC di address yang reachable dari container (Docker: host-gateway; Podman: `slirp4netns` — **TODO-verify** opsi network per runtime) — bind loopback/bridge saja, tidak pernah 0.0.0.0 publik.
3. `docker run --rm --network <restricted> --read-only --cap-drop ALL --memory 512m --pids-limit 256 -v <bundle>:/job:ro enkaku-runner:<coreVersion> …` → image berisi Bun + `runner-shim` yang connect balik ke socket IPC dengan `RUNNER_TOKEN`.
4. Semua panggilan `ctx.device.*` / `ctx.artifact.*` / `ctx.log` berjalan lewat IPC bridge → dieksekusi agent (device tak pernah di-expose ke container; tidak ada adb di dalam container).
5. Timeout/kill: agent `docker kill` (bukan cuma SIGKILL proses) + hapus dir kerja. `finish` tetap dijamin jalan best-effort sebelum kill paksa (kontrak Plan 05).
6. Network egress container: default **deny kecuali IPC bridge** (job automation tidak butuh internet dari dalam bundle; kalau butuh, per-script opt-in = Open question #6).

**Multi-tenancy data (minimal):**

- Tabel baru `tenants { id, name, createdAt }`; kolom `tenantId` (nullable → diisi `default` tenant via migration) di: `users`, `devices`, `agents`, `scripts`, `jobs`, `artifacts` (ikut jobs), `audit_log`.
- Enforcement satu pintu: helper query `scoped(db, tenantId)` di data layer — semua repo function menerima `tenantId` dari session auth, tidak ada query cross-tenant kecuali role `superadmin` (baru, khusus operator CP).
- Mode local: satu tenant `default`, tidak ada UI tenant — perilaku Plan 01–10 tak berubah.
- Skema billing/kuota per tenant: **Open question #1**.

### 4.6 M8d — Driver tambahan

**(1) redroid via `adb-tcp`** (spec §5.4): tidak butuh engine baru — transport `adb-tcp` sudah ada sejak Plan 01/03. Deliverable = **provisioning docs + verifikasi jalur**:

- `docs/deploy/redroid.md`: prasyarat kernel host (module `binder_linux`; kebutuhan `ashmem`/memfd tergantung kernel — **TODO-verify** per distro), contoh `docker run -d --privileged -p 5555:5555 redroid/redroid:<tag>`, lalu enroll di Studio via "Add device by IP" (`adb connect ip:5555`).
- Catatan wajib di docs + badge di Studio: redroid = emulator → banyak deteksi naif ke-flag (`ro.kernel.qemu` dkk); cocok buat throughput test, bukan "device asli" (spec §5.4, §9.2). Deteksi: probe `ro.product.model`/`ro.hardware` saat enroll → set flag `deviceKind: 'physical' | 'redroid' | 'emulator'` di `devices.settings` (JSON, tanpa migration schema besar).
- scrcpy & ui-server harus diverifikasi jalan di redroid (scrcpy butuh encoder — redroid image tertentu tanpa HW encoder pakai SW encode — **TODO-verify** flag scrcpy yang tepat).

**(2) `scrcpy-aoa` InputSink opt-in** (spec §9, §9.1 mode AOA):

- Konsep: host menjadi **HID peripheral fisik** via protokol Android Open Accessory (AOAv2) langsung ke USB — **bypass total input stack Android**, tak butuh adb untuk jalur input. Paling "hardware-murni" untuk QA deteksi-dalam.
- Batasan (tulis eksplisit di UI & docs): **butuh kabel USB** (tidak wireless), tanpa video di jalur ini (display tetap `scrcpy` via adb kalau adb juga aktif; atau tanpa display sama sekali untuk skenario OTG-murni), device harus terhubung USB langsung ke host tempat agent/core jalan, satu-satunya use case utama = red-team detektor sendiri (framing §17).
- Implementasi: akses USB level host via libusb (paket npm `usb` — native module; kompatibilitas Bun **TODO-verify**; alternatif: helper binary kecil via Toolchain Manager). Registrasi HID: AOA `ACCESSORY_REGISTER_HID` / `ACCESSORY_SEND_HID_EVENT` control request (**TODO-verify** urutan exact request AOAv2 + HID report descriptor mouse/keyboard yang dipakai scrcpy sebagai referensi).
- Engine: `packages/drivers/src/input/scrcpy-aoa.ts`, `mode: 'aoa'`, `locks: ['input-injection']`, `configSchema` (Zod): pilihan device USB. Muncul di dropdown Studio hanya kalau transport USB & platform host support (capability gating registry §8).

**(3) `appium` engine opt-in** (spec §6.3, §7.1, §9.5):

- Dua engine terdaftar: `appium` **Inspector** (nilai utama: WebView/hybrid context yang `ui-server` tidak bisa) dan `appium` **InputSink** (W3C actions). Keduanya `locks: ['instrumentation','input-injection']` → session manager **menolak** kombinasi dengan `ui-server` (instrumentation) dan dengan input scrcpy apa pun (input-injection) — user tidak pernah bisa memilih kombinasi tabrakan (spec §9.5).
- Instalasi via Toolchain Manager sebagai tool **opsional** (`appium` + driver `uiautomator2`): berat ~500MB/instalasi, butuh JVM? — Appium server = Node; UiAutomator2 server = APK + JVM tooling di host untuk beberapa operasi (**TODO-verify** dependency exact: Node runtime untuk appium server — bundling Node kecil via toolchain vs jalankan dengan Bun compat — jangan asumsikan Bun bisa menjalankan appium server; verifikasi dulu).
- Lifecycle: `appium` server = child process per session (port dinamis, dibunuh saat session stop). Driver core bicara ke Appium via W3C WebDriver HTTP (create session dengan `platformName: Android`, `appium:udid: <serial>`, `appium:automationName: UiAutomator2`).
- UI: di Tools tampil "optional, ~500MB"; di device panel, memilih inspector `appium` otomatis men-disable pilihan input scrcpy (renderer sudah membaca locks dari registry — Plan 07).

### 4.7 Deployment control plane

- **Image:** `Dockerfile.cp` (extend image Plan 09): `ENKAKU_MODE=orchestrator`, tanpa adb/scrcpy provisioning device (agent yang butuh itu), expose 443 (di belakang reverse proxy) + UDP range RTP kalau werift butuh port range (**TODO-verify** kebutuhan port ICE host candidate).
- **Compose contoh** `docs/deploy/cloud.md`: services `enkaku-cp`, `coturn` (dengan `external-ip`, long-term credential dari env), reverse proxy (Caddy/Traefik) untuk TLS/domain — TLS wajib (spec §14).
- **Konfigurasi CP** (env, Zod-validated): `ENKAKU_MODE`, `ENKAKU_PUBLIC_URL`, `ENKAKU_TURN_URL/USER/PASS`, `ENKAKU_ISOLATION=container`.
- Billing/seat: tidak ada (Non-goal; Open question #1).

## 5. Langkah implementasi

> Konvensi: tiap tahap menyebut file & hasil verifikasi. Kerjakan berurutan per sub-fase; tiap sub-fase diakhiri acceptance criteria sendiri (gerbang sebelum lanjut).

### 5.1 Sub-fase M8a — Agent & tunnel

**A.1 — Ekstraksi modul session-hosting dari core**
- [ ] Audit `packages/core`: identifikasi logika yang dibutuhkan agent (DeviceSession factory, stableId probe, per-device queue+semaphore, toolchain resolve path). Pindahkan yang belum package-terpisah ke `@enkaku/drivers`/`@enkaku/adb`/`@enkaku/toolchain` (tanpa mengubah perilaku; core import balik dari package).
- [ ] File tersentuh: `packages/core/src/**` (import path), package terkait.
- [ ] **Verifikasi:** `bun test` seluruh workspace hijau; smoke Plan 08 (LAN video+input) masih jalan — refactor netral.

**A.2 — Protokol tunnel di `packages/protocol`**
- [ ] `packages/protocol/src/tunnel.ts`: `RoutedEnvelope` (v, agentId, deviceId, tenantId), message `agent.hello|hello.ack|devices`, `session.start|stop`, `job.dispatch`, `tunnel.ping|pong`, `tunnel.channel.open|close` (§4.2) — semua Zod, masuk discriminated union utama.
- [ ] Encoder/decoder binary frame `[0x02][channelId u16][payload]` + unit test round-trip.
- [ ] **Verifikasi:** `bun test packages/protocol` hijau; parse pesan lama tanpa field routing tetap lolos (backward compat).

**A.3 — Skeleton `packages/agent`**
- [ ] Buat `packages/agent` sesuai struktur §4.1: `config.ts` (Zod + state file `agent.json`), `index.ts` (wiring), `bridge/session-host.ts` (rakit engine via package hasil A.1), `bridge/device-bridge.ts` (handle `session.start/stop`, teruskan input/inspector command ke DeviceSession, pipe frame display → channel binary).
- [ ] Agent memakai Toolchain Manager sendiri di `ENKAKU_DATA_DIR` agent (auto-provision adb+scrcpy-server saat first run — reuse Plan 02).
- [ ] **Verifikasi:** `bun run packages/agent` tanpa CP → log jelas "waiting for control plane / not enrolled", tidak crash.

**A.4 — Enrollment & auth agent (sisi CP)**
- [ ] Migration Drizzle: tabel `agents` (§4.3) + kolom `devices.agentId`.
- [ ] `packages/core/src/api/agents.ts`: `POST /api/agents` (admin; buat record+token), `POST /api/agents/enroll` (tukar token→credential), `GET /api/agents`, `DELETE /api/agents/:id` (revoke+putus tunnel). Audit log untuk semua (spec §14).
- [ ] `packages/agent/src/enroll.ts`: pakai `ENKAKU_ENROLL_TOKEN` sekali → simpan credential ke `agent.json`.
- [ ] Studio: halaman **Agents** (list + add + token tampil sekali + revoke) — `packages/studio` route baru.
- [ ] **Verifikasi:** curl enroll dengan token benar → 200 + credential; token dipakai dua kali → 401; unit test hash/one-time.

**A.5 — Tunnel client (agent) + router (CP)**
- [ ] `packages/agent/src/tunnel/client.ts`: connect `GET /agent/ws` + Bearer; kirim `agent.hello`; kirim snapshot+delta `agent.devices` dari track-devices; keepalive ping 20s; reconnect exponential backoff+jitter cap 60s (§4.2), reset setelah stabil 60s.
- [ ] `packages/core/src/tunnel/{registry,router,channels}.ts`: terima koneksi agent, upsert devices (`agentId` diisi), route envelope by `agentId/deviceId`, alokasi channelId, remux binary ke viewer WS (`relay/ws-relay.ts`).
- [ ] Mode flag: `packages/core/src/mode.ts` + guard supaya subsistem device-lokal tidak start di orchestrator.
- [ ] Backpressure drop-frame non-IDR di relay (pakai flag keyframe dari meta scrcpy — sudah ada Plan 08).
- [ ] **Verifikasi:** jalankan CP (`ENKAKU_MODE=orchestrator`, DB kosong) + agent di mesin sama; device USB muncul di Studio CP; matikan agent → device `offline` ≤ 30s; nyalakan lagi → online tanpa restart CP.

**A.6 — Remote session & job lewat tunnel**
- [ ] Sambungkan lease/queue CP (Plan 04) ke dispatch tunnel: `manual` session → `session.start` ke agent, input message dari browser di-route (CP validasi lease dulu — reject saat `busy` tetap di CP).
- [ ] Video: frame channel → ws-relay → browser WebCodecs (belum WebRTC; ini baseline fungsional + fallback path M8b).
- [ ] Job: `job.dispatch` bawa bundle (isi bundle base64/chunked lewat WS, atau `bundleRef` + `GET /api/bundles/:id` yang di-fetch agent — pilih fetch HTTP, lebih sederhana untuk file besar); agent spawn runner Plan 05 (masih stdio, mode `process`); log/artifact stream balik via envelope (artifact upload: `POST /api/jobs/:id/artifacts` dari agent dengan credential agent).
- [ ] **Verifikasi:** dari Studio CP — remote klik device di balik agent (latency LAN); enqueue job script Plan 05 → jalan di agent, log realtime & artifact muncul di job detail CP.

**Acceptance criteria M8a** (semua harus lulus sebelum M8b):
- [ ] Agent di **network lain** dari CP (lihat test plan §7.1), tanpa satu pun port terbuka di sisi agent: device terlihat, remote control jalan, job jalan, artifact sampai.
- [ ] Enrollment token sekali pakai; credential salah → tunnel ditolak (4401) + backoff.
- [ ] Cabut jaringan agent 2 menit → device offline di Studio; jaringan balik → recover otomatis < 90s tanpa intervensi.
- [ ] Mode local (Plan 01–10) tidak berubah perilaku: seluruh smoke test Plan 08/09 masih lulus.
- [ ] `bun test` hijau (routing, backoff, channel mux, enrollment).

### 5.2 Sub-fase M8b — WebRTC video

**B.1 — Riset & verifikasi library (timebox, hasil tertulis)**
- [ ] Spike terpisah (branch/scratch): validasi werift di Bun — buat PC, ICE dengan coturn lokal, kirim RTP H.264 statis ke Chrome. Ukur CPU per stream. (**TODO-verify** items §4.4.)
- [ ] Tulis hasil ke `docs/plans/notes/m8b-webrtc-spike.md` (satu-satunya artefak riset; keputusan library final diisi ke Open question #2 → minta keputusan manusia bila hasil ambigu).
- [ ] **Verifikasi:** video test pattern H.264 tampil di browser via werift ATAU keputusan pindah plan-B (GStreamer sidecar) terdokumentasi.

**B.2 — RTP packetizer RFC 6184**
- [ ] `packages/core/src/relay/webrtc/annexb.ts`: split Annex B → NAL units (start code 3/4 byte), deteksi SPS/PPS/IDR (nal_unit_type 7/8/5) + unit test dengan sample bitstream dari scrcpy capture (simpan fixture kecil di repo).
- [ ] `packages/core/src/relay/webrtc/rtp-h264.ts`: Single NAL + FU-A (MTU payload ~1200B), timestamp 90kHz dari pts, marker bit akhir access unit, SPS/PPS in-band sebelum IDR + unit test (fragmen → reassembly referensi).
- [ ] **Verifikasi:** `bun test` packetizer hijau; paket hasil dites decode oleh browser di B.3.

**B.3 — PC server-side + signaling + ICE config**
- [ ] `packages/core/src/relay/webrtc/peer.ts`: interface `RtcPeer` (§4.4) + impl library terpilih; sendonly H.264; handle RTCP PLI → forward permintaan IDR ke agent (atau restart stream — sesuai hasil TODO-verify B.1).
- [ ] Protocol: message `video.webrtc.request|offer|answer|ice|failed|stop` di `packages/protocol`.
- [ ] `GET /api/webrtc/ice-config` (baca env TURN §4.7).
- [ ] Studio player: `packages/studio` — state machine `webrtc-connecting → webrtc | ws-fallback` (§4.4), badge "degraded" saat fallback, LAN mode tak tersentuh.
- [ ] **Verifikasi:** device di balik agent ditonton via WebRTC di jaringan lokal dulu (CP+browser satu LAN, paksa `iceTransportPolicy` default): `chrome://webrtc-internals` menunjukkan frame diterima, decode jalan.
- [ ] **Verifikasi fallback:** matikan komponen WebRTC (env flag) → player otomatis WS, video tetap jalan.

**B.4 — coturn & jalur internet**
- [ ] `docs/deploy/cloud.md`: compose CP + coturn (long-term credential, `external-ip`), catatan port UDP.
- [ ] Test end-to-end lewat internet/NAT nyata (test plan §7.2), termasuk `iceTransportPolicy: 'relay'` untuk memaksa jalur TURN.
- [ ] **Verifikasi:** video jalan dari browser di network lain; dengan UDP di-block (firewall host), TURN/TCP tetap tersambung ATAU fallback WS aktif dengan badge.

**Acceptance criteria M8b:**
- [ ] Uji `tc netem` (test plan §7.2): loss 3% delay 50ms → WebRTC tetap bergerak (freeze < 1s, recover sendiri); WS pada kondisi sama terbukti freeze berulang ≥ beberapa detik. Hasil (angka) dicatat di `docs/plans/notes/m8b-webrtc-spike.md`.
- [ ] Negosiasi gagal → fallback WS otomatis < 15s, tanpa reload halaman.
- [ ] LAN mode: masih WS+WebCodecs murni, NFR Plan 08 (glass-to-glass < 150ms) tidak regresi.
- [ ] Multi-viewer: 2 browser menonton device sama via WebRTC (fan-out di relay) tanpa stream scrcpy kedua ke device.

### 5.3 Sub-fase M8c — Security boundary per-job

**C.1 — Refactor IPC runner jadi transport-agnostic**
- [ ] `packages/core/src/runner/ipc.ts`: interface `RunnerTransport` (§4.5); refactor runner Plan 05 memakai `StdioTransport` (perilaku identik); tambah `SocketTransport` (TCP loopback + `RUNNER_TOKEN` per job).
- [ ] `packages/sdk` sisi runner-shim: entry `runner-shim.ts` yang bisa connect via env (`RUNNER_IPC=stdio|tcp://host:port`).
- [ ] **Verifikasi:** semua test runner Plan 05 hijau dengan stdio; test baru: job dummy jalan via SocketTransport di mode `process` (tanpa container) — bukti kontrak transport-agnostic.

**C.2 — ContainerRuntime + image runner**
- [ ] `packages/core/src/runner/container.ts`: `ContainerRuntime` (deteksi docker/podman, `run/kill/wait`), opsi hardening baris §4.5 flow (read-only, cap-drop, memory, pids-limit, network restricted).
- [ ] `Dockerfile.runner` → image `enkaku-runner:<coreVersion>` (Bun + runner-shim; **tanpa** adb/scrcpy/credential apa pun).
- [ ] Konfigurasi `ENKAKU_ISOLATION=process|container` (agent & core local); orchestrator multi-tenant menolak `process`.
- [ ] **Verifikasi:** `docker run enkaku-runner --help` jalan; unit test flag hardening ter-compose benar (snapshot argv).

**C.3 — Eksekusi job dalam container (di agent)**
- [ ] `packages/agent`: alur §4.5 (bundle → dir kerja ro-mount → run container → shim connect balik SocketTransport → device ops via bridge → kill+cleanup). Timeout job = `docker kill`.
- [ ] Network container: hanya bisa mencapai IPC listener (docker network internal / host-gateway rule — **TODO-verify** mekanik per runtime, tulis hasil di README agent).
- [ ] **Verifikasi:** script Plan 05 contoh jalan end-to-end dalam container via tunnel; screenshot artifact sampai ke CP.
- [ ] **Verifikasi isolasi (negatif):** bundle "jahat" uji: (a) baca `/etc/passwd` host → gagal (yang terbaca punya container), (b) `fetch('https://example.com')` → gagal (egress deny), (c) scan port host → hanya IPC port reachable, (d) fork-bomb → mati oleh pids-limit tanpa mengganggu agent, (e) alloc > 512MB → OOM-kill container saja.

**C.4 — Tenant scoping DB**
- [ ] Migration: tabel `tenants`, kolom `tenantId` di `users/devices/agents/scripts/jobs/audit_log` (backfill tenant `default`).
- [ ] Data layer: helper `scoped()` + refactor semua repo query; role `superadmin`; session auth membawa `tenantId`.
- [ ] API: semua endpoint & WS handler CP mem-filter by tenant dari session (bukan dari parameter client!).
- [ ] **Verifikasi:** unit test: user tenant A tidak bisa list/control device, script, job, agent tenant B (404, bukan 403 bocor-info); mode local tetap satu tenant `default` tanpa perubahan UX.

**Acceptance criteria M8c:**
- [ ] Semua verifikasi negatif C.3 lulus dan diskrip sebagai test berulang (lihat §7.3).
- [ ] Overhead startup job container terukur & dicatat (target awal: tambahan < 3s dengan image warm; bandingkan dengan NFR job overhead spec §16 — kalau lebih, catat di Open question #5, jangan diam-diam menurunkan target).
- [ ] `process` mode masih default & identik untuk local single-tenant (smoke Plan 05 lulus).
- [ ] Cross-tenant isolation test suite hijau.

### 5.4 Sub-fase M8d — Driver tambahan

**D.1 — redroid (`adb-tcp`)**
- [ ] `docs/deploy/redroid.md` (§4.6): prasyarat kernel, run command, enroll by IP, catatan emulator-detection + badge.
- [ ] Probe `deviceKind` saat enroll (`ro.hardware`/`ro.product.*`) → simpan di `devices.settings`; Studio dashboard tampilkan badge `redroid/emulator`.
- [ ] Verifikasi scrcpy + ui-server + input di redroid (encoder SW bila perlu — hasil TODO-verify ditulis ke docs).
- [ ] **Verifikasi:** redroid container di VPS ter-enroll via agent/CP, remote view + satu script contoh sukses end-to-end.

**D.2 — `scrcpy-aoa` InputSink**
- [ ] Spike USB: verifikasi library akses USB dari Bun (npm `usb` / helper binary — **TODO-verify**); hasil ke `docs/plans/notes/m8d-aoa-spike.md`.
- [ ] `packages/drivers/src/input/scrcpy-aoa.ts`: AOAv2 HID register + send event (referensi implementasi scrcpy), `mode: 'aoa'`, `locks: ['input-injection']`, configSchema pemilihan USB device; registry entry + capability gating (hanya muncul kalau host support & device via USB).
- [ ] Docs/UI: batasan (kabel wajib, no-video di jalur ini, use case QA deteksi-dalam — framing spec §17).
- [ ] **Verifikasi:** dengan kabel USB, tap/swipe/key dari Studio sampai ke device **tanpa** `input-injection` lain aktif; kombinasi dengan `scrcpy-uhid` ditolak session manager (locks).

**D.3 — `appium` engine opt-in**
- [ ] Toolchain: manifest entry `appium` (optional, size warning ~500MB, `swappable: true`), install = `npm/appium + driver uiautomator2` ke dir toolchain (**TODO-verify** cara instalasi offline-friendly & runtime Node yang dibutuhkan — jangan asumsikan Bun menjalankan appium server; kalau butuh Node, Node kecil ikut di-manage toolchain).
- [ ] `packages/drivers/src/inspector/appium.ts` + `packages/drivers/src/input/appium.ts`: lifecycle server per session (spawn, port dinamis, health, kill), W3C WebDriver client tipis (create session UiAutomator2, `getPageSource`/context WebView untuk inspector, W3C actions untuk input). `locks: ['instrumentation','input-injection']` di keduanya.
- [ ] Studio: pilih inspector `appium` → input scrcpy ter-disable otomatis (renderer locks Plan 07); Tools UI menampilkan appium optional.
- [ ] **Verifikasi:** app hybrid contoh (WebView) — `dump()` via appium mengembalikan elemen dalam WebView yang `ui-server` tidak lihat; aktivasi appium bersamaan `ui-server` → ditolak dengan error code jelas.

**Acceptance criteria M8d:**
- [ ] Ketiga verifikasi D.1–D.3 lulus.
- [ ] Registry `/api/registry` memuat engine baru dengan `capabilities/configSchema/locks` benar; tidak ada kombinasi tabrakan yang bisa dipilih dari Studio.
- [ ] Semua tool baru melewati aturan §7.8 spec (sha256 untuk artefak yang di-download, tolak delete versi aktif).

### 5.5 Penutup — deployment & dokumentasi

- [ ] `Dockerfile.cp` + `docs/deploy/cloud.md` final (CP + coturn + reverse proxy TLS + domain; §4.7).
- [ ] README `packages/agent` (install, enroll, env, troubleshooting NAT).
- [ ] Update `docs/spec.md` HANYA kalau implementasi menemukan kontradiksi (aturan overview §1) — via catatan, bukan diam-diam.
- [ ] `LICENSES.md` ditambah: library WebRTC terpilih, coturn (deploy-time, bukan redistribusi), redroid (catatan lisensi & redistribusi — cek, spec §18), appium (Apache-2.0), libusb/`usb`.
- [ ] **Verifikasi:** deploy dari nol di VPS bersih mengikuti docs sendiri (tanpa pengetahuan di luar dokumen) berhasil sampai video WebRTC jalan.

## 6. Acceptance criteria (final, seluruh M8)

- [ ] Acceptance criteria keempat sub-fase (§5.1–5.4) semuanya lulus.
- [ ] **Skenario demo end-to-end:** CP + coturn di VPS (TLS + domain), agent di jaringan kantor (NAT, tanpa port-forward) dengan 1 device fisik USB, 1 redroid di VPS: login Studio cloud → dua device terlihat (badge redroid benar) → remote control device fisik via WebRTC → enqueue script dalam container → log realtime + artifact → revoke agent → device hilang & tunnel mati.
- [ ] Multi-tenant: dua tenant dengan agent masing-masing — saling tidak melihat apa pun milik tenant lain.
- [ ] Mode local (single binary Plan 09) tidak regresi: smoke test Plan 08 & 09 lulus utuh.
- [ ] `bun test` hijau seluruh workspace; tidak ada `TODO-verify` yang tersisa di kode ter-ship (semua sudah diverifikasi atau dieskalasi ke Open questions).
- [ ] Definition of Done global overview §7 terpenuhi (README, no-any, dst).

## 7. Test plan

### 7.1 M8a — Agent & tunnel

Unit (`bun test`):
- [ ] `packages/protocol`: round-trip RoutedEnvelope & binary frame; reject envelope `tenantId` yang di-set client.
- [ ] Router CP: route by agentId/deviceId, koneksi agent duplikat (agentId sama) → koneksi lama diputus.
- [ ] Backoff: deret delay dalam batas [0, min(60s, 2^n)] + reset setelah stabil (fake timer).
- [ ] Enrollment: token sekali pakai, hash tidak reversible, revoke memutus.

Smoke (manual, berskrip di README agent):
- [ ] **Simulasi NAT nyata:** CP di VPS publik (atau minimal host lain); agent di laptop di belakang router rumah/kantor ATAU network namespace terpisah:
  ```bash
  # opsi tanpa VPS (Linux): netns + NAT
  sudo ip netns add agentns
  sudo ip link add veth0 type veth peer name veth1 netns agentns
  # ... setup IP + iptables MASQUERADE (skrip lengkap: scripts/test/nat-sim.sh)
  sudo ip netns exec agentns bun run packages/agent
  ```
- [ ] Verifikasi tidak ada listener baru di sisi agent: `lsof -iTCP -sTCP:LISTEN -p <pid agent>` → kosong (kecuali IPC loopback M8c).
- [ ] Kill -9 agent saat job jalan → lease expiry Plan 04 membebaskan device; agent restart → re-attach bersih.

### 7.2 M8b — WebRTC

Unit:
- [ ] Annex B splitter: fixture bitstream scrcpy (start code 3/4-byte, AUD, SPS/PPS/IDR/P) → NAL list benar.
- [ ] RTP packetizer: NAL kecil → Single NAL; NAL 40KB → FU-A dengan S/E bit benar, reassembly = input; timestamp/marker per access unit.

Smoke / bukti klaim (skrip `scripts/test/netem-video.sh`, Linux host atau router VM di jalur agent↔CP):
```bash
# terapkan gangguan di interface jalur agent → CP
sudo tc qdisc add dev eth0 root netem loss 3% delay 50ms 10ms
# skenario A: player mode WS (paksa via query ?transport=ws) → amati freeze
# skenario B: player mode WebRTC → amati kontinuitas
sudo tc qdisc del dev eth0 root netem
```
- [ ] Catat metrik: durasi freeze terpanjang & jumlah freeze >500ms per 60s (WS vs WebRTC), dari `webrtc-internals` + timestamp overlay di video test (jalankan clock app di device). Ekspektasi lulus: WebRTC freeze < 1s & recover; WS menunjukkan stall multi-detik. Sertakan juga varian `loss 5%`.
- [ ] TURN-only: browser dengan `iceTransportPolicy:'relay'` (toggle dev di Studio) → tetap tersambung via coturn.
- [ ] Fallback: matikan coturn + block UDP → player jatuh ke WS < 15s dengan badge degraded.
- [ ] Multi-viewer: 2 tab menonton; keduanya dapat frame; CPU CP dicatat.

### 7.3 M8c — Isolation

Unit:
- [ ] `RunnerTransport`: stdio & socket lulus test suite kontrak yang sama (parametrized).
- [ ] Compose argv container: snapshot flag hardening; token IPC per-job unik & expired setelah job.
- [ ] Tenant scoping: repo layer parametrized test cross-tenant (A tidak melihat B) untuk devices/scripts/jobs/agents.

Smoke (skrip `scripts/test/escape-suite/` — bundle-bundle nakal sebagai fixture):
- [ ] `read-host-fs`, `egress-fetch`, `port-scan`, `fork-bomb`, `mem-hog` (deskripsi di C.3) → semua terkontain; agent & job lain tidak terganggu (jalankan job normal paralel saat fork-bomb).
- [ ] Ukur job overhead `container` vs `process` (10 run, median) → catat di hasil A/C M8c.

### 7.4 M8d — Driver tambahan

- [ ] Unit: locks conflict matrix — semua kombinasi engine di-generate, session manager menolak persis yang share lock (`appium` × `ui-server`, `appium` × `scrcpy-*` input, `scrcpy-aoa` × input lain).
- [ ] Smoke redroid: skrip di `docs/deploy/redroid.md` dijalankan verbatim di VPS Ubuntu LTS → enroll → script contoh sukses; badge emulator tampil.
- [ ] Smoke AOA (butuh device fisik + kabel, tandai `ENKAKU_TEST_DEVICE=1`): tap presisi 5 titik → bandingkan koordinat via screenshot; cabut kabel saat session → error jelas + session close rapi.
- [ ] Smoke appium: install via Tools UI (progress + size warning) → session inspector di app WebView → elemen web ditemukan; uninstall bersih (dir toolchain terhapus).

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Library WebRTC server-side tidak jalan baik di Bun (werift belum terverifikasi, wrtc native-ABI) | M8b macet | Spike timebox B.1 **sebelum** menulis relay; interface `RtcPeer` supaya swap murah; plan B GStreamer sidecar sudah didesain |
| Head-of-line tetap terasa karena TURN/TCP fallback (TURN over TCP = balik ke TCP) | Ekspektasi kualitas video meleset di network ketat | Dokumentasikan honestly; badge "degraded"; prioritas UDP di coturn config |
| Bandwidth relay CP membengkak (semua video lewat cloud) | Biaya hosting SaaS | Ukur bitrate/session sejak M8b (metrics); cap bitrate scrcpy per-device configurable; P2P opsional = future (Open question #4) |
| Refactor A.1/C.1 menyentuh kode Plan 05/08 yang sudah stabil | Regresi mode local | Aturan refactor netral: test lama harus hijau sebelum fitur baru ditumpuk; smoke Plan 08/09 diulang di A/C M8a & M8c |
| Docker tidak tersedia/diizinkan di host agent customer | M8c tak jalan di sebagian deployment | `IsolationMode` per farm + dukung Podman rootless; dokumen prasyarat; multi-tenant menolak start tanpa container (fail-loud, bukan silent-degrade) |
| AOA HID rapuh (permission USB host, kabel, chipset) | Fitur niche makan waktu | Scope ketat opt-in + spike D.2 dulu; boleh dipangkas jadi "experimental" tanpa memblok rilis M8 (catat di Open question #7) |
| Appium berat & rantai dependensi panjang (Node, APK server) | Toolchain kompleks | Opt-in murni; kalau instalasi offline-friendly tidak feasible, turunkan jadi "bring-your-own-appium" dengan URL server eksternal (Open question #8) |
| Protokol tunnel jadi titik kompatibilitas agent↔CP lintas versi | Farm campur versi rusak diam-diam | Field `v` di envelope + `agent.hello` bawa versi; CP tolak versi tak cocok dengan pesan upgrade yang jelas |
| Satu WS tunnel per agent = single TCP untuk banyak device (HOL antar-device di tunnel leg) | Video multi-device saling ganggu di uplink jelek | Diterima untuk v1 (uplink kantor biasanya sehat); ukur di M8b; opsi koneksi WS terpisah per-video-channel = future |

## 9. Open questions

1. **Billing/seat/kuota per tenant** — di luar scope M8 (Non-goal). Model harga, metering menit-device, kuota artifact per tenant: butuh keputusan bisnis. Skema DB `tenants` sengaja minimal agar tidak mengunci arah.
2. **Library WebRTC final** — rekomendasi: **werift** (pure TS, selaras Bun & self-contained), plan B GStreamer sidecar. Keputusan final setelah spike B.1 (bukti: jalan di Bun + CPU/stream masuk akal). Kalau dua-duanya gagal: wrtc di sidecar proses Node? Eskalasi ke manusia dengan data spike.
3. **NFR video cloud** — spec §16 hanya memberi target LAN. Target internet (latency glass-to-glass, fps minimum di loss 3%) belum didefinisikan; M8b mencatat angka aktual, manusia menetapkan target resmi untuk marketing.
4. **P2P browser⇄agent opsional** (hemat bandwidth CP) — arsitektur v1 sengaja terminate di CP (§3.2). Layak future flag?
5. **Job overhead containment** — kalau container menambah > 3s (NFR §16 job overhead), apakah target NFR direvisi untuk mode cloud, atau investasi pre-warmed container pool? Butuh angka dari C-benchmark dulu.
6. **Network egress dari bundle script** — default deny (§4.5). Ada use case sah script butuh internet (mis. fetch test fixture)? Kalau ya: per-script allowlist domain? Keputusan produk.
7. **Status `scrcpy-aoa`** — kalau spike D.2 menunjukkan dukungan USB dari Bun terlalu rapuh, apakah dirilis sebagai "experimental" atau ditunda pasca-M8? (Spec menempatkannya di M8, tapi opt-in.)
8. **Distribusi appium** — instalasi ~500MB via toolchain vs "bring-your-own-appium" (user kasih URL appium server sendiri)? Tergantung hasil TODO-verify D.3 soal dependency Node & kelayakan offline install.
9. **Audio di cloud** — scrcpy sudah bisa audio; WebRTC track audio menyusul kapan? (Tidak disebut eksplisit di spec §5.3 untuk M8.)
10. **Reset device antar-lease untuk multi-tenant** (spec §14 data hygiene) — kebijakan default cloud: wajib atau opt-in per farm? Menyentuh UX & durasi turnaround device; butuh keputusan produk.
11. **`tenantId` di `devices` vs kepemilikan via agent** — desain sekarang: device mewarisi tenant dari agent-nya. Apakah ada kasus device di-share lintas tenant (internal farm penyedia)? Kalau ya butuh model sharing eksplisit — jangan diimplementasikan sebelum diputuskan.
