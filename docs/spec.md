# Enkaku — Product Spec

> **Codename: Enkaku** (遠隔 — "jarak jauh / remote"). Nama placeholder, bebas diganti.
> Platform device farm untuk remote control + automation smartphone Android, self-hosted & zero-config, dengan opsi cloud.
> Status dokumen: **draft v0.2** — living document.
>
> **Changelog v0.1 → v0.2:** revisi setelah riset prior-art & verifikasi klaim teknis. Perubahan besar: (1) scrcpy-server di-pin ke versi core, bukan user-swappable; (2) adb mutex diganti per-device queue + semaphore longgar; (3) inspector pakai persistent on-device server (pola uiautomator2), bukan `uiautomator dump` naif; (4) klaim "sandbox" dikoreksi jadi jujur soal trust model; (5) device identity pakai ID stabil, bukan serial adb; (6) cloud mode kemungkinan butuh WebRTC, bukan WS+WebCodecs mentah; (7) tambah §6 perbandingan kompetitor, §9 input injection modes (buat QA detection-testing), enrollment flow, battery/thermal, NFR, retention/lisensi. Ringkasan sumber di §21.

---

## 1. Ringkasan & visi

Enkaku adalah **device farm platform** end-to-end: sistem yang membuat sekumpulan smartphone Android bisa di-*remote control* (lihat layar + klik dari browser) dan di-*automation* (script berjalan otomatis dalam antrian yang aman) melalui satu web UI.

Target pengalaman akhir:

> **User tinggal install → running → langsung jalan.** Tidak perlu install adb manual, tidak perlu config PATH, tidak perlu ngerti terminal. Semua dependency (adb, scrcpy, dsb) di-manage oleh aplikasi sendiri lewat UI.

Dua audiens:

1. **Internal** — tim programmer di kantor butuh alat untuk remote + test app di banyak device fisik sekaligus.
2. **Produk jual** — dijual sebagai QA/test-automation device farm (positioning ala BrowserStack / AWS Device Farm, tapi self-hostable dan murah).

**Kenapa ini masih relevan padahal open source udah banyak?** Lihat §6 — TL;DR: yang ada sekarang (STF/DeviceFarmer) arsitekturnya tua & mentok Android 9, dan yang modern (ws-scrcpy-web) cuma *mirroring*, tanpa lease/queue/script-framework/multi-user. Enkaku = gabungan remote-modern + orchestration + automation dalam satu paket zero-config. Belum ada yang isi celah itu sebagai produk matang.

---

## 2. Prinsip desain (non-negotiable)

| Prinsip | Artinya secara konkret |
|---|---|
| **Zero-config** | First run auto-provision semua tool, auto-detect device, buka browser. Tidak ada langkah manual wajib. |
| **Self-contained** | Tidak bergantung pada tool yang ada di sistem user. adb/scrcpy/dsb di-download & di-manage sendiri oleh app ke folder app-local, bukan system PATH. |
| **Schema-driven UI** | Setiap komponen (tool, driver engine, script) mendeskripsikan config-nya sebagai schema. Studio me-*render* UI manajemen dari schema itu secara dinamis. Nambah komponen baru = otomatis dapat panel setting, tanpa nulis UI baru. |
| **Pluggable & swappable** | Transport, display, input, inspection, dan tool semuanya modular. Ganti/update satu bagian tanpa menyentuh yang lain — **kecuali pasangan yang memang coupled ketat** (lihat aturan scrcpy §7.6). |
| **Server-authoritative** | Semua aturan (lease, konflik resource, ACL) di-enforce di core, bukan di UI. Client tidak pernah dipercaya. |
| **Portable runtime** | Core adalah daemon yang bisa jalan di macOS, Linux x64/arm64, dalam container, atau di SBC kecil. |

---

## 3. Persona & use case

- **Programmer (operator).** Register device, remote control manual buat debug, jalanin script test, lihat log & artifact.
- **Admin / owner.** Manage user, atur device, atur tool version, atur ACL, monitor farm.
- **Script author.** Nulis script automation pakai SDK (type-safe, di editor sendiri), publish ke farm.
- **End customer (mode jual).** Install appliance/binary, colok device, langsung pakai lewat browser tanpa ngerti isinya.

Use case utama:

1. Remote lihat + klik satu device dari browser (low latency).
2. Jalanin automation script di banyak device dalam antrian, bergantian & aman.
3. Manage library script (CRUD, versioning, run dengan parameter).
4. Manage device (nama, owner, driver config, per-device settings).
5. Manage toolchain (adb/scrcpy: install, update, pin, delete versi) lewat UI.
6. **Testing app sendiri terhadap deteksi automation** (red-team detektor sendiri) — lihat §9 & §17.

---

## 4. Arsitektur tingkat tinggi

Tiga artifact utama:

- **Core** — daemon (Bun + Hono). Orkestrator: device registry, driver, session/lease, queue, script runner, toolchain manager, API + WebSocket. Jalan dekat device (butuh USB/LAN).
- **Studio** — web UI (Next.js). Dashboard, remote control, script manager, toolchain manager, settings. Bisa di-serve oleh core sendiri (lokal) atau hosted (cloud).
- **SDK** — package npm (`@enkaku/sdk`). `defineScript`, tipe, `DeviceDriver` interface. Dipublish supaya script author nulis di editor sendiri dengan autocomplete penuh.

Komunikasi **Core ⇄ Studio** = message-based over WebSocket (bukan REST-first), supaya transport gampang dipindah ke model relay/tunnel saat pindah ke cloud tanpa mengubah kontrak message.

```
packages/
  core/        # Bun + Hono daemon (orkestrator)
  studio/      # Next.js web UI
  sdk/         # defineScript, DeviceDriver, tipe — dipublish ke npm
  protocol/    # schema message Core⇄Studio (Zod), shared types
  adb/         # adb client + track-devices + scrcpy-server manager
  scrcpy/      # scrcpy protocol client (demux socket, decode meta) — versi-locked ke core
  toolchain/   # runtime/tool provisioning (download, version, checksum)
  drivers/     # implementasi transport/display/input/inspection
  agent/       # mini-core buat cloud tunnel (M8)
apps/
  desktop/     # shell Tauri (native window + tray + auto-update)
```

> **Catatan arsitektur (dari riset ws-scrcpy):** ada dua mazhab bikin scrcpy jalan di browser. (a) **Modified scrcpy-server** — build ulang scrcpy-server dengan WebSocket server tertanam (dipakai NetrisTV/ws-scrcpy lama). (b) **Vanilla scrcpy-server** — pakai .jar resmi Genymobile apa adanya, host yang multiplex socket TCP-nya jadi satu WebSocket, browser yang demux + decode (dipakai ws-scrcpy-web baru). **Enkaku pilih (b)** karena: pakai .jar resmi = ikut rilis upstream, tidak perlu maintain fork Java, dan checksum-nya bisa diverifikasi ke rilis resmi. Konsekuensinya `packages/scrcpy` (protokol client di sisi host+browser) yang harus di-maintain dan di-pin (lihat §7.6).

---

## 5. Mode deployment

Topologi penting: **core harus dekat device** (USB/LAN). Yang boleh pindah ke cloud adalah *control plane* (Studio + orchestrator + relay), sementara core yang nempel device tetap di lokasi device.

### 5.1 Local self-host (default, paling gampang)

Satu binary (hasil `bun build --compile`). Double-click → core nyala → serve Studio di `localhost` → buka browser otomatis. SQLite dibuat di app data dir. Device di-colok/konek WiFi, auto-detect. **Ini mode "orang awam tinggal install".**

Varian UX lebih rapi: shell **Tauri** (native window + system tray + auto-update) yang membungkus core + Studio.

### 5.2 Headless server / homelab

Core jalan sebagai service (systemd) di mini-PC / SBC / Proxmox. Studio diakses dari browser device manapun di jaringan. Cocok buat 10 device di kantor. Tersedia Docker image.

### 5.3 Cloud (split control plane)

Studio + orchestrator + relay di cloud (container image, tinggal deploy). Device tetap di kantor, di-handle oleh **agent** ringan (mini-core) yang membuka **outbound WebSocket tunnel** ke control plane — jadi tanpa port-forward, tembus NAT.

Ini juga jalur monetisasi SaaS: customer jalanin agent kecil di dekat device mereka, kamu host control plane.

> **⚠️ Revisi v0.2 — video di cloud butuh transport lain.** WS+WebCodecs bagus buat LAN. Tapi WebSocket = TCP; di internet, sekali ada packet loss, TCP head-of-line blocking bikin **seluruh video freeze** sampai retransmit selesai (kerasa banget di remote control real-time). Untuk cloud, jalur video harus dievaluasi ulang: opsi realistis = **WebRTC** (`RTCPeerConnection`, UDP, congestion control + partial reliability), atau minimal WebTransport (HTTP/3, QUIC). Kontrol/queue tetap boleh lewat WS (loss di situ tidak sepenting video). **Konsekuensi arsitektur:** relay di control plane harus bisa terminate WebRTC + repackage H.264 dari scrcpy jadi RTP. Ini bukan flag — masukkan sebagai kerjaan nyata di M8. LAN tetap pakai WS+WebCodecs (lebih simpel, no TURN/STUN).

### 5.4 Cloud device (opsional, tanpa HP fisik)

Untuk kasus yang tidak butuh device fisik: **redroid** (Android dalam container) di cloud. Core memperlakukannya sama seperti device fisik lewat transport `adb-tcp`. (Catatan: redroid = emulator, jadi banyak deteksi automation naif otomatis ke-flag — bagus buat throughput test, kurang buat test yang butuh "device asli".)

| Mode | Core lokasi | Device | Video transport | Untuk siapa |
|---|---|---|---|---|
| Local self-host | Mesin user | USB/WiFi lokal | WS + WebCodecs | Orang awam, dev tunggal |
| Headless server | Box di jaringan | USB/WiFi lokal | WS + WebCodecs | Kantor 10 device |
| Cloud split | Agent lokal + control plane cloud | Lokal, tunneled | **WebRTC** | Produk SaaS |
| Cloud device | Cloud | redroid | WebRTC | Testing tanpa HP fisik |

---

## 6. Analisis kompetitor / prior art (BARU di v0.2)

Riset menunjukkan kategori ini sudah ramai. Tapi tidak ada satu pun yang mengisi celah Enkaku (remote modern + orchestration + automation, zero-config, jual-able). Ini penting buat pitch **dan** buat nyontek bagian yang sudah proven.

### 6.1 STF / DeviceFarmer (OpenSTF)

Ini "gajah di ruangan" — persis kategori ini, open source (Apache-2.0), dan sudah 9 tahun.

- **Yang bagus & bisa dicontek:** model UI (grid device, live control browser, drag-drop APK, shell, reverse port forward, battery monitoring), konsep *device booking/lease*, dan `adbkit` (Node adb client — worth dilihat sbg referensi walau kita pakai Bun).
- **Kelemahan yang jadi peluang kita:**
  - **OpenSTF mentok Android 9.** Rilis resmi terakhir v3.4.1 tidak jalan di Android 10–15. DeviceFarmer (fork komunitas) "development lambat, dana dari waktu luang volunteer" (pengakuan mereka sendiri).
  - **Screen capture pakai `minicap`/`minitouch`** — teknologi lama, keteteran di Android baru, butuh prebuilt binary per-ABI. Kita pakai scrcpy (encode H.264 di HP, jauh lebih efisien & modern).
  - **Setup nightmare** — butuh orchestrate RethinkDB + banyak service + Docker ambassador. "Setting up took days." Ini persis anti-thesis zero-config kita.
  - **Trust model longgar** — dokumen mereka mengakui "little to no security between processes, devices tidak di-reset antar-pakai." Kita bisa positioning lebih rapi (lease bersih, `finish` clean-state).
- **Ambil pelajaran:** device farm itu "money sink" (hardware berat). Positioning appliance murah (§16) = pembeda nyata.

### 6.2 ws-scrcpy & ws-scrcpy-web (prior art PALING dekat)

`NetrisTV/ws-scrcpy` (dan penerusnya `bilbospocketses/ws-scrcpy-web`) = persis pola teknis inti Enkaku: server Node push scrcpy-server ke device, multiplex socket video/audio/control jadi **satu WebSocket** (prefix 1-byte channel), browser demux + decode H.264/H.265/AV1 lewat **WebCodecs**.

- **Yang mengejutkan (dan memvalidasi arsitektur kita):** ws-scrcpy-web **sudah** punya: bundled Node+ADB, **in-app updater buat Node/ADB/scrcpy-server**, SQLite store, device labels, mDNS scan, embed lib (`WsScrcpy.startStream()`). Artinya toolchain-manager-in-UI kita memang jalur yang benar — sudah ada yang buktikan.
- **Ambil pelajaran teknis:** pakai **vanilla scrcpy-server** + demux client-side (bukan fork Java), multiplex 1-byte prefix, WebCodecs sebagai decoder utama dengan fallback (MSE/Broadway/TinyH264 buat browser non-Chromium).
- **Celah yang kita isi (kenapa bukan sekadar pakai ws-scrcpy):** ws-scrcpy = **mirroring tool**, bukan farm platform. Tidak ada: lease/queue, script framework, multi-user/ACL, capability-based driver selection, job/artifact, schema-driven management. Enkaku = ws-scrcpy-nya kepakai sebagai **satu lapisan display/input**, dibungkus orchestration + automation.
- **Peringatan keamanan mereka (kita jangan ulangi):** semua varian ws-scrcpy nyala "no encryption, no authorization by default, listen on all interfaces." Untuk produk jual ini tidak boleh. Auth + TLS wajib di mode server/cloud (§14).

### 6.3 Appium (+ uiautomator2 driver)

Bukan device farm, tapi **standar de-facto automation** Android. Relevan sebagai *inspiration* inspector & sebagai engine opt-in.

- **Ambil pelajaran:** UiAutomator2 (Google-supported, dipakai Appium sebagai default engine) = cara paling matang baca UI tree + inject aksi. Tapi Appium berat (~500MB/sesi, JVM), jadi **opt-in engine** aja (§7), jangan default di box kecil.
- **Yang kita tiru lebih ringan:** pola **openatx/uiautomator2** — persistent server APK (JSONRPC over HTTP) di device, query cepat. Lihat §7.4.

### 6.4 Cloud services (BrowserStack, AWS Device Farm, HeadSpin, LambdaTest, DeviceLab)

- **Positioning kita:** self-hostable + murah + data tidak keluar (privacy pre-release build). Ini justru alasan orang cari alternatif OpenSTF (privacy + biaya cloud).
- **Yang mereka punya & kita butuh niru sebagai fitur jual:** parallel run, device selector by capability, video recording per-session, integrasi CI (BrowserStack punya "Verified Step" di Bitrise — kita bisa target integrasi CI serupa nanti).

### 6.5 Ringkasan tabel

| Kapabilitas | OpenSTF/DeviceFarmer | ws-scrcpy(-web) | Appium | Cloud SaaS | **Enkaku (target)** |
|---|---|---|---|---|---|
| Remote view+control browser | ✅ (minicap, tua) | ✅ (scrcpy modern) | ❌ | ✅ | ✅ (scrcpy modern) |
| Android 14/15 support | ❌ (mentok 9) | ✅ | ✅ | ✅ | ✅ |
| Lease/queue/scheduler | ⚠️ (booking dasar) | ❌ | ❌ | ✅ | ✅ |
| Script/automation framework | ❌ | ❌ | ✅ (kode) | ⚠️ | ✅ (`defineScript`) |
| Multi-user + ACL | ⚠️ | ❌ | ❌ | ✅ | ✅ |
| Zero-config install | ❌ (days) | ⚠️ (dekat) | ❌ | n/a | ✅ (target) |
| Toolchain manager in-UI | ❌ | ✅ (updater) | ❌ | n/a | ✅ |
| Self-host & murah | ✅ | ✅ | ✅ | ❌ | ✅ |
| Input hardware-like (UHID) | ❌ | ⚠️ | ❌ | ❌ | ✅ (§9) |

---

## 7. Subsistem: driver (4 lapisan ortogonal) + toolchain

"Driver" dipecah jadi empat abstraksi terpisah supaya tiap lapisan bisa di-swap sendiri. Kombinasi terbaik biasanya campuran.

```ts
interface Transport {                         // 1. cara nyambung
  id: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  serial: string                              // alamat transport (bisa berubah!)
  stableId: string                            // identity device stabil (lihat §7.5)
  exec(cmd: string): Promise<string>
}
interface DisplaySource {                     // 2. cara lihat layar
  id: string
  start(): Promise<void>
  onFrame(cb: (chunk: Uint8Array, meta: FrameMeta) => void): void
  stop(): Promise<void>
}
interface InputSink {                         // 3. cara kirim sentuhan
  id: string
  mode: 'sdk' | 'uhid' | 'aoa'                // lihat §9
  tap(p: Point): Promise<void>
  swipe(from: Point, to: Point, ms: number): Promise<void>
  key(code: KeyCode): Promise<void>
  text(s: string): Promise<void>
}
interface Inspector {                         // 4. cara baca isi UI
  id: string
  dump(): Promise<UiNode>
  find(sel: Selector): Promise<UiNode | null>
  screenshot(): Promise<Uint8Array>
}
```

Factory ngerakit → satu `DeviceSession`. Script hanya tahu handle ini, bukan engine di baliknya.

```ts
const session = await createSession({
  deviceId,
  transport:  'adb-usb',        // ← dipilih dari dropdown Studio
  display:    'scrcpy',
  input:      'scrcpy-uhid',    // default baru: hardware-like (§9)
  inspection: 'ui-server',      // persistent on-device server (§7.4)
})
```

### 7.1 Engine yang direncanakan (REVISI v0.2)

| Lapisan | Engine | Catatan |
|---|---|---|
| Transport | `adb-usb`, `adb-tcp` (wireless / redroid), `cloud-tunnel` | tunnel = agent outbound WS |
| Display | `scrcpy` (H.264/H.265, default), `screencap-loop` (MVP/fallback, ~3fps) | scrcpy encode di HP, host relay saja |
| Input | `scrcpy-uhid` (**default baru**, hardware-like), `scrcpy-sdk` (InputManager, kompat luas), `scrcpy-aoa` (OTG, tanpa adb), `adb-input` (fallback kasar), `appium` (opt-in) | detail §9 |
| Inspection | `ui-server` (persistent on-device, default), `appium` (WebView/hybrid, opt-in), `ocr-pixel` (last resort) | ganti `uiautomator dump` naif |

### 7.2 Toolchain Manager (runtime provisioning) — konsep

Ini yang mewujudkan "user ga perlu install apa-apa". Polanya seperti Playwright yang manage browser binary-nya sendiri, **dan sudah terbukti** di ws-scrcpy-web (in-app updater Node/ADB/scrcpy).

Core **tidak** mengharapkan adb/scrcpy ada di sistem. Semua tool di-download ke folder app-local ber-versi, dan driver me-resolve path binary dari sini — **tidak pernah dari system PATH**.

```
<app-data>/
  enkaku.db                         # SQLite
  tools/
    adb/
      35.0.1/adb                    # versi terpasang (user boleh swap)
      34.0.5/adb
      active -> 35.0.1              # pointer versi aktif
    scrcpy-server/
      <locked>/scrcpy-server.jar    # DIKUNCI ke versi core, bukan user-swappable (§7.6)
    ui-server/
      <bundled>/ui-server.apk       # on-device inspector server (§7.4)
    appium/                         # opsional, opt-in
  artifacts/<job-id>/...
```

App-data dir per platform: `~/Library/Application Support/Enkaku` (macOS), `%APPDATA%\Enkaku` (Windows), `~/.local/share/enkaku` atau `/var/lib/enkaku` (Linux/server).

### 7.3 Tool registry manifest

```ts
interface ToolManifest {
  id: 'adb' | 'scrcpy-server' | 'ui-server' | 'appium' | string
  displayName: string
  swappable: boolean            // BARU: false → user tak bisa pilih versi (mis. scrcpy-server)
  versions: ToolVersion[]
}
interface ToolVersion {
  version: string
  releasedAt: string
  compatibleCoreRange?: string  // BARU: semver range core yang cocok (buat tool coupled)
  platforms: {
    [platform: string]: { url: string; sha256: string; sizeBytes: number }
  }
  knownGood?: boolean
}
```

**Source abstraction** — tiap tool bisa datang dari: URL resmi (Google platform-tools, GitHub releases scrcpy), mirror self-host (air-gapped), atau **pre-baked di image** (cloud/container). Default = resmi.

### 7.4 Inspector: persistent on-device server (REVISI besar v0.2)

**Masalah `uiautomator dump` (v0.1):** satu dump 0.5–2 detik, gagal saat UI terus berubah ("could not get idle state"), hang di app tertentu. `waitFor` yang polling di atasnya bikin script merayap — waitFor 15 detik mungkin cuma 8–10 kali cek. Ini bottleneck kecepatan seluruh script framework.

**Solusi (pola openatx/uiautomator2):** deploy **server instrumentation persistent** di device (APK/`app_process`), expose query lewat HTTP lokal yang di-*forward* via adb. Sekali start, dipakai berkali-kali (device connect sekali, bukan reconnect tiap command). Query selector dieksekusi **di sisi device** → jauh lebih cepat, lebih tahan UI berubah, bisa `set_text`/`long_click`/`double_click` langsung ke elemen (lebih reliable buat WebView).

- MVP tetap boleh pakai `uiautomator dump` (M4) supaya cepat jadi, tapi `ui-server` masuk sebagai upgrade path prioritas karena **kecepatan inspector = kecepatan farm**.
- `ui-server.apk` di-bundle & di-manage Toolchain Manager (checksum, versi ikut core).

### 7.5 Device identity stabil (BARU v0.2)

**Masalah:** serial adb untuk wireless = `ip:port` yang berubah-ubah; HP yang sama via USB vs WiFi kedaftar sebagai **dua device** kalau identity cuma dari serial adb.

**Solusi:** saat connect, probe identity stabil sekali dan cache:
- Utama: `adb shell getprop ro.serialno` (serial hardware).
- Fallback: `Settings.Secure.ANDROID_ID` (per-app-signing tapi stabil per factory-reset).
- Serial adb → cuma **alamat transport**, bukan identity.

Efek: use case "colok USB buat enroll, lepas ke WiFi buat operasional" tidak bikin record duplikat. `devices.stableId` jadi primary identity (lihat §12).

### 7.6 Aturan scrcpy-server: DIKUNCI ke core (REVISI kritis v0.2)

**Kenapa beda dari adb:** protokol antara scrcpy-server.jar dan client **tidak stabil antar versi** dan sengaja "internal" oleh Genymobile — dokumen resmi mereka: *protokol bisa (dan akan) berubah kapan saja, tanpa backward/forward compatibility, client harus selalu dijalankan dengan versi server yang cocok*. Contoh nyata: v3.1 kemarin butuh **perubahan kode client** buat coordinate mapping, bukan cuma ganti nomor versi. Kalau UI Tools ngasih user bebas pilih versi scrcpy-server, satu update = **video/kontrol mati total**.

Aturan:
- `scrcpy-server` `swappable: false` → di UI Tools tampil sebagai **"managed by core"** (info versi + health, tanpa tombol pilih versi bebas).
- Satu versi core = satu versi scrcpy-server yang sudah ditest bareng `packages/scrcpy` client kita. Naik versi scrcpy = bagian dari rilis core (via `compatibleCoreRange`).
- **adb boleh bebas** (protokol adb stabil lintas versi). scrcpy jangan.

### 7.7 API + UI manajemen tool

```
GET  /api/tools                      → daftar tool + versi + aktif + swappable + status health
POST /api/tools/:id/install          → { version } download + verify (tolak kalau !swappable)
POST /api/tools/:id/activate         → { version } pindah pointer active (tolak kalau !swappable)
DELETE /api/tools/:id/:version       → hapus versi (tolak kalau aktif/dipakai)
POST /api/tools/:id/check            → health check (mis. `adb version`)
POST /api/tools/manifest/refresh     → fetch manifest terbaru
```

### 7.8 Aturan keamanan tool

- Verifikasi **sha256** wajib sebelum tool dipakai (checksum dari rilis resmi).
- Tolak delete versi yang sedang aktif / dipakai session hidup.
- Health check sebelum set active.
- Path binary di-resolve lewat Toolchain Manager; driver dilarang panggil PATH sistem.
- **Lisensi:** audit sebelum jual — adb (platform-tools, Google ToS soal redistribusi), scrcpy (Apache-2.0, OK), redroid, dsb. Lihat §18.

---

## 8. Registry & schema-driven UI

Semua komponen pluggable **self-describe** lewat schema, Studio render UI dari situ.

```
GET /api/registry
→ {
    transports:  [{ id, displayName, capabilities, configSchema, locks }],
    displays:    [{ id, displayName, capabilities, configSchema, locks }],
    inputs:      [{ id, displayName, capabilities, configSchema, locks }],
    inspectors:  [{ id, displayName, capabilities, configSchema, locks }],
    tools:       [{ id, displayName, swappable }],
  }
```

`configSchema` = JSON Schema (di-generate dari Zod). Studio pakai schema-driven form renderer → tiap engine/tool otomatis punya panel setting tanpa UI hardcode. **Capability + locks** dipakai buat validasi kombinasi: Studio disable pilihan yang mustahil/tabrakan (mis. inspector Appium butuh transport Appium; `appium` input & `scrcpy-uhid` sama-sama kunci `input-injection`) sebelum user salah pilih.

---

## 9. Input injection modes & testing deteksi (BARU + REVISI v0.2)

Bagian ini menjawab kebutuhan "automation-nya jangan gampang ketebak sistem HP" — **dalam framing yang benar: menguji detektor app buatan sendiri (red-team), bukan bikin bot siluman**. Positioning tetap QA (§17). Pengetahuan di bawah ini adalah pengetahuan QA legit: memahami *permukaan deteksi* supaya bisa menguji app kamu sendiri.

### 9.1 Kenapa automation bisa "ketebak" — permukaan deteksi

App bisa membedakan input asli vs injeksi lewat beberapa sinyal. Yang paling utama: **dari mana event masuk & flag-nya.**

- **Mode SDK (default banyak tool, termasuk `adb shell input` & scrcpy `--mouse=sdk`):** event di-inject lewat `InputManager.injectInputEvent` di level API Android. Event ini bisa membawa penanda yang membedakannya dari sentuhan hardware (mis. atribut source/flag event, tidak melewati driver input kernel). Detektor bisa cek ini. Juga: `adb shell input` lambat & jelas berpola (timing kaku).
- **Mode UHID (scrcpy 2.4+, `--keyboard=uhid`/`--mouse=uhid`):** scrcpy bikin **virtual HID device lewat kernel UHID module**. Dari sisi Android, ini muncul sebagai *physical input device* betulan (lewat driver input kernel), bukan event yang di-inject via API. Bekerja **wireless** (tak perlu kabel OTG). Ini jauh lebih menyerupai hardware asli.
- **Mode AOA/OTG (scrcpy `--otg`):** scrcpy jadi **physical HID peripheral** lewat protokol Android Open Accessory, **bypass total input stack Android OS** — bahkan tak butuh USB debugging. Paling "hardware-murni", tapi butuh kabel USB & tak ada video (khusus OTG).

**Implikasi buat Enkaku:** default input diubah ke **`scrcpy-uhid`** (hardware-like, wireless-friendly), dengan `scrcpy-sdk` sebagai fallback kompatibilitas (UHID butuh layout dikonfigurasi sekali & Android version tertentu buat fitur tertentu). Buat kasus ekstrem (nguji app yang cek sangat dalam), sediakan `scrcpy-aoa` opt-in. Ini memberi *device-under-test* input yang menyerupai hardware — **berguna buat QA: menguji jalur app yang sebenarnya**, bukan jalur "ini pasti bot".

### 9.2 Kelebihan real device (dibanding emulator)

HP fisik otomatis lolos banyak deteksi naif: sensor asli (accelerometer/gyro), IMEI/serial asli, tidak ada properti emulator (`ro.kernel.qemu`, dll), touch dari driver asli. Ini keunggulan struktural dibanding redroid/emulator — dan alasan real-device farm masih relevan.

### 9.3 Realistic input profile (timing) — praktik QA standar

Fitur timing jitter (`DeviceSettings.timing`) = bikin test traffic menyerupai manusia supaya **menguji jalur app yang sebenarnya** (banyak app punya path berbeda buat interaksi cepat-robotik vs manusiawi). Ini praktik QA, bukan "semoga gak ketahuan". Jitter tap + jeda antar-aksi + variasi kecil koordinat.

### 9.4 Instrumentasi, bukan evasi buta (inti positioning)

Karena kamu pegang **dua sisi** (detektor + farm), pendekatan yang benar & lebih presisi:
1. **Tag semua trafik dari farm** (header/marker internal) — *on by default*.
2. Jalankan skenario, lihat mana yang ke-flag detektor mana yang lolos.
3. Yang lolos = celah detektor → perbaiki detektor. Yang ke-flag padahal manusiawi = false positive → tune.
4. Bangun **feedback loop farm ⇄ detektor** yang bisa di-iterate.

Ini engineering yang bisa dijual ("anti-fraud test harness") dan secara hukum/ToS aman karena diarahkan ke *app milik sendiri*.

### 9.5 Capability locks (biar engine ga tabrakan)

```ts
scrcpyDisplay.locks   = ['video-encoder']
scrcpyUhidInput.locks = ['input-injection']
scrcpySdkInput.locks  = ['input-injection']
uiServer.locks        = ['instrumentation']
appiumInspector.locks = ['instrumentation', 'input-injection']  // konflik dgn scrcpy input
```

Session manager tolak aktivasi engine kedua yang minta resource sama → user **tidak pernah bisa** memilih dua engine yang saling injak.

---

## 10. Session, lease, queue, scheduler

### 10.1 State machine device

```
offline → idle → { manual | busy }
```

`manual` (remote touch aktif) & `busy` (automation jalan) **mutually exclusive**. Saat `busy`, control message dari client **di-reject** oleh core (bukan cuma UI di-disable). Video stream tetap jalan → client tetap bisa nonton automation.

### 10.2 Lease + heartbeat

Runner heartbeat tiap ~15s memperpanjang lease. Lease expired → job ditandai failed, device force-release. Tanpa ini, satu script nyangkut (ANR/freeze/disconnect) = device mati sampai restart.

### 10.3 Queue di SQLite

Queue **per-device** (constraint-nya device). Transaksi single-writer:

```sql
BEGIN IMMEDIATE;
UPDATE jobs
SET status='running', lease_expires_at = strftime('%s','now') + 60
WHERE id = (
  SELECT j.id FROM jobs j
  JOIN devices d ON d.id = j.device_id
  WHERE j.status='queued' AND d.status='idle'
  ORDER BY j.priority DESC, j.created_at
  LIMIT 1
)
RETURNING *;
COMMIT;
```

SQLite dipilih karena zero-setup (**tetap dipertahankan** — sesuai instruksi, ini keputusan yang tidak diubah). ORM = Drizzle. Driver DB tetap di-abstract kalau nanti butuh Postgres, tapi default = SQLite.

### 10.4 Serialisasi akses adb (REVISI v0.2 — bukan mutex tunggal)

**Masalah v0.1:** "satu mutex global di depan semua exec adb" terlalu kasar. Kalau device A lagi `adb install app.apk` (30–60 detik), device B–J semua nunggu — termasuk heartbeat & input manual user lain. Fatal di 10 device.

**Revisi:** adb server sebenarnya cukup aman untuk banyak client dengan `-s <serial>` berbeda. Masalah klasiknya bukan concurrency exec, tapi **device-discovery race** & `adb kill-server` liar.

- **Per-device command queue** (serialize command *dalam satu device*).
- **Global semaphore longgar** (mis. max 6–8 concurrent exec) buat jaga adb server tidak kebanjiran, bukan mutex tunggal.
- **`adb kill-server` DILARANG** di mana pun kecuali Toolchain Manager saat swap versi adb (dan itu pun harus drain semua session dulu).
- Operasi berat (install/uninstall/push besar) dijalankan tanpa memblok heartbeat/kontrol device lain.

---

## 11. Script framework

### 11.1 Bentuk script (`defineScript`)

Tiga fase: `prepare` (siapin device, boleh gagal & retry), `run` (kerjaan inti), `finish` (**selalu** jalan, bersihin state).

```ts
export default defineScript({
  id: 'post-content',
  version: '2.0.0',
  params: z.object({ caption: z.string(), imagePath: z.string() }),
  timeout: 180_000,
  retries: 1,

  async prepare(ctx) {
    await ctx.device.app.forceStop('com.myapp')
    await ctx.device.app.launch('com.myapp')
    await ctx.device.waitFor({ text: 'Beranda' }, { timeout: 15_000 })
  },

  async run(ctx) {
    const { device, params, artifact } = ctx
    await device.tap({ desc: 'Buat postingan' })
    await device.waitFor({ id: 'caption_input' })
    await device.type(params.caption)
    await artifact.screenshot('sebelum-post')
    await device.tap({ text: 'Bagikan' })
    await device.waitFor({ text: 'Terkirim' }, { timeout: 30_000 })
    return { ok: true }
  },

  async finish(ctx) {
    if (ctx.error) await ctx.artifact.screenshot('gagal')
    await ctx.device.app.forceStop('com.myapp')
  },
})
```

### 11.2 Aturan matang

- **`finish` selalu jalan** → device balik clean → queue aman lanjut.
- **Tiap job = child process** (`Bun.spawn`). Timeout = kill paksa. Crash terisolasi. Log & artifact per job.
- **`params` = Zod schema** → Studio auto-generate form input.
- **`waitFor` = polling inspector** (`ui-server`, cepat), bukan sleep.
- **Selector berlapis** (stabil → rapuh): `{ id }` → `{ desc }` → `{ text }` → `{ point }`.
- **Artifact per job**: screenshot, log, hasil, disimpan dengan job id → auditable.

### 11.3 Trust model & isolasi (KOREKSI JUJUR v0.2)

**v0.1 bilang "sandbox: limit akses fs/network child process". Itu overclaim.** Bun **tidak** punya permission model seperti Deno; `Bun.spawn` child process punya akses fs/network penuh sesuai OS user-nya.

Yang benar:
- **Isolasi yang ADA = crash containment**, bukan security boundary: child process + hard-timeout kill = script user tak bisa nge-crash core & tak bikin core hang. Itu saja yang dijanjikan di local/single-tenant.
- **Trust model local/self-host = "script author itu operator tepercaya."** Jangan tulis "sandbox aman" di marketing.
- **Kalau butuh security boundary betulan** (wajib buat cloud multi-tenant nanti): butuh **container/gVisor/microVM per job** atau minimal user OS terpisah. Ini perubahan arsitektur (masuk §18/M8), bukan flag.
- Hanya API `device`/`artifact`/`log` yang di-expose ke script sebagai *convenience*, bukan sebagai jaminan keamanan.

### 11.4 Dependency & publish (BARU v0.2)

Script disimpan sebagai source di DB — tapi bagaimana kalau butuh npm package? Alur: SDK CLI `enkaku publish` mem-*bundle* script + deps jadi satu file (esbuild/bun build), farm cuma terima **bundle jadi**. Menyederhanakan runner & bikin dependency deterministik.

### 11.5 Lifecycle & manajemen

CRUD via Studio: buat, edit, versioning, aktif/nonaktif, hapus, run dengan parameter. Script author nulis di editor sendiri pakai `@enkaku/sdk`, lalu publish ke farm.

---

## 12. Data model (SQLite + Drizzle)

```ts
export const devices = sqliteTable('devices', {
  id:        text('id').primaryKey(),          // internal id
  stableId:  text('stable_id').notNull().unique(), // ro.serialno / ANDROID_ID (§7.5)
  serial:    text('serial').notNull(),         // alamat transport adb (bisa berubah)
  label:     text('label').notNull(),
  ownerId:   text('owner_id'),

  androidVersion: text('android_version'),
  apiLevel:  integer('api_level'),             // BARU: buat gating fitur (UHID dll)
  screenW:   integer('screen_w'),
  screenH:   integer('screen_h'),
  density:   integer('density'),               // wajib buat coordinate mapping

  transport:  text('transport').default('adb-usb'),
  display:    text('display').default('scrcpy'),
  input:      text('input').default('scrcpy-uhid'),   // default baru
  inspection: text('inspection').default('ui-server'),

  battery:   text('battery', { mode: 'json' }).$type<BatteryState>(), // BARU (§15)
  settings:  text('settings', { mode: 'json' }).$type<DeviceSettings>(),
  status:    text('status').default('offline'),   // offline|idle|manual|busy|quarantined
  lastSeen:  integer('last_seen', { mode: 'timestamp' }),
})

export const scripts = sqliteTable('scripts', {
  id:        text('id').primaryKey(),
  name:      text('name').notNull(),
  version:   text('version').notNull(),
  bundle:    text('bundle').notNull(),         // hasil publish (bundle jadi, §11.4)
  paramsSchema: text('params_schema', { mode: 'json' }),
  enabled:   integer('enabled', { mode: 'boolean' }).default(true),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const jobs = sqliteTable('jobs', {
  id:        text('id').primaryKey(),
  scriptId:  text('script_id').notNull(),
  deviceId:  text('device_id').notNull(),
  params:    text('params', { mode: 'json' }),
  priority:  integer('priority').default(0),
  status:    text('status').default('queued'), // queued|running|success|failed|cancelled
  leaseExpiresAt: integer('lease_expires_at'),
  result:    text('result', { mode: 'json' }),
  error:     text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
})

export const artifacts = sqliteTable('artifacts', {
  id:      text('id').primaryKey(),
  jobId:   text('job_id').notNull(),
  kind:    text('kind').notNull(),             // screenshot|log|file|video
  label:   text('label'),
  path:    text('path').notNull(),
  sizeBytes: integer('size_bytes'),            // BARU: buat retention/GC (§18)
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const users = sqliteTable('users', {
  id:      text('id').primaryKey(),
  email:   text('email').notNull().unique(),
  role:    text('role').default('operator'),   // admin|operator
  passwordHash: text('password_hash'),         // argon2
  createdAt: integer('created_at', { mode: 'timestamp' }),
})

export const toolInstalls = sqliteTable('tool_installs', {
  id:      text('id').primaryKey(),
  toolId:  text('tool_id').notNull(),
  version: text('version').notNull(),
  active:  integer('active', { mode: 'boolean' }).default(false),
  sha256:  text('sha256'),
  installedAt: integer('installed_at', { mode: 'timestamp' }),
})

export const auditLog = sqliteTable('audit_log', {   // BARU (§14)
  id:     text('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),            // job.run|device.enroll|tool.activate|...
  target: text('target'),
  meta:   text('meta', { mode: 'json' }),
  at:     integer('at', { mode: 'timestamp' }),
})
```

`DeviceSettings` (JSON, divalidasi Zod):

```ts
const DeviceSettings = z.object({
  timing: z.object({
    tapJitterMs:     z.tuple([z.number(), z.number()]).default([40, 120]),
    betweenActionMs: z.tuple([z.number(), z.number()]).default([300, 900]),
    coordJitterPx:   z.number().default(2),    // BARU (§9.3)
  }),
  prep: z.object({
    disableAnimations: z.boolean().default(true),
    stayAwake:         z.boolean().default(true),
  }),
  input: z.object({
    preferredMode: z.enum(['uhid', 'sdk', 'aoa']).default('uhid'),  // BARU (§9)
  }),
  autoReconnect: z.boolean().default(true),
})
```

Screen dimension + density + apiLevel **wajib** di-probe sekali saat connect & di-cache — coordinate mapping & gating fitur (UHID butuh Android version tertentu) bergantung ke sini.

---

## 13. Protokol Core ⇄ Studio

Message-based over WebSocket. Kategori:

- **Device events**: `device.added`, `device.removed`, `device.status` (dari `adb track-devices`, bukan polling).
- **Enrollment**: `device.unauthorized`, `device.pairing.request`, `device.pairing.code` (§15.1).
- **Control** (manual): `input.tap`, `input.swipe`, `input.key`, `input.text` → core validasi lease, reject kalau `busy`.
- **Video**: LAN = stream byte H.264 (scrcpy) → browser WebCodecs `VideoDecoder`. Cloud = negosiasi WebRTC (§5.3).
- **Queue/job**: `job.enqueue`, `job.status`, `job.log`, `job.artifact`.
- **Registry/tools**: introspeksi + operasi tool.

REST buat request-response biasa (CRUD script, tools). WebSocket buat streaming/realtime. Kontrak di `packages/protocol` (Zod), shared & type-safe.

---

## 14. Keamanan & isolasi

- **Server-authoritative**: lease, konflik resource, ACL di core.
- **Auth (REVISI v0.2):**
  - Local single-user (mode awam): boleh **auto-create admin** / skip login demi zero-config — TAPI hanya kalau bind ke `localhost` saja.
  - Mode server/cloud: login **wajib** (argon2 hash), session token. Tunnel agent pakai token.
  - **TLS wajib** di mode server/cloud (jangan ulangi kesalahan ws-scrcpy: "no encryption, no auth, listen all interfaces").
- **Crash containment (bukan sandbox)**: tiap job child process + hard-timeout kill (§11.3). Security boundary sungguhan (container/microVM) = pekerjaan cloud multi-tenant (§18).
- **Tool integrity**: sha256 wajib.
- **adb access**: per-device queue + semaphore longgar, larang `kill-server` liar (§10.4).
- **Audit**: siapa jalanin apa, enroll device apa, aktifkan tool apa → tercatat (`audit_log`).
- **Data hygiene (dari pelajaran STF):** opsi *reset device antar-lease* (clear app data / logout) supaya akun/credential tak bocor antar-user — penting buat multi-user.

---

## 15. Device lifecycle: enrollment, battery, thermal (BARU v0.2)

### 15.1 Enrollment flow (jangan diremehkan)

"Colok device, auto-detect" melewati langkah nyata yang jadi *first impression* buruk kalau tidak ditangani:

- **USB debugging authorization**: dialog RSA fingerprint harus di-*accept di layar HP*. Core deteksi device state `unauthorized` → Studio tampilkan wizard: "cek layar HP, tap Allow, centang Always."
- **Wireless ADB (Android 11+)**: butuh **pairing code flow** (`adb pair host:port` + 6-digit code dari HP). Studio sediakan input pairing code + instruksi visual.
- Setelah authorized → probe stableId/dimensi/apiLevel → daftar.

Buat 10 device internal ini sepele; buat produk jual ini momen krusial. Wizard enrollment = fitur, bukan afterthought.

### 15.2 Battery & thermal (naikkan dari "future" ke fitur awal)

Farm HP dicolok charger 24/7 = risiko **baterai kembung** (safety + biaya support). Minimal sejak M-awal:
- Baca `dumpsys battery` (level, suhu, status charging) → tampil di dashboard.
- **Auto-quarantine** device kalau suhu lewat threshold (status `quarantined`, keluar dari pool schedule).
- Backlog: charge limiting (banyak HP support via `dumpsys`/vendor API — misal batasi charge ke 80%).

---

## 16. Non-functional requirements (BARU v0.2 — kasih angka)

v0.1 bilang "low latency" tanpa target. Definisikan supaya M2/M6 punya "definition of done" & jadi bahan marketing:

| Metrik | Target (LAN) | Catatan |
|---|---|---|
| Glass-to-glass latency (manual control) | < 150 ms | scrcpy H.264 + WebCodecs |
| Video FPS | ≥ 24 fps (idle bisa turun) | tergantung HP & Android |
| Inspector query (`ui-server`) | < 200 ms per find | vs 0.5–2s `uiautomator dump` |
| First-run provisioning | < 90 detik | download adb+scrcpy+ui-server |
| Max device / host (Intel N100, 4GB) | 10–15 | I/O-bound, scrcpy encode di HP |
| Max device / host (SBC 1–2GB) | 4–6 | adb-only edition, wireless ADB |
| Job overhead (spawn→prepare) | < 3 detik | child process + attach ui-server |

Marketing angle: *"10 devices on a ~$150 mini-PC."*

---

## 17. Positioning & acceptable use (QA framing)

- **Positioning = QA / test-automation device farm** (ala BrowserStack), bukan "bot sosmed tak terdeteksi." Framing QA lebih aman hukum/ToS, pasar lebih besar, customer = developer yang menguji app *mereka sendiri*.
- **Acceptable-use policy = default produk, bukan cuma dokumen.** Fitur instrumentation/tagging trafik farm **on by default** (§9.4). Fitur timing-jitter & input UHID didokumentasikan dalam konteks *test realism* (menguji jalur app sebenarnya), bukan evasi.
- **Testing detektor sendiri**: instrumentasi > evasi buta. Feedback loop farm ⇄ detektor (§9.4).
- **Saat dijual**: sertakan AUP; default fitur diarahkan ke pengujian app milik sendiri; real-device advantage (§9.2) jadi selling point QA yang sah.

---

## 18. Housekeeping & business plumbing (BARU v0.2)

Hal yang pasti kejadian tapi sering bikin produk indie mandek:

- **Artifact retention/GC**: screenshot/video per job numpuk cepat. Butuh policy: quota per device/global, TTL, atau max-size dengan LRU eviction. `artifacts.sizeBytes` sudah disiapkan.
- **Lisensi & redistribusi**: audit sebelum jual — adb/platform-tools (ToS Google), scrcpy (Apache-2.0 ✅), redroid, dependency npm. Bikin `LICENSES.md`.
- **Business plumbing (kalau serius jual)**: docs/onboarding, license key/activation, telemetry opt-in, support channel, update channel. Ini milestone nyata (M7.5).
- **Security boundary cloud**: multi-tenant butuh isolasi antar-customer + container/microVM per job (§11.3). Jangan janjikan multi-tenant aman sebelum ini ada.

---

## 19. Studio — spec layar

| Layar | Isi |
|---|---|
| **Dashboard** | Grid device (thumbnail live opsional), status (idle/manual/busy/offline/quarantined), owner, **badge baterai/suhu**. Quick action: control / run. |
| **Enrollment wizard** | Deteksi `unauthorized`/wireless-pairing, instruksi visual, input pairing code (§15.1). |
| **Device detail / live control** | Video stream + input klik, panel pilih driver (dropdown, divalidasi capability+locks), **pilihan input mode uhid/sdk/aoa**, per-device settings (schema-driven), tombol prep. Saat `busy`: input disable, video tetap jalan, badge "automation running". |
| **Scripts** | List, editor, versioning, enable/disable, run (form param auto dari Zod), riwayat job, tombol publish. |
| **Job / run detail** | Status, log realtime, artifact (screenshot/video per step), hasil/error. |
| **Tools (Toolchain)** | Per tool: versi terpasang (badge aktif) + tersedia, install/update/activate/delete, progress, health check, refresh manifest. **scrcpy-server tampil "managed by core" (read-only).** |
| **Settings** | Farm-wide defaults (driver/timing/input mode default), user & ACL (admin), retention policy, backup/restore DB. |

Prinsip render: semua panel config di-render dari schema via schema-driven form renderer — tidak ada UI hardcode per komponen.

---

## 20. Roadmap / milestone (REVISI v0.2)

| Fase | Deliverable | Fokus |
|---|---|---|
| **M0 — Fondasi** | Monorepo, core daemon, `packages/adb` (client + `track-devices`), device registry (**stableId probe**) → SQLite → WS broadcast, **per-device queue + adb semaphore**. | Device kelihatan di API realtime, identity stabil. |
| **M1 — Toolchain** | Manifest, download+checksum, versi, active pointer, **swappable flag**, API + first-run auto-provision. | "Install & run" zero-config beneran. |
| **M2 — Kontrol dasar** | `screencap-loop` + `adb-input`, validasi coordinate mapping end-to-end, Studio live view + klik, **enrollment wizard**. | Remote manual jalan (kasar) + device masuk dengan benar. |
| **M3 — Session/lease/queue** | State machine, lease + heartbeat, queue per-device (dummy `sleep` job dulu). | Antrian & keamanan device benar dulu. |
| **M4 — Script framework** | `defineScript`, runner subprocess, artifact/log, `@enkaku/sdk`, inspector (mulai `uiautomator dump`, siapkan `ui-server`). | Automation matang & terisolasi. |
| **M4.5 — ui-server** | Persistent on-device inspector (pola uiautomator2), fast `find`/`waitFor`, `set_text`. | Kecepatan inspector = kecepatan farm. |
| **M5 — Studio lengkap** | Scripts CRUD + run form + publish, job detail, Tools UI, settings, schema-driven renderer, registry, **battery/thermal + auto-quarantine**. | UI dinamis penuh + device health. |
| **M6 — scrcpy** | `scrcpy` display (H.264 relay, **versi-locked**) + **`scrcpy-uhid` input** + WebCodecs decode + fallback decoder. | Latency rendah, input hardware-like, kualitas produksi. |
| **M7 — Multi-user & packaging** | Auth/ACL + TLS, single-binary, Docker image, Tauri shell, auto-update, retention/GC. | Siap self-host. |
| **M7.5 — Business plumbing** | Docs, license/activation, telemetry opt-in, AUP, support/update channel, `LICENSES.md`. | Siap jual. |
| **M8 — Cloud & driver tambahan** | Cloud tunnel agent, split control plane, **WebRTC video**, security boundary per-job (container/microVM), `appium` opt-in, redroid, `scrcpy-aoa`. | Skala, fleksibilitas, multi-tenant aman. |

Catatan urutan: **M3 sebelum M4** disengaja (queue/lease benar pakai job palsu > debug queue sambil debug automation). **M4.5 & M6-input** ditambah karena inspector-speed & input-realism adalah dua sumbu diferensiasi utama dari kompetitor.

---

## 21. Sumber riset (verifikasi v0.2)

Klaim teknis di v0.2 diverifikasi ke sumber primer (diakses 2026):

- **scrcpy protokol tidak stabil antar versi** — dokumentasi developer resmi Genymobile/scrcpy (`doc/develop.md`): protokol client↔server "internal, may (and will) change at any time, no backward/forward compatibility." Contoh perubahan client v3.1 (issue #5733), mismatch versi (issues #4276, #3421). → dasar aturan §7.6.
- **Input modes (SDK/UHID/AOA)** — scrcpy DeepWiki "Advanced Topics", release notes v2.4 (UHID keyboard/mouse), v3.3 (UHID mouse virtual display), issues #4034/#5473. → dasar §9.
- **STF/DeviceFarmer status** — repo DeviceFarmer/stf & openstf/stf (README: development lambat, trust model longgar), analisis alternatif (OpenSTF mentok Android 9). → dasar §6.1.
- **ws-scrcpy / ws-scrcpy-web** — repo NetrisTV/ws-scrcpy & bilbospocketses/ws-scrcpy-web (vanilla scrcpy-server, multiplex 1-byte prefix, WebCodecs, in-app updater, SQLite, no-auth-by-default warning). → dasar §4 & §6.2.
- **uiautomator2 (openatx)** — repo openatx/uiautomator2 & android-uiautomator-server (persistent JSONRPC server APK, `dump_hierarchy` cepat tapi lag di UI berubah — issue #116). → dasar §7.4.
- **Appium UiAutomator2 driver** — repo appium/appium-uiautomator2-driver (Google-supported engine, berat). → dasar §6.3.

---

## 22. Pertanyaan terbuka / future

- Multi-tenant penuh di cloud (isolasi + security boundary per-job).
- Marketplace script (jual/beli script automation).
- Recording → script generator (rekam aksi manual jadi draft `defineScript`).
- Parallel run lintas device dengan capability-based routing ("jalankan di device Android 15 manapun").
- Integrasi CI (GitHub Actions / Bitrise verified step) — kompetitor sudah punya.
- Video recording per-session sebagai artifact standar (buat audit & QA report).
- iOS support (jauh lebih rumit — WDA/Appium, butuh macOS host).

---

*Enkaku — draft v0.2. Semua nama & angka bisa berubah. Perubahan v0.2 berbasis riset prior-art & verifikasi sumber primer; keputusan default (SQLite, Bun/Hono, Next.js, monorepo) dipertahankan sesuai arahan.*
