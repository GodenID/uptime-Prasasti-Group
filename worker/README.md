# Uptime Prasasti Websites — Cloudflare Workers

Versi Workers dari Uptime Prasasti Websites: HTTP API, mesin pemeriksaan,
status page publik, dan realtime, berjalan di atas Cloudflare Workers + D1 +
Durable Objects. Antarmuka di `../public/` dipakai bersama tanpa perubahan.

Instance produksi: <https://uptime.prasastigroup.id>.

## Perbedaan dari versi Node

| Aspek | Versi Node (`../server`) | Versi Workers (folder ini) |
| --- | --- | --- |
| Basis data | berkas SQLite lokal (`node:sqlite`) | D1 (SQLite terkelola) |
| Penjadwalan | timer dalam satu proses | satu Durable Object per monitor dengan alarm |
| Realtime | WebSocket buatan sendiri di `node:http` | `WebSocketPair` + Durable Object hub (hibernasi) |
| ICMP ping | `ping` sistem | tidak tersedia, dicatat `pending` |
| Monitor Docker | socket Docker lokal | tidak tersedia, dicatat `pending` |
| DNS | `node:dns` (UDP) | DNS-over-HTTPS (Cloudflare / Google) |
| Port TCP, Redis, MQTT, PostgreSQL | `node:net` | Sockets API (`cloudflare:sockets`), butuh Workers Paid |
| SMTP | `node:net` | Sockets API, port 465/587 (port 25 diblokir Cloudflare) |
| Sertifikat TLS | `node:tls` | tidak tersedia; notifikasi domain tetap lewat RDAP |

Semua fitur lain (status page, RSS, domain kustom, pengumuman, bahasa, kunci
API, insiden, pemeliharaan, filter peristiwa, notifikasi ulang, percobaan ulang
monitor, agregat uptime harian, riwayat grup, badge) tetap sama.

## Langkah deploy

```bash
cd worker
npm install                 # hanya alat bantu pengembangan

npx wrangler login
npx wrangler d1 create prasasti
# salin database_id yang muncul ke wrangler.jsonc

npx wrangler d1 migrations apply prasasti --remote
npx wrangler deploy
```

Pasang domain sendiri di `wrangler.jsonc` — `*.workers.dev` sering diblokir
DNS ISP Indonesia, jadi domain kustom adalah jalur utama:

```jsonc
"routes": [
  { "pattern": "uptime.contoh.id", "custom_domain": true }
]
```

Buka domain tersebut. Basis data kosong akan menampilkan wizard penyiapan akun
admin.

```bash
npx wrangler deploy          # menerbitkan ulang kode
npx wrangler tail            # log realtime
npx wrangler d1 export prasasti --remote --output backup.sql
```

## Pengembangan lokal

```bash
npx wrangler dev            # server lokal di http://localhost:8787
npm test                    # 18 uji integrasi di workerd
```

Uji memakai `@cloudflare/vitest-plugin` sehingga Durable Object, D1, dan
aset statis berjalan sungguhan di dalam workerd. Cookie sesi memakai atribut
`Secure`; peramban modern tetap menerimanya di `localhost`.

## Batas yang perlu diperhatikan

- **Free plan**: D1 menyediakan 100.000 baris tulis per hari. Satu denyut
  menulis beberapa baris (heartbeat, agregat harian, indeks), jadi monitor
  interval 60 detik memakai ±7.000 baris per hari. Free plan cukup untuk
  belasan monitor; sisanya perlu Workers Paid.
- **Workers Paid ($5/bulan)**: diperlukan untuk pemeriksaan berbasis TCP
  (port, Redis, MQTT, PostgreSQL) dan SMTP, karena memakai Sockets API.
- **CPU 10 ms di Free plan**: `scrypt` untuk kata sandi dihitung sekali per
  percobaan masuk dan sudah teruji lolos pada instance produksi. Pemeriksaan
  HTTP dan DNS hampir seluruhnya menunggu I/O, sehingga tidak memakai kuota
  CPU. Yang mahal adalah kompresi dan parsing JSON besar.
- **Cron** berjalan setiap menit sebagai jaring pengaman: monitor yang
  tertinggal dijadwalkan ulang. Pemangkasan data lama hanya sekali sejam
  supaya tidak memboroskan kuota tulis D1.
- **Durable Object per monitor** memakai nama `monitor:<id>`, jadi ID monitor
  tidak boleh diubah setelah dibuat. Percobaan ulang (`retries`) disimpan di
  storage Durable Object, jadi tetap berlaku setelah DO di-evict.
- **Tipe yang tidak didukung** (ICMP ping, Docker) dicatat `pending`, bukan
  `down`, supaya tidak membuka insiden palsu.
- **Locks login** disimpan di memori isolate, jadi batas 8 percobaan berlaku
  per isolate, bukan global.

## Struktur

```
worker/
  wrangler.jsonc    Worker, D1, Durable Object, cron, domain kustom
  src/
    index.js        Worker: routing, aset statis, cron
    api.js          REST API, validasi, kunci API, penjadwalan
    engine.js       pemeriksaan, denyut, insiden, notifikasi, grup, retry
    checks.js       HTTP, kata kunci, JSON, DNS (DoH), TCP/Redis/MQTT/Postgres
    protocols.js    klien protokol di atas Sockets API
    notifier.js     kanal notifikasi (HTTP dan SMTP)
    statuspage.js   payload status page dan umpan RSS
    db.js           pembungkus D1
    auth.js         scrypt, sesi, kunci API
    util.js         helper murni
    models.js       bentuk data API
    do/
      monitor.js    Durable Object per monitor (alarm pemeriksaan, retry)
      hub.js        Durable Object realtime (WebSocket)
  migrations/
    0001_init.sql   skema D1
  test/
    worker.test.mjs 18 uji integrasi
```
