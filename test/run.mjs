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
const REDIS_PORT = PORT + 4;
const MQTT_PORT = PORT + 5;
const PG_PORT = PORT + 6;
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

// ---------- permintaan dengan Host kustom ----------
function requestWithHost(hostname, pathname) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers: { Host: hostname } },
            (response) => {
                let body = '';
                response.on('data', (chunk) => {
                    body += chunk;
                });
                response.on('end', () => {
                    resolve({ status: response.statusCode, headers: response.headers, body });
                });
            }
        );
        request.on('error', reject);
        request.end();
    });
}

// ---------- server tiruan protokol ----------
const redisServer = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        for (;;) {
            const header = /^\*(\d+)\r\n/.exec(buffer);
            if (!header) return;
            const count = Number(header[1]);
            let offset = header[0].length;
            const args = [];
            let incomplete = false;
            for (let index = 0; index < count; index += 1) {
                const lengthMatch = /^\$(\d+)\r\n/.exec(buffer.slice(offset));
                if (!lengthMatch) {
                    incomplete = true;
                    break;
                }
                const length = Number(lengthMatch[1]);
                const start = offset + lengthMatch[0].length;
                if (buffer.length < start + length + 2) {
                    incomplete = true;
                    break;
                }
                args.push(buffer.slice(start, start + length));
                offset = start + length + 2;
            }
            if (incomplete) return;
            buffer = buffer.slice(offset);
            const command = String(args[0] || '').toUpperCase();
            if (command === 'PING') {
                socket.write('+PONG\r\n');
            } else if (command === 'AUTH' || command === 'SELECT') {
                socket.write('+OK\r\n');
            } else if (command === 'GET') {
                const value = Buffer.from('nilai-sehat', 'utf8');
                socket.write(Buffer.concat([Buffer.from(`$${value.length}\r\n`, 'utf8'), value, Buffer.from('\r\n')]));
            } else {
                socket.write('-ERR unknown command\r\n');
            }
        }
    });
    socket.on('error', () => {});
});

const mqttServer = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (buffer.length < 2) return;
            let multiplier = 1;
            let length = 0;
            let index = 1;
            for (;;) {
                if (index >= buffer.length) return;
                const digit = buffer[index];
                length += (digit & 0x7f) * multiplier;
                index += 1;
                if ((digit & 0x80) === 0) break;
                multiplier *= 128;
            }
            if (buffer.length < index + length) return;
            const type = (buffer[0] >> 4) & 0x0f;
            const payload = buffer.slice(index, index + length);
            buffer = buffer.slice(index + length);
            if (type === 1) {
                socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
            } else if (type === 8) {
                const topicLength = payload.readUInt16BE(2);
                const topic = payload.slice(4, 4 + topicLength).toString('utf8');
                socket.write(Buffer.from([0x90, 0x03, payload[0], payload[1], 0x00]));
                const topicBuffer = Buffer.from(topic, 'utf8');
                const body = Buffer.concat([
                    Buffer.from([topicBuffer.length >> 8, topicBuffer.length & 0xff]),
                    topicBuffer,
                    Buffer.from('22.5 C', 'utf8'),
                ]);
                socket.write(Buffer.concat([Buffer.from([0x30, body.length]), body]));
            }
        }
    });
    socket.on('error', () => {});
});

function pgMessage(type, payload) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 4, 0);
    return Buffer.concat([Buffer.from(type, 'utf8'), length, payload]);
}

const pgServer = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
            if (buffer.length < 5) return;
            if (buffer[0] === 0x00) {
                // Pesan StartupMessage tidak punya byte tipe.
                const length = buffer.readInt32BE(0);
                if (buffer.length < length) return;
                buffer = buffer.slice(length);
                const authOk = Buffer.alloc(4);
                authOk.writeInt32BE(0, 0);
                socket.write(pgMessage('R', authOk));
                socket.write(pgMessage('Z', Buffer.from('I', 'utf8')));
                continue;
            }
            const length = buffer.readInt32BE(1);
            if (buffer.length < 1 + length) return;
            const type = String.fromCharCode(buffer[0]);
            const payload = buffer.slice(5, 1 + length);
            buffer = buffer.slice(1 + length);
            if (type === 'Q') {
                const fieldCount = Buffer.alloc(2);
                fieldCount.writeInt16BE(1, 0);
                const field = Buffer.concat([
                    Buffer.from('ping\0', 'utf8'),
                    Buffer.alloc(4),
                    Buffer.alloc(2),
                    (() => {
                        const typeOid = Buffer.alloc(4);
                        typeOid.writeInt32BE(23, 0);
                        return typeOid;
                    })(),
                    Buffer.alloc(2),
                    (() => {
                        const modifier = Buffer.alloc(4);
                        modifier.writeInt32BE(-1, 0);
                        return modifier;
                    })(),
                    Buffer.alloc(2),
                ]);
                socket.write(pgMessage('T', Buffer.concat([fieldCount, field])));
                const value = Buffer.from('1', 'utf8');
                const rowCount = Buffer.alloc(2);
                rowCount.writeInt16BE(1, 0);
                const valueLength = Buffer.alloc(4);
                valueLength.writeInt32BE(value.length, 0);
                socket.write(pgMessage('D', Buffer.concat([rowCount, valueLength, value])));
                socket.write(pgMessage('C', Buffer.from('SELECT 1\0', 'utf8')));
                socket.write(pgMessage('Z', Buffer.from('I', 'utf8')));
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
    await listen(redisServer, REDIS_PORT);
    await listen(mqttServer, MQTT_PORT);
    await listen(pgServer, PG_PORT);

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

    await test('pemeriksaan Redis menjalankan perintah dan membandingkan balasan', async () => {
        const monitor = await createMonitor('redis', {
            name: 'Redis Uji',
            type: 'redis',
            hostname: '127.0.0.1',
            port: REDIS_PORT,
            interval: 3600,
            timeout: 5,
            options: { command: 'PING', expected: 'PONG' },
        });
        assert.equal(monitor.options.command, 'PING');
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
        assert.match(response.data.beat.msg, /Redis/);

        const mismatched = await createMonitor('redisMismatch', {
            name: 'Redis Salah',
            type: 'redis',
            hostname: '127.0.0.1',
            port: REDIS_PORT,
            interval: 3600,
            timeout: 5,
            options: { command: 'GET kunci', expected: 'lain' },
        });
        const failed = await admin.fetch(`/api/monitors/${mismatched.id}/check`, { method: 'POST' });
        assert.equal(failed.data.beat.status, 0);
    });

    await test('pemeriksaan MQTT menerima pesan pada topik', async () => {
        const monitor = await createMonitor('mqtt', {
            name: 'MQTT Uji',
            type: 'mqtt',
            hostname: '127.0.0.1',
            port: MQTT_PORT,
            interval: 3600,
            timeout: 5,
            options: { topic: 'sensor/temperatur', expected: '22.5' },
        });
        assert.equal(monitor.options.topic, 'sensor/temperatur');
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
        assert.match(response.data.beat.msg, /MQTT/);
    });

    await test('pemeriksaan PostgreSQL menjalankan kueri', async () => {
        const monitor = await createMonitor('postgres', {
            name: 'PostgreSQL Uji',
            type: 'postgres',
            hostname: '127.0.0.1',
            port: PG_PORT,
            interval: 3600,
            timeout: 5,
            options: { user: 'prasasti', database: 'prasasti', query: 'SELECT 1' },
        });
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 1);
        assert.match(response.data.beat.msg, /PostgreSQL/);
    });

    await test('monitor Docker menuntut nama container dan melapor gagal tanpa daemon', async () => {
        const invalid = await admin.fetch('/api/monitors', {
            method: 'POST',
            body: { name: 'Docker Kosong', type: 'docker', interval: 3600 },
        });
        assert.equal(invalid.status, 400);

        const monitor = await createMonitor('docker', {
            name: 'Docker Uji',
            type: 'docker',
            interval: 3600,
            timeout: 5,
            options: { container: 'prasasti-api', socket: '/tmp/tidak-ada-docker.sock' },
        });
        const response = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(response.data.beat.status, 0);
        assert.match(response.data.beat.msg, /Docker/);
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

    await test('monitor grup punya riwayat denyut dan uptime sendiri', async () => {
        await admin.fetch(`/api/monitors/${monitors.http.id}/check`, { method: 'POST' });
        const detail = await admin.fetch(`/api/monitors/${monitors.group.id}`);
        assert.equal(detail.status, 200);
        assert.ok(detail.data.monitor.beats.length >= 1, 'grup harus punya denyut');
        assert.ok(detail.data.uptime['24h'].uptime !== null, 'uptime grup harus terhitung');
        assert.equal(detail.data.uptime['24h'].total, detail.data.uptime['24h'].up + detail.data.uptime['24h'].down);
        assert.equal(detail.data.monitor.status, 1);
    });

    await test('agregat uptime harian konsisten dengan riwayat denyut', async () => {
        const detail = await admin.fetch(`/api/monitors/${monitors.http.id}`);
        const events = await admin.fetch(`/api/monitors/${monitors.http.id}/events?limit=200`);
        const counted = events.data.events.filter((beat) => beat.status === 0 || beat.status === 1).length;
        const week = detail.data.uptime['7d'];
        assert.equal(week.total, week.up + week.down);
        assert.equal(week.total, counted, 'total 7 hari harus sama dengan jumlah denyut');
        assert.ok(detail.data.uptime['90d']);
        assert.ok(detail.data.uptime['365d']);
        assert.ok(detail.data.uptime['24h'].downtime >= 0);
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

    await test('umpan RSS status page tersedia', async () => {
        const feed = await fetch(`${BASE}/status/${slug}/feed.xml`);
        assert.equal(feed.status, 200);
        assert.match(feed.headers.get('content-type'), /rss\+xml/);
        const xml = await feed.text();
        assert.match(xml, /<rss version="2\.0">/);
        assert.match(xml, /<channel>/);
        assert.match(xml, /Status Uji Prasasti/);
        assert.match(xml, /<item>/);
    });

    await test('pengumuman dan bahasa status page tersimpan', async () => {
        const patched = await admin.fetch(`/api/status-pages/${pageId}`, {
            method: 'PATCH',
            body: { announcement: 'Pemeliharaan terjadwal malam ini.', lang: 'en' },
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.data.statusPage.announcement, 'Pemeliharaan terjadwal malam ini.');
        assert.equal(patched.data.statusPage.lang, 'en');

        const payload = await (await fetch(`${BASE}/api/status-page/${slug}`)).json();
        assert.equal(payload.page.announcement, 'Pemeliharaan terjadwal malam ini.');
        assert.equal(payload.page.lang, 'en');

        await admin.fetch(`/api/status-pages/${pageId}`, {
            method: 'PATCH',
            body: { announcement: '', lang: 'id' },
        });
    });

    await test('domain kustom melayani status page dan menolak domain tak valid', async () => {
        const invalid = await admin.fetch(`/api/status-pages/${pageId}`, {
            method: 'PATCH',
            body: { domain: 'bukan domain' },
        });
        assert.equal(invalid.status, 400);

        const patched = await admin.fetch(`/api/status-pages/${pageId}`, {
            method: 'PATCH',
            body: { domain: 'status.uji.local' },
        });
        assert.equal(patched.status, 200);
        assert.equal(patched.data.statusPage.domain, 'status.uji.local');

        const page = await requestWithHost('status.uji.local', '/');
        assert.equal(page.status, 200);
        assert.match(page.headers['content-type'], /text\/html/);
        assert.match(page.body, /id="status-root"/);

        const json = await requestWithHost('status.uji.local', '/api/status-page/');
        assert.equal(json.status, 200);
        const payload = JSON.parse(json.body);
        assert.equal(payload.page.slug, slug);

        const feed = await requestWithHost('status.uji.local', '/feed.xml');
        assert.equal(feed.status, 200);
        assert.match(feed.body, /<rss/);

        await admin.fetch(`/api/status-pages/${pageId}`, { method: 'PATCH', body: { domain: '' } });
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

    await test('kanal Home Assistant dan Apprise mengirim muatan uji', async () => {
        const before = hookHits.length;

        const homeAssistant = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Home Assistant Uji',
                type: 'homeassistant',
                config: { webhookUrl: `http://127.0.0.1:${HOOK_PORT}/ha` },
            },
        });
        assert.equal(homeAssistant.status, 201);
        const haSent = await admin.fetch(`/api/notifications/${homeAssistant.data.notification.id}/test`, {
            method: 'POST',
        });
        assert.equal(haSent.status, 200);
        assert.equal(hookHits.length, before + 1);
        assert.equal(hookHits[before].url, '/ha');
        const haPayload = JSON.parse(hookHits[before].body);
        assert.match(haPayload.title, /Uji coba notifikasi/);
        assert.equal(haPayload.status, 'up');

        const apprise = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Apprise Uji',
                type: 'apprise',
                config: {
                    serverUrl: `http://127.0.0.1:${HOOK_PORT}`,
                    urls: 'mailto://contoh@uji.local',
                },
            },
        });
        assert.equal(apprise.status, 201);
        const appriseSent = await admin.fetch(`/api/notifications/${apprise.data.notification.id}/test`, {
            method: 'POST',
        });
        assert.equal(appriseSent.status, 200);
        assert.equal(hookHits.length, before + 2);
        assert.equal(hookHits[before + 1].url, '/notify');
        const apprisePayload = JSON.parse(hookHits[before + 1].body);
        assert.equal(apprisePayload.urls, 'mailto://contoh@uji.local');
        assert.equal(apprisePayload.type, 'success');
    });

    await test('kanal Pushover menolak konfigurasi belum lengkap', async () => {
        const created = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: { name: 'Pushover Kosong', type: 'pushover', config: {} },
        });
        assert.equal(created.status, 201);
        const failed = await admin.fetch(`/api/notifications/${created.data.notification.id}/test`, {
            method: 'POST',
        });
        assert.equal(failed.status, 500);
        assert.match(String(failed.data.error), /Pushover/);
        await admin.fetch(`/api/notifications/${created.data.notification.id}`, { method: 'DELETE' });
    });

    await test('filter peristiwa dan notifikasi ulang bekerja', async () => {
        const downChannel = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Kanal Gangguan',
                type: 'webhook',
                config: { url: `http://127.0.0.1:${HOOK_PORT}/down` },
                events: ['down'],
                resendInterval: 0.05,
            },
        });
        assert.equal(downChannel.status, 201);
        assert.deepEqual(downChannel.data.notification.events, ['down']);
        assert.equal(downChannel.data.notification.resendInterval, 0.05);

        const upChannel = await admin.fetch('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Kanal Pemulihan',
                type: 'webhook',
                config: { url: `http://127.0.0.1:${HOOK_PORT}/up` },
                events: ['up'],
            },
        });

        const monitor = await createMonitor('events', {
            name: 'Monitor Peristiwa',
            type: 'http',
            url: `http://127.0.0.1:${TARGET_PORT}/fail`,
            interval: 3600,
        });
        await admin.fetch(`/api/monitors/${monitor.id}`, {
            method: 'PATCH',
            body: { notificationIds: [downChannel.data.notification.id, upChannel.data.notification.id] },
        });

        const before = hookHits.length;
        const first = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(first.data.beat.status, 0);
        await waitFor('notifikasi gangguan terkirim', () => hookHits.length >= before + 1);
        assert.equal(hookHits.length, before + 1, 'hanya kanal gangguan yang menerima peristiwa down');
        assert.equal(hookHits[before].url, '/down');

        // Denyut kedua tanpa perubahan status tidak mengirim ulang sebelum interval habis.
        const immediate = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(immediate.data.beat.status, 0);
        await sleep(500);
        assert.equal(hookHits.length, before + 1, 'tidak ada kiriman ulang sebelum interval');

        // Setelah interval 3 detik, notifikasi gangguan dikirim ulang.
        await sleep(3500);
        await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        await waitFor('notifikasi gangguan diulang', () => hookHits.length >= before + 2);
        assert.equal(hookHits.length, before + 2, 'notifikasi gangguan diulang setelah interval');
        assert.equal(hookHits[before + 1].url, '/down');

        // Pemulihan hanya dikirim ke kanal peristiwa 'up'.
        await admin.fetch(`/api/monitors/${monitor.id}`, {
            method: 'PATCH',
            body: { url: `http://127.0.0.1:${TARGET_PORT}/ok` },
        });
        const recovered = await admin.fetch(`/api/monitors/${monitor.id}/check`, { method: 'POST' });
        assert.equal(recovered.data.beat.status, 1);
        await waitFor('notifikasi pemulihan terkirim', () => hookHits.length >= before + 3);
        assert.equal(hookHits.length, before + 3);
        assert.equal(hookHits[before + 2].url, '/up');
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
        const list = await admin.fetch('/api/monitors');
        assert.equal(exported.data.monitors.length, list.data.monitors.length);
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

    // ================= kunci api =================
    section('Kunci API');

    let readToken = '';
    let writeToken = '';

    await test('kunci API dapat dibuat dan memakai header Bearer', async () => {
        const created = await admin.fetch('/api/api-keys', {
            method: 'POST',
            body: { name: 'Pembaca', scope: 'read' },
        });
        assert.equal(created.status, 201);
        assert.match(created.data.token, /^pk_[0-9a-f]{48}$/);
        assert.equal(created.data.key.scope, 'read');
        readToken = created.data.token;

        const list = await admin.fetch('/api/api-keys');
        assert.equal(list.status, 200);
        assert.ok(list.data.keys.some((key) => key.name === 'Pembaca'));
        assert.ok(!JSON.stringify(list.data.keys).includes(readToken), 'token mentah tidak boleh tersimpan');

        const response = await fetch(`${BASE}/api/monitors`, {
            headers: { Authorization: `Bearer ${readToken}` },
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.ok(Array.isArray(payload.monitors));
    });

    await test('kunci baca ditolak saat menulis, kunci tulis diterima', async () => {
        const denied = await fetch(`${BASE}/api/monitors`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ditolak', type: 'http', url: 'https://contoh.id' }),
        });
        assert.equal(denied.status, 403);

        const created = await admin.fetch('/api/api-keys', {
            method: 'POST',
            body: { name: 'Penulis', scope: 'write' },
        });
        assert.equal(created.status, 201);
        writeToken = created.data.token;

        const allowed = await fetch(`${BASE}/api/monitors`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Monitor lewat kunci',
                type: 'http',
                url: 'https://contoh.id',
                interval: 3600,
            }),
        });
        assert.equal(allowed.status, 201);
    });

    await test('token salah ditolak dan kunci bisa dicabut', async () => {
        const bogus = await fetch(`${BASE}/api/monitors`, {
            headers: { Authorization: 'Bearer pk_tidakada' },
        });
        assert.equal(bogus.status, 401);

        const keys = await admin.fetch('/api/api-keys');
        const target = keys.data.keys.find((key) => key.name === 'Pembaca');
        const revoked = await admin.fetch(`/api/api-keys/${target.id}`, { method: 'DELETE' });
        assert.equal(revoked.status, 200);

        const after = await fetch(`${BASE}/api/monitors`, {
            headers: { Authorization: `Bearer ${readToken}` },
        });
        assert.equal(after.status, 401);
    });

    await test('kunci API tidak dapat membuat kunci lain', async () => {
        const response = await fetch(`${BASE}/api/api-keys`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ekskalasi' }),
        });
        assert.equal(response.status, 403);
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
    await new Promise((resolve) => redisServer.close(resolve));
    await new Promise((resolve) => mqttServer.close(resolve));
    await new Promise((resolve) => pgServer.close(resolve));
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
