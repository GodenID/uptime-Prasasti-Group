#!/usr/bin/env node
/**
 * Uji integrasi Uptime Prasasti Websites.
 *
 * Menjalankan instance terpisah pada PORT uji dengan basis data sementara,
 * lalu menguji REST API, mesin pemantauan, notifikasi, WebSocket, dan berkas statis.
 *
 *   node test/run.mjs
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3999);
const TARGET_PORT = PORT + 1;
const HOOK_PORT = PORT + 2;
const SMTP_PORT = PORT + 3;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        try {
            if (await predicate()) return true;
        } catch {
            /* coba lagi */
        }
        await sleep(120);
    }
    throw new Error(`Waktu habis menunggu ${label}`);
}

// ---------- pelaporan ----------
const results = [];

async function test(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  \u2713 ${name}`);
    } catch (error) {
        results.push({ name, ok: false, error });
        console.log(`  \u2717 ${name}`);
        console.log(`      ${String(error.message).split('\n')[0]}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}

// ---------- klien HTTP dengan cookie ----------
function createClient() {
    const jar = new Map();
    return {
        jar,
        async fetch(pathname, { method = 'GET', body, headers = {} } = {}) {
            const outgoing = { ...headers };
            if (jar.size) {
                outgoing.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
            }
            if (body !== undefined) {
                outgoing['content-type'] = 'application/json';
            }
            const response = await fetch(BASE + pathname, {
                method,
                headers: outgoing,
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'manual',
            });
            for (const line of response.headers.getSetCookie()) {
                const pair = line.split(';')[0];
                const index = pair.indexOf('=');
                const key = pair.slice(0, index);
                const value = pair.slice(index + 1);
                if (!value || /max-age=0/i.test(line)) {
                    jar.delete(key);
                } else {
                    jar.set(key, value);
                }
            }
            const type = response.headers.get('content-type') || '';
            const data = type.includes('application/json')
                ? await response.json().catch(() => null)
                : await response.text();
            return { status: response.status, headers: response.headers, type, data };
        },
    };
}

// ---------- WebSocket ----------
function connectWs(url) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const messages = [];
        const waiters = [];
        socket.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;
            }
            messages.push(message);
            for (let index = waiters.length - 1; index >= 0; index -= 1) {
                if (waiters[index].match(message)) {
                    const waiter = waiters.splice(index, 1)[0];
                    clearTimeout(waiter.timer);
                    waiter.resolve(message);
                }
            }
        });
        socket.addEventListener(
            'open',
            () =>
                resolve({
                    socket,
                    messages,
                    send: (payload) => socket.send(JSON.stringify(payload)),
                    wait(match, timeout = 8000) {
                        return new Promise((res, rej) => {
                            const timer = setTimeout(() => rej(new Error('Waktu habis menunggu pesan WebSocket')), timeout);
                            waiters.push({ match, resolve: res, timer });
                        });
                    },
                    close: () => socket.close(),
                }),
            { once: true }
        );
        socket.addEventListener('error', () => reject(new Error('Koneksi WebSocket gagal')), { once: true });
    });
}

// ---------- server pendukung ----------
function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
}

const targetServer = http.createServer((request, response) => {
    const url = request.url || '/';
    if (url.startsWith('/ok')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<h1>Prasasti hadir di sini</h1>');
    } else if (url.startsWith('/json')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'sehat', nilai: 42 }));
    } else if (url.startsWith('/fail')) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('rusak');
    } else {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('tidak ada');
    }
});

const hookHits = [];
const hookServer = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
        body += chunk;
    });
    request.on('end', () => {
        hookHits.push({ url: request.url, headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true}');
    });
});

const mails = [];
const smtpServer = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = '';
    socket.write('220 prasasti-test ESMTP\r\n');
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (inData) {
                if (line === '.') {
                    inData = false;
                    mails.push(current);
                    current = '';
                    socket.write('250 2.0.0 Pesan diterima\r\n');
                } else {
                    current += `${line}\n`;
                }
                continue;
            }
            const command = line.toUpperCase();
            if (command.startsWith('EHLO') || command.startsWith('HELO')) {
                socket.write('250-prasasti-test\r\n250 SIZE 10485760\r\n');
            } else if (command.startsWith('MAIL FROM') || command.startsWith('RCPT TO')) {
                socket.write('250 2.1.0 OK\r\n');
            } else if (command === 'DATA') {
                inData = true;
                socket.write('354 Akhiri dengan <CRLF>.<CRLF>\r\n');
            } else if (command === 'QUIT') {
                socket.write('221 Sampai jumpa\r\n');
                socket.end();
            } else {
                socket.write('250 OK\r\n');
            }
        }
    });
    socket.on('error', () => {});
});

// ---------- orkestrasi ----------
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prasasti-test-'));
let serverLog = '';
let server = null;

try {
    await listen(targetServer, TARGET_PORT);
    await listen(hookServer, HOOK_PORT);
    await listen(smtpServer, SMTP_PORT);

    server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(PORT),
            HOST: '127.0.0.1',
            PRASTASI_DATA_DIR: dataDir,
            NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (chunk) => {
        serverLog += chunk;
    });
    server.stderr.on('data', (chunk) => {
        serverLog += chunk;
    });
    server.on('exit', (code) => {
        serverLog += `\n[server keluar dengan kode ${code}]`;
    });

    await waitFor('server siap', async () => {
        const response = await fetch(`${BASE}/api/health`);
        return response.ok;
    });

    const admin = createClient();

    // ================= dasar =================
    section('Dasar & penyiapan');

    await test('health mengembalikan identitas instance', async () => {
        const response = await fetch(`${BASE}/api/health`);
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.name, 'Uptime Prasasti Websites');
        assert.ok(payload.time > 0);
    });

    await test('setup awal tersedia lalu terkunci setelah dipakai', async () => {
        const before = await admin.fetch('/api/setup');
        assert.equal(before.data.needSetup, true);
        const created = await admin.fetch('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'rahasia123' },
        });
        assert.equal(created.status, 201);
        const after = await admin.fetch('/api/setup');
        assert.equal(after.data.needSetup, false);
        const again = await admin.fetch('/api/setup', {
            method: 'POST',
            body: { username: 'lain', password: 'rahasia123' },
        });
        assert.equal(again.status, 400);
    });

    await test('sesi aktif setelah setup', async () => {
        const session = await admin.fetch('/api/session');
        assert.equal(session.status, 200);
        assert.equal(session.data.user.username, 'admin');
    });

    await test('endpoint admin menolak permintaan tanpa sesi', async () => {
        const response = await fetch(`${BASE}/api/monitors`);
        assert.equal(response.status, 401);
    });

    // ================= monitor =================
    section('Monitor & pemeriksaan');

    const monitors = {};
    const createMonitor = async (key, body) => {
        const response = await admin.fetch('/api/monitors', { method: 'POST', body });
        assert.equal(response.status, 201, `gagal membuat monitor ${key}: ${JSON.stringify(response.data)}`);
        monitors[key] = response.data.monitor;
        return response.data.monitor;
    };

    await test('membuat monitor HTTP, kata kunci, JSON, TCP, push, dan grup', async () => {
        await createMonitor('http', {
            name: 'Situs Uji',
            type: 'http',
            url: `http://127.0.0.1:${TARGET_PORT}/ok`,
            interval: 3600,
            retries: 0,
            timeout: 5,
        });
        await createMonitor('keyword', {
            name: 'Kata Kunci Uji',
            type: 'keyword',
            url: `http://127.0.0.1:${TARGET_PORT}/ok`,
            keyword: 'Prasasti hadir',
            interval: 3600,
        });
        await createMonitor('json', {
            name: 'JSON Uji',
            type: 'json',
            url: `http://127.0.0.1:${TARGET_PORT}/json`,
            jsonPath: 'status',
            expectedValue: 'sehat',
            interval: 3600,
        });
        await createMonitor('tcp', {
            name: 'TCP Uji',
            type: 'tcp',
            hostname: '127.0.0.1',
            port: TARGET_PORT,
            interval: 3600,
        });
        await createMonitor('push', { name: 'Push Uji', type: 'push' });
        await createMonitor('group', { name: 'Grup Uji', type: 'group' });
        await createMonitor('down', {
            name: 'Situs Rusak',
            type: 'http',
            url: `http://127.0.0.1:${TARGET_PORT}/fail`,
            interval: 3600,
        });
        assert.equal(Object.keys(monitors).length, 7);
        assert.equal(monitors.http.status, 2, 'monitor baru harus berstatus menunggu');
    });

    await test('pemeriksaan HTTP berhasil mencatat denyut operasional', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.http.id}/check`, { method: 'POST' });
        assert.equal(response.status, 200);
        assert.equal(response.data.beat.status, 1);
        assert.ok(response.data.beat.ping >= 0);
        assert.match(response.data.beat.msg, /200/);
        assert.equal(response.data.summary.lastBeat.id, response.data.beat.id);
    });

    await test('pemeriksaan kata kunci menemukan teks target', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.keyword.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
    });

    await test('pemeriksaan kata kunci gagal saat teks tidak ada', async () => {
        await admin.fetch(`/api/monitors/${monitors.keyword.id}`, {
            method: 'PATCH',
            body: { keyword: 'teks-yang-tidak-ada' },
        });
        const response = await admin.fetch(`/api/monitors/${monitors.keyword.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 0);
        await admin.fetch(`/api/monitors/${monitors.keyword.id}`, {
            method: 'PATCH',
            body: { keyword: 'Prasasti hadir' },
        });
    });

    await test('pemeriksaan JSON mencocokkan nilai yang diharapkan', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.json.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
    });

    await test('pemeriksaan JSON gagal saat nilai berbeda', async () => {
        await admin.fetch(`/api/monitors/${monitors.json.id}`, {
            method: 'PATCH',
            body: { expectedValue: 'rusak' },
        });
        const response = await admin.fetch(`/api/monitors/${monitors.json.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 0);
        await admin.fetch(`/api/monitors/${monitors.json.id}`, {
            method: 'PATCH',
            body: { expectedValue: 'sehat' },
        });
    });

    await test('pemeriksaan TCP tersambung ke port lokal', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.tcp.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
    });

    await test('kode respons yang diterima dapat dikustomisasi', async () => {
        const monitor = await createMonitor('accepted', {
            name: 'Kode 500 Diterima',
            type: 'http',
            url: `http://127.0.0.1:${TARGET_PORT}/fail`,
            acceptedCodes: '500',
            interval: 3600,
        });
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
        assert.match(response.data.beat.msg, /500/);
    });

    await test('mode terbalik menganggap kegagalan sebagai sehat', async () => {
        const monitor = await createMonitor('upside', {
            name: 'Monitor Terbalik',
            type: 'http',
            url: `http://127.0.0.1:${TARGET_PORT}/fail`,
            upsideDown: true,
            interval: 3600,
        });
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
    });

    await test('pemeriksaan HTTP gagal membuka insiden otomatis', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.down.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 0);
        const detail = await admin.fetch(`/api/monitors/${monitors.down.id}`);
        assert.ok(detail.data.incidents.length >= 1);
        assert.equal(detail.data.incidents[0].resolvedAt, null);
    });

    await test('endpoint push menerima status turun dan naik', async () => {
        const token = monitors.push.pushToken;
        assert.ok(token, 'monitor push harus punya token');
        const down = await fetch(`${BASE}/api/push/${token}?status=down&msg=uji%20push`);
        assert.equal(down.status, 200);
        const downPayload = await down.json();
        assert.equal(downPayload.beat.status, 0);
        const up = await fetch(`${BASE}/api/push/${token}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: 'up', msg: 'pulih', ping: 12 }),
        });
        const upPayload = await up.json();
        assert.equal(upPayload.beat.status, 1);
        assert.equal(upPayload.beat.ping, 12);
        const unknown = await fetch(`${BASE}/api/push/tidak-dikenal`);
        assert.equal(unknown.status, 404);
    });

    await test('detail monitor memuat uptime, kejadian, dan grafik', async () => {
        const detail = await admin.fetch(`/api/monitors/${monitors.http.id}`);
        assert.equal(detail.status, 200);
        for (const key of ['24h', '7d', '30d', '365d']) {
            assert.ok(detail.data.uptime[key], `uptime ${key} hilang`);
            assert.ok('uptime' in detail.data.uptime[key]);
        }
        assert.ok(detail.data.events.length >= 1);
        assert.ok(Array.isArray(detail.data.chart));
        const times = detail.data.chart.map((point) => point.time);
        assert.deepEqual(times, [...times].sort((a, b) => a - b), 'grafik harus urut naik');
    });

    await test('jeda dan lanjutkan monitor mengubah status aktif', async () => {
        await admin.fetch(`/api/monitors/${monitors.http.id}/pause`, { method: 'POST' });
        let list = await admin.fetch('/api/monitors');
        let target = list.data.monitors.find((monitor) => monitor.id === monitors.http.id);
        assert.equal(target.active, false);
        await admin.fetch(`/api/monitors/${monitors.http.id}/resume`, { method: 'POST' });
        list = await admin.fetch('/api/monitors');
        target = list.data.monitors.find((monitor) => monitor.id === monitors.http.id);
        assert.equal(target.active, true);
    });

    await test('token push dapat direset', async () => {
        const response = await admin.fetch(`/api/monitors/${monitors.push.id}/reset-token`, { method: 'POST' });
        assert.equal(response.status, 200);
        assert.ok(response.data.pushToken);
        assert.notEqual(response.data.pushToken, monitors.push.pushToken);
        monitors.push.pushToken = response.data.pushToken;
    });

    await test('grup menghitung status dari anak monitor', async () => {
        await admin.fetch(`/api/monitors/${monitors.http.id}`, {
            method: 'PATCH',
            body: { parentId: monitors.group.id },
        });
        const list = await admin.fetch('/api/monitors');
        const group = list.data.monitors.find((monitor) => monitor.id === monitors.group.id);
        assert.equal(group.childrenCount, 1);
        assert.equal(group.children[0].id, monitors.http.id);
        assert.equal(group.status, 1);
    });

    await test('tag dapat dibuat, diubah, dipasang, dan dihapus', async () => {
        const created = await admin.fetch('/api/tags', { method: 'POST', body: { name: 'uji-tag', color: '#46c392' } });
        assert.equal(created.status, 201);
        const tagId = created.data.tag.id;
        const updated = await admin.fetch(`/api/tags/${tagId}`, {
            method: 'PATCH',
            body: { name: 'uji-tag-baru', color: '#c9894a' },
        });
        assert.equal(updated.data.tag.name, 'uji-tag-baru');
        await admin.fetch(`/api/monitors/${monitors.http.id}`, { method: 'PATCH', body: { tags: [tagId] } });
        let detail = await admin.fetch(`/api/monitors/${monitors.http.id}`);
        assert.equal(detail.data.monitor.tags[0].name, 'uji-tag-baru');
        await admin.fetch(`/api/tags/${tagId}`, { method: 'DELETE' });
        detail = await admin.fetch(`/api/monitors/${monitors.http.id}`);
        assert.equal(detail.data.monitor.tags.length, 0);
    });

    // ================= status page =================
    section('Status page publik, insiden, dan pemeliharaan');

    let pageId = null;
    const slug = 'uji-publik';

    await test('status page dibuat, diterbitkan, dan dapat dibaca publik', async () => {
        const response = await admin.fetch('/api/status-pages', {
            method: 'POST',
            body: {
                title: 'Status Uji Prasasti',
                slug,
                description: 'Halaman uji integrasi.',
                theme: 'stone',
                published: true,
                showTags: true,
                showPoweredBy: true,
                monitors: [monitors.http.id, monitors.keyword.id],
                groups: [{ name: 'Jaringan', monitors: [monitors.tcp.id] }],
            },
        });
        assert.equal(response.status, 201);
        pageId = response.data.statusPage.id;
        assert.equal(response.data.statusPage.slug, slug);

        const publicPayload = await fetch(`${BASE}/api/status-page/${slug}`);
        assert.equal(publicPayload.status, 200);
        const payload = await publicPayload.json();
        assert.equal(payload.overall.totalMonitors, 3);
        assert.equal(payload.monitors.length, 2);
        assert.equal(payload.groups.length, 1);
        assert.equal(payload.groups[0].name, 'Jaringan');
        assert.ok(payload.overall.uptime24 !== null);
    });

    await test('halaman status statis tersaji dan slug tak dikenal 404', async () => {
        const page = await fetch(`${BASE}/status/${slug}`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        const html = await page.text();
        assert.match(html, /id="status-root"/);
        assert.match(html, /\/js\/status\.js/);

        const missing = await fetch(`${BASE}/status/tidak-ada`);
        assert.equal(missing.status, 404);
        const missingHtml = await missing.text();
        assert.match(missingHtml, /tidak ditemukan/i);
    });

    await test('status page yang disembunyikan tidak dapat diakses publik', async () => {
        await admin.fetch(`/api/status-pages/${pageId}/publish`, { method: 'POST', body: { published: false } });
        const hidden = await fetch(`${BASE}/api/status-page/${slug}`);
        assert.equal(hidden.status, 404);
        await admin.fetch(`/api/status-pages/${pageId}/publish`, { method: 'POST', body: { published: true } });
    });

    let incidentId = null;

    await test('insiden manual tampil aktif lalu masuk riwayat setelah diselesaikan', async () => {
        const created = await admin.fetch('/api/incidents', {
            method: 'POST',
            body: {
                statusPageId: pageId,
                title: 'Gangguan uji coba',
                content: 'Ditulis oleh suite integrasi.',
                style: 'warning',
            },
        });
        assert.equal(created.status, 201);
        incidentId = created.data.incident.id;

        let payload = await (await fetch(`${BASE}/api/status-page/${slug}`)).json();
        assert.ok(payload.incidents.some((incident) => incident.id === incidentId));

        await admin.fetch(`/api/incidents/${incidentId}/resolve`, { method: 'POST' });
        payload = await (await fetch(`${BASE}/api/status-page/${slug}`)).json();
        assert.ok(!payload.incidents.some((incident) => incident.id === incidentId));
        assert.ok(payload.history.some((incident) => incident.id === incidentId));
    });

    await test('pemeliharaan aktif tampil di status page', async () => {
        const created = await admin.fetch('/api/maintenances', {
            method: 'POST',
            body: {
                title: 'Pemeliharaan uji',
                description: 'Jendela perawatan dari suite integrasi.',
                strategy: 'once',
                startAt: Date.now() - 60000,
                endAt: Date.now() + 3600000,
                monitorIds: [monitors.http.id],
                statusPageIds: [pageId],
            },
        });
        assert.equal(created.status, 201);
        const maintenanceId = created.data.maintenance.id;

        const payload = await (await fetch(`${BASE}/api/status-page/${slug}`)).json();
        assert.ok(payload.maintenance.active.some((item) => item.id === maintenanceId));
        assert.equal(payload.maintenance.active[0].title, 'Pemeliharaan uji');

        await admin.fetch(`/api/maintenances/${maintenanceId}`, { method: 'DELETE' });
        const after = await (await fetch(`${BASE}/api/status-page/${slug}`)).json();
        assert.equal(after.maintenance.active.length, 0);
    });

    await test('insiden uji dibersihkan', async () => {
        const response = await admin.fetch(`/api/incidents/${incidentId}`, { method: 'DELETE' });
        assert.equal(response.status, 200);
    });

    // ================= notifikasi =================
    section('Notifikasi');

    let webhookId = null;

    await test('webhook menerima muatan uji', async () => {
        const created = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Webhook Uji',
                type: 'webhook',
                active: true,
                config: { url: `http://127.0.0.1:${HOOK_PORT}/hook` },
            },
        });
        assert.equal(created.status, 201);
        webhookId = created.data.notification.id;

        const sent = await admin.fetch(`/api/notifications/${webhookId}/test`, { method: 'POST' });
        assert.equal(sent.status, 200);
        assert.equal(hookHits.length, 1);
        const payload = JSON.parse(hookHits[0].body);
        assert.match(payload.title, /Uji coba notifikasi/);
        assert.equal(payload.status, 'up');
        assert.equal(payload.event, 'test');
        assert.equal(payload.monitor.name, 'Monitor contoh');
    });

    await test('riwayat pengiriman mencatat uji notifikasi', async () => {
        const logs = await admin.fetch('/api/notification-logs');
        assert.equal(logs.status, 200);
        assert.ok(logs.data.logs.some((entry) => entry.event === 'test' && entry.ok === 1));
    });

    await test('notifikasi dapat diubah dan diuji ulang', async () => {
        const patched = await admin.fetch(`/api/notifications/${webhookId}`, {
            method: 'PATCH',
            body: { name: 'Webhook Uji Baru' },
        });
        assert.equal(patched.data.notification.name, 'Webhook Uji Baru');
        const sent = await admin.fetch(`/api/notifications/${webhookId}/test`, { method: 'POST' });
        assert.equal(sent.status, 200);
        assert.equal(hookHits.length, 2);
    });

    await test('webhook mati melaporkan kegagalan', async () => {
        const created = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Webhook Mati',
                type: 'webhook',
                config: { url: 'http://127.0.0.1:1/tidak-ada' },
            },
        });
        const failed = await admin.fetch(`/api/notifications/${created.data.notification.id}/test`, { method: 'POST' });
        assert.equal(failed.status, 500);
        assert.match(String(failed.data.error), /fetch|ECONN|HTTP/i);
        await admin.fetch(`/api/notifications/${created.data.notification.id}`, { method: 'DELETE' });
    });

    await test('SMTP mengirim email uji ke server lokal', async () => {
        const created = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Surel Uji',
                type: 'smtp',
                config: {
                    host: '127.0.0.1',
                    port: SMTP_PORT,
                    secure: false,
                    from: 'prasasti@uji.local',
                    to: 'operator@uji.local',
                    subjectPrefix: '[Uji]',
                },
            },
        });
        assert.equal(created.status, 201);
        const sent = await admin.fetch(`/api/notifications/${created.data.notification.id}/test`, { method: 'POST' });
        assert.equal(sent.status, 200);
        assert.equal(mails.length, 1);
        assert.match(mails[0], /Subject: \[Uji\] Uji coba notifikasi/);
        assert.match(mails[0], /prasasti@uji\.local/);
        await admin.fetch(`/api/notifications/${created.data.notification.id}`, { method: 'DELETE' });
    });

    // ================= pengaturan & akun =================
    section('Pengaturan, akun, dan data');

    await test('pengaturan instance dapat diubah', async () => {
        const response = await admin.fetch('/api/settings', {
            method: 'PATCH',
            body: { title: 'Prasasti Uji', timezone: 'Asia/Makassar', heartbeatBarSize: 40, retentionDays: 30 },
        });
        assert.equal(response.status, 200);
        assert.equal(response.data.settings.title, 'Prasasti Uji');
        assert.equal(response.data.settings.timezone, 'Asia/Makassar');
        const bootstrap = await admin.fetch('/api/bootstrap');
        assert.equal(bootstrap.data.settings.heartbeatBarSize, '40');
        assert.ok(bootstrap.data.stats.storedBeats >= 1);
        assert.ok(bootstrap.data.stats.lastBeat > 0);
    });

    await test('pengguna tambahan dapat dibuat dan dipakai login', async () => {
        const created = await admin.fetch('/api/users', {
            method: 'POST',
            body: { username: 'operator', password: 'sandioperator' },
        });
        assert.equal(created.status, 201);
        const duplicate = await admin.fetch('/api/users', {
            method: 'POST',
            body: { username: 'operator', password: 'sandioperator' },
        });
        assert.equal(duplicate.status, 400);

        const operator = createClient();
        const login = await operator.fetch('/api/login', {
            method: 'POST',
            body: { username: 'operator', password: 'sandioperator' },
        });
        assert.equal(login.status, 200);
        const session = await operator.fetch('/api/session');
        assert.equal(session.data.user.username, 'operator');
    });

    await test('kata sandi salah ditolak dan penggantian berlaku', async () => {
        const wrong = await admin.fetch('/api/password', {
            method: 'POST',
            body: { current: 'salah-sekali', next: 'sandiBaru123' },
        });
        assert.equal(wrong.status, 400);

        const changed = await admin.fetch('/api/password', {
            method: 'POST',
            body: { current: 'rahasia123', next: 'sandiBaru123' },
        });
        assert.equal(changed.status, 200);

        const fresh = createClient();
        const oldLogin = await fresh.fetch('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'rahasia123' },
        });
        assert.equal(oldLogin.status, 401);

        const newLogin = await fresh.fetch('/api/login', {
            method: 'POST',
            body: { username: 'admin', password: 'sandiBaru123' },
        });
        assert.equal(newLogin.status, 200);
    });

    await test('ekspor memuat seluruh konfigurasi', async () => {
        const exported = await admin.fetch('/api/export');
        assert.equal(exported.status, 200);
        assert.equal(exported.data.monitors.length, 9);
        assert.equal(exported.data.statusPages.length, 1);
        assert.ok(exported.data.settings);
        assert.ok(Array.isArray(exported.data.notifications));
    });

    await test('impor menambahkan monitor dari berkas', async () => {
        const imported = await admin.fetch('/api/import', {
            method: 'POST',
            body: {
                version: 1,
                monitors: [
                    {
                        name: 'Impor HTTP',
                        type: 'http',
                        url: `http://127.0.0.1:${TARGET_PORT}/ok`,
                        interval: 3600,
                    },
                ],
                tags: [],
                notifications: [],
                statusPages: [],
            },
        });
        assert.equal(imported.status, 200);
        assert.equal(imported.data.imported.monitors, 1);
        const list = await admin.fetch('/api/monitors');
        assert.ok(list.data.monitors.some((monitor) => monitor.name === 'Impor HTTP'));
    });

    await test('badge SVG tersedia tanpa sesi', async () => {
        const status = await fetch(`${BASE}/api/badge/${monitors.http.id}/status`);
        assert.equal(status.status, 200);
        assert.match(status.headers.get('content-type'), /image\/svg\+xml/);
        assert.match(await status.text(), /<svg/);
        const uptime = await fetch(`${BASE}/api/badge/${monitors.http.id}/uptime/24h`);
        assert.equal(uptime.status, 200);
    });

    // ================= realtime =================
    section('Realtime');

    await test('pelanggan publik menerima snapshot saat berlangganan', async () => {
        const client = await connectWs(`ws://127.0.0.1:${PORT}/ws`);
        try {
            const subscribed = client.wait((message) => message.type === 'subscribed');
            const snapshot = client.wait((message) => message.type === 'status:snapshot');
            client.send({ type: 'subscribe', slug });
            const subscribedMessage = await subscribed;
            assert.equal(subscribedMessage.slug, slug);
            const snapshotMessage = await snapshot;
            assert.equal(snapshotMessage.slug, slug);
            assert.equal(snapshotMessage.payload.page.slug, slug);
        } finally {
            client.close();
        }
    });

    await test('denyut baru dikirim langsung ke pelanggan status page', async () => {
        const client = await connectWs(`ws://127.0.0.1:${PORT}/ws`);
        try {
            client.send({ type: 'subscribe', slug });
            await client.wait((message) => message.type === 'status:snapshot');
            const next = client.wait((message) => message.type === 'status:snapshot', 10000);
            const check = await admin.fetch(`/api/monitors/${monitors.http.id}/check`, { method: 'POST' });
            assert.equal(check.status, 200);
            const snapshot = await next;
            assert.equal(snapshot.slug, slug);
            assert.ok(snapshot.payload.generatedAt > 0);
        } finally {
            client.close();
        }
    });

    await test('ping WebSocket dibalas pong', async () => {
        const client = await connectWs(`ws://127.0.0.1:${PORT}/ws`);
        try {
            const pong = client.wait((message) => message.type === 'pong');
            client.send({ type: 'ping' });
            const message = await pong;
            assert.ok(message.time > 0);
        } finally {
            client.close();
        }
    });

    // ================= berkas statis =================
    section('Berkas statis');

    await test('aset antarmuka tersaji dengan tipe yang benar', async () => {
        const index = await fetch(`${BASE}/`);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /Uptime Prasasti/);

        const css = await fetch(`${BASE}/css/app.css`);
        assert.equal(css.status, 200);
        assert.match(css.headers.get('content-type'), /text\/css/);

        const js = await fetch(`${BASE}/js/status.js`);
        assert.equal(js.status, 200);
        assert.match(js.headers.get('content-type'), /javascript/);

        const favicon = await fetch(`${BASE}/favicon.ico`);
        assert.equal(favicon.status, 200);
        assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);

        const notFound = await fetch(`${BASE}/berkas-tidak-ada.js`);
        assert.equal(notFound.status, 404);
    });
} finally {
    try {
        server?.kill();
    } catch {
        /* proses sudah berhenti */
    }
    await new Promise((resolve) => targetServer.close(resolve));
    await new Promise((resolve) => hookServer.close(resolve));
    await new Promise((resolve) => smtpServer.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log('');
console.log('='.repeat(58));
console.log(`Total: ${results.length} uji · lulus ${results.length - failed.length} · gagal ${failed.length}`);
if (failed.length) {
    console.log('');
    for (const result of failed) {
        console.log(`GAGAL: ${result.name}`);
        console.log(result.error.stack.split('\n').slice(0, 4).join('\n'));
        console.log('');
    }
    if (serverLog.trim()) {
        console.log('--- log server ---');
        console.log(serverLog.trim().split('\n').slice(-40).join('\n'));
    }
}
process.exit(failed.length ? 1 : 0);
