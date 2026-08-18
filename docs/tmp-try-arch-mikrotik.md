# Catatan Percobaan — Farm 20 Modem LTE via MikroTik + VLAN
**Tanggal: 18 Agustus 2026** · Router: hAP ax² · Switch: CSS326-24G-2S+RM (SwOS 2.16) · Modem: 20× TP-Link TL-MR105 · Client: 2 box phone farm (40 device, Panda OTG network)

---

## 1. Tujuan

- Menghubungkan 20 modem LTE ke router yang hanya punya 5 port fisik.
- Setiap modem menjadi jalur internet (WAN) independen dan terisolasi.
- Client tertentu (device phone farm) bisa diarahkan lewat modem tertentu.

**Solusi terpilih: VLAN trunk.** Satu kabel ether5 → switch membawa 20 VLAN;
tiap port switch = satu modem = satu VLAN = satu subnet.

---

## 2. Topologi Akhir

```
                                    ┌── port6  (VLAN 101) ── Modem 1  (192.168.101.1)
Internet kantor ── wifi1 (station)  ├── port7  (VLAN 102) ── Modem 2  (192.168.102.1)
                       │            ├── ...
Laptop kontrol ── ether3 (.100.0)   ├── port24 (VLAN 119) ── Modem 19 (192.168.119.1)
Phone farm 2 box ─ ether2 (.10.0)   └── port5  (VLAN 120) ── Modem 20 (192.168.120.1)
                       │
hAP ax² ── ether5 (trunk) ══════ CSS326 port2
           + 192.168.99.1/24 (untagged VLAN1 = management switch @ 192.168.99.2)
```

- Box phone farm 2 di-daisy-chain ke port LAN box 1 → **terbukti bridged** (semua
  device satu subnet 192.168.10.x, dapat DHCP langsung dari router).
- Konvensi penamaan: modem N → VLAN (100+N) → subnet 192.168.(100+N).x → interface
  `wan-modemN-pP` → routing table `via-modemN-pP` (P = nomor port switch).

---

## 3. Tahapan yang Dikerjakan

### 3.1 Akses & setting switch (SwOS)
1. Switch awalnya "hilang" — tidak di 192.168.88.1. Ditemukan via
   `/ip neighbor print` di **192.168.1.100** (dapat DHCP dari modem yang sudah
   tercolok di port 6).
2. Set IP statis switch: **192.168.99.2**; router pegang 192.168.99.1/24 di ether5
   sebagai jalur management permanen (untagged / VLAN 1).
3. Tab **VLANs**: satu entry per modem, member = Port2 (trunk) + port modem.
4. Tab **VLAN** per port: Port2 = `enabled / any / PVID 1`; port modem =
   `enabled / only untagged / PVID <vlan-id>`.
   ⚠️ Mode harus **enabled**, bukan `optional` (optional tidak menegakkan isolasi).

### 3.2 Setting tiap modem MR105 (via WiFi modem masing-masing)
- Advanced → Network → LAN: IP `192.168.(100+N).1`, pool `.100–.199`, DHCP tetap on.
- Wajib karena semua MR105 default 192.168.1.1 (bentrok kalau tidak diubah).

### 3.3 Setting router per modem (5 baris, pola tetap)
```
/interface vlan add name=wan-modemN-pP interface=ether5 vlan-id=1NN
/ip dhcp-client add interface=wan-modemN-pP use-peer-dns=no add-default-route=no
/ip firewall nat add chain=srcnat out-interface=wan-modemN-pP action=masquerade
/routing table add name=via-modemN-pP fib
/ip route add dst-address=0.0.0.0/0 gateway=192.168.1NN.1 routing-table=via-modemN-pP \
    check-gateway=ping comment="internet via modemN portP"
```
- `add-default-route=no` penting: agar route modem tidak menabrak jalur kantor.
- `check-gateway=ping` = monitoring gratis: modem sehat ⇔ route flag **As**.

### 3.4 Audit (angka harus sama = jumlah modem)
```
/interface vlan print count-only                                   → 20
/ip dhcp-client print count-only where interface~"wan-modem"       → 20
/ip firewall nat print count-only where out-interface~"wan-modem"  → 20
/ip route print count-only where comment~"modem"                   → 20 (semua As)
```

### 3.5 Upgrade RouterOS
- 7.7 → 7.12.1 (direncanakan) → **7.24** (kepencet, ternyata mulus).
- Semua konfigurasi selamat; bug-bug 7.7 hilang (lihat §5).
- Prosedur aman: `/export file=...` + `/system backup save` + **download ke laptop**
  sebelum upgrade; jangan cabut power selama flash.

### 3.6 Uji coba mapping 1 device → 1 modem (device .221 = Panda #40)
```
/routing rule add src-address=192.168.10.221/32 \
    action=lookup-only-in-table table=via-modem5-p10 comment="test device .221 via modem5"
```
- Refresh whoer.net di device → **ISP berubah Biznet → Indosat** ✅
- Bukti end-to-end: device → rule → table modem5 → VLAN 105 → port10 → MR105 → LTE.

---

## 4. 🐛 BUG PENTING: ADB disconnect setelah rule dipasang

**Gejala:** begitu rule `lookup-only-in-table` aktif, device hilang dari Panda/ADB.

**Penyebab:** rule menyeret **SEMUA** traffic ber-src .221 ke table modem —
termasuk balasan paket ADB ke laptop (192.168.100.x). Di table modem hanya ada
default route ke LTE, jadi balasan ADB nyasar keluar modem → TCP putus.

**Solusi:** rule pengecualian untuk tujuan lokal, **di posisi ATAS** rule modem
(routing rule dievaluasi top-down):
```
/routing rule add src-address=192.168.10.221/32 dst-address=192.168.100.0/24 \
    action=lookup table=main comment="local exception .221"
```

**Bentuk final untuk produksi (pasang SEKALI, paling atas, berlaku semua device):**
```
/routing rule add src-address=192.168.10.0/24 dst-address=192.168.100.0/24 \
    action=lookup table=main comment="farm: mgmt exception"
/routing rule add src-address=192.168.10.0/24 dst-address=192.168.10.0/24 \
    action=lookup table=main comment="farm: intra-subnet exception"
```
Setelah dua rule ini terpasang di atas, rule per-device tinggal satu baris tanpa
mikir pengecualian lagi.

---

## 5. Temuan & Bug Lain Sepanjang Hari

| # | Temuan | Penyebab / Solusi |
|---|---|---|
| 1 | Switch tak ter-ping di 192.168.88.1 | Dapat DHCP dari modem (192.168.1.100). Selalu cari via `/ip neighbor print` |
| 2 | Paste blok perintah: baris pertama hilang (2× kejadian: modem 11 & 20) | Terminal Winbox memotong baris pertama saat paste. Mitigasi: Enter dulu sebelum paste, atau paste per baris, lalu **audit count-only** |
| 3 | `/ping routing-table=` ditolak | Tidak ada di ROS untuk table non-VRF (bahkan di 7.24). Ganti: trik `src-address` + routing rule sementara |
| 4 | Route baru stuck **IsH** (inactive) padahal DHCP bound | Bug resolve ROS 7.7; route dibuat sebelum interface ada. Fix: disable/enable route — hilang total setelah upgrade |
| 5 | Ping via modem: 1 paket "packet rejected" di awal | Transien saat rule baru dipasang; bukan gejala, abaikan bila tidak konsisten |
| 6 | **Device box 2 "name not resolved" padahal ping 8.8.8.8 jalan** | DHCP network `dns-server=""` KOSONG sejak awal. Fix: `/ip dhcp-server network set [find address="192.168.10.0/24"] dns-server=192.168.10.1` (box 1 selamat karena kemungkinan DNS manual/tambalan) |
| 7 | Send Reconfigure gagal: "No Reconfigure parameters for this binding" | Client Android tidak support DHCP ForceRenew. Renew harus dari sisi device: reboot / toggle mode box USB↔OTG network |
| 8 | Make static lease ≠ membekukan opsi DHCP | Static hanya mengunci MAC↔IP; DNS/gateway tetap diambil dari DHCP network saat renew |
| 9 | IP WAN modem kadang .102 bukan .100 | Lease .100/.101 terpakai HP saat setting via WiFi modem. Kosmetik; rapikan via Address Reservation di modem (reserve .100 untuk MAC ether5) |
| 10 | Identitas device: 41 lease semua bernama "Galaxy-Z-Flip4" | Tak bisa bedakan device dari Winbox. PR: pemetaan serial ADB ↔ IP ↔ nomor Panda → comment di lease. (Tebakan visual bisa salah: .221 dikira #15, ternyata #40) |

---

## 6. Status Akhir (18 Aug 2026, sore)

| Komponen | Status |
|---|---|
| 20 modem: VLAN 101–120, DHCP bound, NAT, route **As** semua | ✅ |
| RouterOS 7.24 stable + REST API | ✅ |
| Switch: 20 VLAN + management 192.168.99.2 | ✅ |
| 40 device (2 box, bridged), DNS diperbaiki | ✅ |
| 41 lease **static** (IP terkunci) | ✅ |
| Uji mapping .221 → modem 5 → **ISP Indosat di whoer** | ✅ |
| Rule pengecualian umum (farm: mgmt + intra-subnet) | ⬜ pasang |
| Comment nama di lease (panda-01..40) | ⬜ |
| Mapping massal 40 device → 20 modem | ⬜ |
| Backup config terbaru (termasuk rules hari ini) | ⬜ |
| Plugin Enkaku `modem-manager` + proxy layer (docs sudah ada) | ⬜ |

## 7. Perintah Monitoring Harian

```
/ip route print where comment~"modem"     ← dashboard: semua harus As
/ip dhcp-client print                     ← semua wan-modem harus bound
/system resource print                    ← cpu-load router
```

## 8. Resep Tambah Modem Baru (contekan)

1. Modem: ubah LAN IP `192.168.(100+N).1` via WiFi-nya, colok ke port kosong.
2. SwOS: VLANs append (VLAN 1NN, member Port2+portX) + VLAN tab
   (portX: enabled / only untagged / PVID 1NN) + Apply All.
3. Router: 5 baris pola §3.3.
4. Audit count-only naik 1, route baru **As**.
