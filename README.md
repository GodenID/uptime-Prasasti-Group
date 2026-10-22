<div align="center">
  <img src="docs/hero.svg" alt="Uptime Prasasti Websites" width="100%">
</div>

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.5-13804d?style=flat&logo=node.js&logoColor=white) ![Dependencies](https://img.shields.io/badge/dependencies-0-success?style=flat&logo=npm&logoColor=white) ![Tests](https://img.shields.io/badge/tests-57%20passing-16a34a?style=flat&logo=githubactions&logoColor=white) ![SQLite](https://img.shields.io/badge/storage-SQLite-003b57?style=flat&logo=sqlite&logoColor=white) ![License](https://img.shields.io/badge/license-MIT-8a7a5c?style=flat) ![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20Windows-007ec6?style=flat) ![Stars](https://img.shields.io/github/stars/GodenID/uptime-Prasasti-Group?style=flat&logo=github&logoColor=white) ![Forks](https://img.shields.io/github/forks/GodenID/uptime-Prasasti-Group?style=flat&logo=github&logoColor=white) ![Issues](https://img.shields.io/github/issues/GodenID/uptime-Prasasti-Group?style=flat&logo=github&logoColor=white)

</div>

<p align="center">
  <strong>Uptime Prasasti Websites</strong> — pemantauan ketersediaan situs dan layanan yang direkam satu per satu seperti prasasti:
  setiap denyut disimpan, setiap gangguan tercatat, dan setiap status page punya jejak yang bisa dibaca publik.
</p>

<p align="center">
  <strong>Live:</strong> <a href="https://uptime.prasastigroup.id">uptime.prasastigroup.id</a> — Cloudflare Workers + D1 + Durable Objects.
</p>

---

## Daftar Isi

<table>
<tr>
  <td align="left" width="50%">

- [Ringkasan](#ringkasan)
- [Fitur](#fitur)
- [Mulai Cepat](#mulai-cepat)
- [Tipe Monitor](#tipe-monitor)
- [Notifikasi](#notifikasi)
- [Status Page & Badge](#status-page--badge)

</td>
<td align="left" width="50%">

- [Realtime](#realtime)
- [Arsitektur](#arsitektur)
- [Konfigurasi](#konfigurasi-lingkungan)
- [REST API](#rest-api)
- [Penyimpanan & Retensi](#penyimpanan--retensi)
- [Keamanan](#keamanan)
- [Pengujian](#pengujian)
- [Deployment](#deployment)
- [Kontribusi](#kontribusi)
- [Lisensi](#lisensi)

</td>
</tr>
</table>

---

## Ringkasan

| Aspek | Keterangan |
| --- | --- |
| **Runtime** | Dua target: Cloudflare Workers (utama, `worker/`) dan Node.js ≥ 22.5 (`server/`). |
| **Dependensi** | Node: nol dependensi. Workers: hanya alat bantu pengembangan (`wrangler`, `vitest`). |
| **Build step** | Tidak ada bundler. Workers memakai `wrangler deploy`; Node langsung `node server/index.js`. |
| **Basis data** | D1 di Cloudflare; SQLite mode WAL di `data/prasasti.db` untuk versi Node. |
| **Antarmuka** | Dasbor admin + status page publik, ditulis sebagai modul ES tanpa framework. |
| **Realtime** | WebSocket di `/ws`: Durable Object hub di Workers, `node:http` + `node:crypto` di Node. |
| **Penjadwalan** | Satu Durable Object per monitor dengan alarm; cron tiap menit sebagai jaring pengaman. |
| **Pengujian** | 57 uji integrasi Node + 18 uji integrasi Workers di workerd. |

## Fitur

| Fitur | Rincian |
| --- | --- |
| **Dua belas tipe monitor** | HTTP(S), kata kunci, JSON, TCP, ICMP ping, DNS, Redis, MQTT, Docker, PostgreSQL, push, dan grup. Di Workers, ping dan Docker dilaporkan *pending* karena tidak didukung runtime. |
| **Denyut & grafik** | Riwayat heartbeat dengan bar 24 jam, grafik waktu respons, uptime 24 jam/7/30/90/365 hari, agregat harian, log kejadian per monitor. |
| **Status page publik** | Halaman mandiri di `/status/<slug>` dengan grup monitor, uptime, riwayat insiden, jadwal pemeliharaan, pengumuman, umpan RSS, domain kustom, dan pembaruan realtime. |
| **Bahasa status page** | Indonesia atau Inggris; bahasa dapat mengikuti preferensi peramban. Dasbor admin tetap bahasa Indonesia. |
| **Insiden otomatis** | Gangguan membuka insiden pada setiap status page yang memuat monitor tersebut, lalu menutupnya saat pulih. Insiden manual bisa ditulis, disematkan, dan diselesaikan. |
| **Jendela pemeliharaan** | Sekali, harian, atau mingguan. Monitor yang sedang dipelihara tidak memicu notifikasi gangguan. |
| **Sepuluh kanal notifikasi** | Webhook, Discord, Telegram, Slack, ntfy, Gotify, SMTP, Pushover, Home Assistant, dan Apprise, dengan percobaan ulang, filter peristiwa, dan riwayat pengiriman. |
| **Autentikasi** | Wizard penyiapan akun pertama, sesi cookie HttpOnly, scrypt, pembatasan percobaan login, pengelolaan pengguna, dan kunci API dengan cakupan baca/tulis. |
| **Impor & ekspor** | Seluruh konfigurasi (monitor, tag, notifikasi, status page) dalam satu berkas JSON. |
| **Badge SVG** | Status dan uptime monitor untuk ditempel di README atau dasbor lain. |
| **Sertifikat & domain** | Notifikasi kedaluwarsa domain lewat RDAP di kedua target; kedaluwarsa sertifikat TLS hanya di versi Node. |

## Mulai Cepat

### Cloudflare Workers (utama)

Instance produksi: <https://uptime.prasastigroup.id>.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create prasasti      # salin database_id ke wrangler.jsonc
npx wrangler d1 migrations apply prasasti --remote
npx wrangler deploy
```

Pasang domain sendiri di `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "uptime.contoh.id", "custom_domain": true }
]
```

Buka domain tersebut. Pada basis data kosong, aplikasi menampilkan wizard penyiapan akun admin pertama. Rincian, batas runtime, dan operasi ada di [`worker/README.md`](worker/README.md).

> `*.workers.dev` diblokir DNS beberapa ISP Indonesia. Pakai domain kustom seperti contoh di atas.

### Node.js lokal

**Kebutuhan:** Node.js 22.5 atau lebih baru. Tidak ada `npm install`.

```bash
git clone https://github.com/GodenID/uptime-Prasasti-Group.git
cd uptime-Prasasti-Group
npm start
```

Buka <http://localhost:3001>. Pada basis data kosong, aplikasi menampilkan wizard penyiapan untuk membuat akun admin pertama, lalu Anda langsung masuk ke dasbor.

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Menjalankan server HTTP di port `3001`. |
| `npm run dev` | Menjalankan server dengan restart otomatis (`node --watch`). |
| `npm run seed` | Mengisi instance dengan monitor, tag, status page, dan pemeliharaan contoh. |
| `npm test` | Menjalankan 57 uji integrasi pada port dan basis data sementara. |

> `npm run seed` membuat pengguna `admin` dengan sandi `prasasti2026` bila belum ada pengguna. **Ganti sandi tersebut setelah masuk pertama kali.** Skrip ini idempoten — menjalankannya ulang tidak menggandakan data.

## Tipe Monitor

| Tipe | Kolom penting | Perilaku |
| --- | --- | --- |
| `http` | `url`, `method`, `headers`, `body`, `acceptedCodes`, `maxRedirects`, `ignoreTls` | Permintaan HTTP(S); status dianggap sehat bila kode respons masuk rentang yang diterima. |
| `keyword` | `url`, `keyword` | Sehat bila teks target ditemukan pada respons. |
| `json` | `url`, `jsonPath`, `expectedValue` | Mengambil nilai dengan `jsonPath` (notasi titik atau `$`) lalu membandingkannya dengan nilai harapan. |
| `tcp` | `hostname`, `port` | Sehat bila koneksi TCP terbentuk dalam batas waktu. |
| `ping` | `hostname` | ICMP echo; memakai utilitas `ping` sistem. |
| `dns` | `hostname`, `dnsRecordType`, `dnsResolver`, `expectedValue` | Resolusi A/AAAA/CNAME/MX/TXT/NS; dapat memakai resolver tertentu dan mencocokkan hasil. |
| `redis` | `hostname`, `port`, `options.password`, `options.db`, `options.command`, `options.expected` | Klien RESP bawaan: AUTH, SELECT, lalu perintah (`PING`, `GET kunci`, `INFO`). Balasan dapat dicocokkan. |
| `mqtt` | `hostname`, `port`, `options.topic`, `options.username`, `options.password`, `options.clientId`, `options.expected` | Klien MQTT 3.1.1: connect, subscribe satu topik, dan menunggu pesan. Isi pesan dapat dicocokkan. |
| `docker` | `options.container`, `options.socket` | Docker Engine API di atas socket Unix atau named pipe Windows. Monitor sehat bila container berjalan dan health check tidak `unhealthy`. |
| `postgres` | `hostname`, `port`, `options.user`, `options.password`, `options.database`, `options.query` | Klien wire protocol v3: autentikasi trust, cleartext, MD5, atau SCRAM-SHA-256, lalu kueri sederhana. |
| `push` | `pushToken` | Pasif. Kirim denyut dari cron atau skrip: `GET /api/push/<token>?status=up&ping=12`. |
| `group` | `parentId` anak | Status grup diturunkan dari monitor anak; grup juga merekam denyut sendiri sehingga uptime grup terhitung. |

Semua monitor mendukung `interval` (detik, minimum 20), `retries`, `retryInterval`, `timeout`, `upsideDown` (gangguan justru dianggap sehat), serta notifikasi kedaluwarsa sertifikat dan domain.

## Notifikasi

| Tipe | Konfigurasi |
| --- | --- |
| `webhook` | `url`, opsional `headerName`, `headerValue`, `bodyTemplate` (placeholder `{{title}}`, `{{message}}`, `{{status}}`, `{{monitor}}`). |
| `discord` | `webhookUrl`, opsional `username`. |
| `telegram` | `botToken`, `chatId`, opsional `messageThreadId`. |
| `slack` | `webhookUrl`. |
| `ntfy` | `topic`, opsional `serverUrl`, `token`, `priority`, `clickUrl`. |
| `gotify` | `serverUrl`, `appToken`, opsional `priority`. |
| `smtp` | `host`, `port`, `secure`, `user`, `pass`, `from`, `to`, opsional `subjectPrefix`. Mendukung STARTTLS dan AUTH PLAIN/LOGIN. |
| `pushover` | `token`, `user`, opsional `priority`, `device`, `sound`, `url`. |
| `homeassistant` | `webhookUrl` (webhook integrasi Home Assistant), opsional `accessToken`. |
| `apprise` | `serverUrl` (Apprise API), opsional `urls` (daftar target `apprise://`), `token`. |

Setiap notifikasi dapat diuji dari antarmuka atau `POST /api/notifications/:id/test`; hasilnya tercatat di riwayat pengiriman.

Setiap kanal juga dapat dibatasi per peristiwa (`down`, `up`, `certificate`, `domain`) dan diberi interval pengulangan (`resendInterval`, dalam menit) agar gangguan yang masih berjalan dilaporkan ulang secara berkala.

## Status Page & Badge

| Endpoint | Keterangan |
| --- | --- |
| `/status/<slug>` | Halaman status publik. Hanya status page yang diterbitkan; slug tak dikenal atau belum diterbitkan mengembalikan 404. |
| `/status/<slug>/feed.xml` | Umpan RSS 2.0 berisi insiden aktif, pemeliharaan, dan status tiap layanan. |
| `/api/status-page/<slug>` | Data publik status page dalam JSON. |
| `/api/status-page` | Data publik status page yang memakai domain kustom, ditentukan dari header `Host`. |
| `/api/badge/<id>/status` | Badge SVG berisi status monitor (`up`, `down`, `maintenance`, `pending`). |
| `/api/badge/<id>/uptime/<jam>h` | Badge SVG berisi persentase uptime, misal `/api/badge/1/uptime/24h`. |

Setiap status page dapat diatur lebih jauh: pengumuman di bagian atas, bahasa halaman (`id`, `en`, atau `auto`), dan domain kustom. Bila domain kustom diarahkan ke server, seluruh path publik pada domain tersebut menyajikan halaman status page itu, termasuk umpan RSS di `/feed.xml`.

## Realtime

WebSocket tersedia di `/ws` dan memakai pesan JSON.

```jsonc
// klien publik
{ "type": "subscribe", "slug": "layanan-prasasti" }
```

Klien publik menerima `subscribed` dan `status:snapshot`; setiap denyut baru memicu snapshot berikutnya (dibatasi satu per 1,5 detik per slug). `{"type":"unsubscribe"}` dan `{"type":"ping"}` (dibalas `pong`) juga tersedia.

Sesi admin yang login lewat browser menerima `beat`, `refresh`, `settings`, dan `status:snapshot` untuk pembaruan dasbor tanpa memuat ulang halaman.

## Arsitektur

```
server/
  index.js      HTTP server, berkas statis, perutean WebSocket, domain kustom
  api.js        REST API, validasi, impor/ekspor, kunci API
  engine.js     penjadwadian, denyut, uptime, insiden, pemeliharaan, grup
  checks.js     pemeriksaan HTTP, kata kunci, JSON, TCP, ping, DNS
  protocols.js  klien Redis (RESP), MQTT 3.1.1, Docker Engine API, PostgreSQL
  notifier.js   pengiriman notifikasi dan klien SMTP
  statuspage.js payload status page publik dan umpan RSS
  db.js         skema SQLite, migrasi ringan, dan pengaturan bawaan
  auth.js       scrypt, sesi, pembatasan login, kunci API
  models.js     bentuk data API
  ws.js         implementasi WebSocket
  util.js       helper lintas modul
  seed.js       data contoh
public/
  index.html    antarmuka admin
  status.html   status page publik
  404.html      halaman tidak ditemukan
  favicon.svg   lambang prasasti
  css/          sistem desain putih dan tinta biru
  js/           router, tampilan, grafik, klien API, kamus bahasa
test/
  run.mjs       suite integrasi (57 uji)

worker/
  wrangler.jsonc  konfigurasi Worker, D1, Durable Object, cron, domain
  migrations/     skema D1
  src/
    index.js      routing Worker, aset statis, cron
    api.js        REST API, validasi, impor/ekspor, kunci API
    engine.js     denyut, uptime, insiden, pemeliharaan, grup, retry
    checks.js     HTTP, kata kunci, JSON, DNS-over-HTTPS, TCP/Redis/MQTT/Postgres
    protocols.js  klien protokol di atas Sockets API
    notifier.js   kanal notifikasi dan SMTP
    statuspage.js payload status page publik dan umpan RSS
    db.js         pembungkus D1 dan pengaturan bawaan
    auth.js       scrypt, sesi, pembatasan login, kunci API
    do/
      monitor.js  Durable Object per monitor (alarm, retry, jadwal)
      hub.js      Durable Object realtime (WebSocket hibernasi)
  test/
    worker.test.mjs  suite integrasi workerd (18 uji)
```

**Prinsip desain**

- **Standar pustaka saja.** Di Node memakai `node:http`, `node:sqlite`, `node:crypto`, `node:tls`, `node:net`, `node:dns`, `node:zlib`; di Workers memakai API runtime Cloudflare. Tidak ada framework di server maupun peramban.
- **Satu sumber kebenaran.** Kedua target memakai `public/` yang sama; hanya lapisan penyimpanan dan penjadwalan yang berbeda.
- **Satu monitor, satu Durable Object.** Alarm tiap monitor berdiri sendiri, sehingga pemeriksaan tidak berebut jadwal dan tetap hidup saat isolate di-evict.
- **Sistem desain tunggal.** Kertas putih, tinta biru, tipografi serif untuk heading — dasbor dan status page memakai bahasa visual yang sama.

## Konfigurasi Lingkungan

| Variabel | Bawaan | Keterangan |
| --- | --- | --- |
| `PORT` | `3001` | Port HTTP server. |
| `HOST` | semua antarmuka | Alamat bind, misalnya `127.0.0.1` di belakang reverse proxy. |
| `PRASTASI_DATA_DIR` | `./data` | Direktori basis data dan berkas pendukung. |
| `PRASTASI_DB` | `<data dir>/prasasti.db` | Lokasi berkas SQLite bila ingin dipisah. |

```bash
PORT=8080 PRASTASI_DATA_DIR=/var/lib/prasasti node server/index.js
```

Pengaturan lain (judul instance, zona waktu, tema, `retentionDays`, `certificateExpiryDays`, `domainExpiryDays`, ukuran bar heartbeat) diatur dari dasbor pada menu **Pengaturan**.

## REST API

Semua endpoint admin memerlukan sesi cookie atau kunci API. Permintaan tanpa keduanya dijawab `401`.

<details>
<summary><strong>Daftar endpoint lengkap</strong></summary>

| Metode | Endpoint | Keterangan |
| --- | --- | --- |
| `GET` | `/api/health` | Status instance. |
| `GET`/`POST` | `/api/setup` | Cek kebutuhan penyiapan dan buat admin pertama. |
| `POST` | `/api/login`, `/api/logout` | Masuk dan keluar. |
| `GET` | `/api/session`, `/api/bootstrap` | Sesi aktif dan seluruh data awal antarmuka. |
| `GET`/`POST` | `/api/monitors` | Daftar dan pembuatan monitor. |
| `GET`/`PATCH`/`DELETE` | `/api/monitors/:id` | Detail (uptime, grafik, kejadian) dan perubahan monitor. |
| `POST` | `/api/monitors/:id/check` | Jalankan pemeriksaan manual. |
| `POST` | `/api/monitors/:id/pause`, `/resume`, `/reset-token` | Jeda, lanjutkan, dan ganti token push. |
| `GET` | `/api/stats` | Agregasi uptime dan status seluruh monitor. |
| `GET`/`POST` | `/api/push/:token` | Denyut dari monitor push (tanpa sesi). |
| `GET`/`POST` | `/api/tags` | Tag monitor. |
| `GET`/`POST` | `/api/notifications` | Kanal notifikasi. |
| `POST` | `/api/notifications/:id/test` | Kirim notifikasi uji. |
| `GET` | `/api/notification-logs` | Riwayat pengiriman. |
| `GET`/`POST` | `/api/status-pages` | Status page. |
| `POST` | `/api/status-pages/:id/publish` | Terbitkan atau sembunyikan. |
| `GET`/`POST` | `/api/incidents` | Insiden. |
| `POST` | `/api/incidents/:id/resolve` | Selesaikan insiden. |
| `GET`/`POST` | `/api/maintenances` | Jendela pemeliharaan. |
| `GET`/`PATCH` | `/api/settings` | Pengaturan instance. |
| `POST` | `/api/password` | Ganti kata sandi. |
| `POST` | `/api/users` | Tambah pengguna. |
| `GET`/`POST`/`DELETE` | `/api/api-keys` | Kunci API: daftar, buat, dan cabut. |
| `GET`/`POST` | `/api/export`, `/api/import` | Ekspor dan impor konfigurasi. |
| `GET` | `/api/status-page/:slug` | Data publik status page. |
| `GET` | `/api/status-page` | Data status page pada domain kustom. |
| `GET` | `/api/badge/:id/...` | Badge SVG. |

</details>

## Kunci API

Kunci API memberi akses programatis ke endpoint admin tanpa sesi peramban:

```bash
curl -H "Authorization: Bearer pk_..." http://127.0.0.1:3001/api/monitors
```

- Token hanya ditampilkan sekali, saat kunci dibuat. Server menyimpan hash SHA-256 token itu saja.
- Cakupan `read` hanya menerima permintaan `GET`; cakupan `write` juga boleh mengubah data.
- Kunci API tidak dapat membuat atau mencabut kunci lain.
- Kunci dapat diberi masa berlaku (hari) dan dicabut kapan saja dari menu **Pengaturan**.

## Penyimpanan & Retensi

- Basis data SQLite berada di `./data/prasasti.db` dengan mode WAL.
- Denyut lama dipangkas otomatis setiap jam mengikuti `retentionDays` (bawaan 180 hari). Denyut penting — perubahan status — dipertahankan lebih lama.
- Tabel `heartbeat_daily` menyimpan agregat per hari (jumlah denyut per status, jumlah waktu respons, durasi gangguan). Uptime rentang panjang memakai tabel ini, sedangkan bagian hari berjalan dihitung langsung dari denyut.
- Migrasi skema dijalankan otomatis saat server mulai: kolom dan tabel baru ditambahkan bila belum ada, dan agregat harian diisi ulang dari denyut lama.
- Cadangkan dengan menyalin direktori `data/` saat server berhenti, atau memakai `sqlite3 .backup`.

## Keamanan

- Kata sandi di-hash dengan scrypt bersalt; sesi disimpan sebagai hash token.
- Cookie sesi `HttpOnly`, `SameSite=Lax`, dan `Secure` saat diakses lewat HTTPS.
- Login dibatasi 8 kegagalan per 10 menit per alamat IP dan nama pengguna.
- Penggantian kata sandi mengakhiri sesi lain milik pengguna tersebut.
- Kunci API disimpan sebagai hash SHA-256, memiliki cakupan baca/tulis, dan dapat kedaluwarsa.
- Header CSP ketat: skrip hanya dari origin sendiri, tanpa `eval`, tanpa sumber daya pihak ketiga.
- Semua masukan API divalidasi dan dibatasi ukurannya; nama berkas statis dinormalisasi untuk mencegah path traversal.
- Permintaan mutasi divalidasi terhadap same-origin.

Saat mengekspos instance ke internet, jalankan di belakang reverse proxy dengan HTTPS dan batasi akses ke antarmuka admin bila perlu. Status page publik tetap dapat diakses tanpa autentikasi.

## Pengujian

```bash
npm test
```

Suite integrasi menjalankan instance terpisah pada port uji dengan basis data sementara, lalu memeriksa penyiapan akun, seluruh tipe monitor (termasuk Redis, MQTT, dan PostgreSQL lewat server tiruan lokal), pemeriksaan manual, push, tag, grup, status page beserta umpan RSS dan domain kustom, insiden, pemeliharaan, seluruh kanal notifikasi, filter peristiwa dan notifikasi ulang, kunci API, agregat uptime harian, pengaturan, pengguna, ekspor/impor, badge, WebSocket, dan penyajian berkas statis. Tidak ada dependensi pengujian.

```
Total: 57 uji · lulus 57 · gagal 0
```

Versi Workers diuji di workerd dengan D1 dan Durable Object sungguhan:

```bash
cd worker
npm test
```

```
Total: 18 uji · lulus 18 · gagal 0
```

## Deployment

Jalankan di belakang reverse proxy dengan HTTPS, dan batasi `HOST` ke antarmuka loopback bila akses dari luar tidak diperlukan:

```nginx
server {
    listen 443 ssl http2;
    server_name uptime.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket realtime
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
HOST=127.0.0.1 PORT=3001 PRASTASI_DATA_DIR=/var/lib/prasasti node server/index.js
```

Lindungi direktori data (`chmod 700`) dan jalankan proses sebagai pengguna non-root. Untuk instance dengan lalu lintas besar, letakkan basis data pada volume terpisah dan jalankan beberapa instance di belakang load balancer.

## Deployment Cloudflare (Workers + D1)

Instance utama repo ini berjalan di **<https://uptime.prasastigroup.id>** dengan Cloudflare Workers, D1, dan Durable Objects. Kode ada di `worker/`, sedangkan antarmuka di `public/` dipakai bersama dengan versi Node.

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create prasasti          # salin database_id ke wrangler.jsonc
npx wrangler d1 migrations apply prasasti --remote
npx wrangler deploy
```

Untuk domain sendiri, tambahkan `routes` dengan `custom_domain: true` seperti pada Mulai Cepat. Ini juga jalan keluar bila `*.workers.dev` diblokir ISP.

Batasan runtime Workers:

- ICMP ping dan monitor Docker tidak tersedia; keduanya dicatat sebagai *pending*, bukan gangguan.
- Pemeriksaan TCP/Redis/MQTT/PostgreSQL, SMTP, dan Sockets API membutuhkan Workers Paid.
- DNS memakai DNS-over-HTTPS; sertifikat TLS tidak bisa dibaca, jadi notifikasi kedaluwarsa sertifikat hanya ada di versi Node.
- Setiap denyut menulis beberapa baris D1. Free plan (100.000 baris tulis/hari) cukup untuk belasan monitor; sisanya perlu Workers Paid.

Rincian lengkap ada di [`worker/README.md`](worker/README.md).

## Kontribusi

Laporkan bug atau ajukan fitur melalui [Issues](https://github.com/GodenID/uptime-Prasasti-Group/issues).

1. Fork repository dan buat branch temu: `git checkout -b feature/nama-perubahan`.
2. Ubah kode dengan gaya yang mengikuti berkas sekitar — CommonJS di `server/`, modul ES di `public/js/` dan `worker/src/`.
3. Jalankan `npm test` (versi Node) dan `npm test` di `worker/` (versi Workers); seluruh uji harus lulus.
4. Buka pull request dengan ringkasan perubahan dan alasan.

## Lisensi

Released under the [MIT License](https://github.com/GodenID/uptime-Prasasti-Group/blob/main/LICENSE).

---

<div align="center">
  <sub>Uptime Prasasti Websites — setiap denyut, setiap gangguan, setiap jejak.<br>
  <a href="https://github.com/GodenID/uptime-Prasasti-Group">github.com/GodenID/uptime-Prasasti-Group</a></sub>
</div>
