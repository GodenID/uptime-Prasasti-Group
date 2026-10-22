/**
 * Uji integrasi Worker Uptime Prasasti Websites.
 *
 * Worker dijalankan di workerd (miniflare) dengan D1 lokal dan Durable
 * Object. Permintaan keluar disimulasikan dengan menimpa global fetch.
 */

import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import SCHEMA from '../migrations/0001_init.sql?raw';

// D1 menjalankan satu pernyataan per panggilan, jadi skema dipecah.
const STATEMENTS = SCHEMA.split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

const realFetch = globalThis.fetch;
let sessionCookie = '';

async function applySchema() {
    for (const statement of STATEMENTS) {
        await env.DB.prepare(statement).run();
    }
}

/**
 * Arahkan permintaan keluar ke handler sesuai URL.
 */
function mockRoutes(routes) {
    globalThis.fetch = async (input, init) => {
        const raw = typeof input === 'string' ? input : input.url;
        let url;
        try {
            url = new URL(raw);
        } catch {
            url = new URL(`https://${raw}`);
        }
        const key = `${url.origin}${url.pathname}`;
        const handler = routes[key] || routes[url.href];
        if (!handler) {
            throw new Error(`Tidak ada mock untuk ${raw}`);
        }
        return handler(init, url);
    };
}

async function api(pathname, { method = 'GET', body, headers = {}, raw = false, noAuth = false } = {}) {
    const request = new Request(`https://prasasti.test${pathname}`, {
        method,
        headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(!noAuth && sessionCookie ? { cookie: sessionCookie } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await exports.default.fetch(request);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && setCookie.startsWith('prasasti_sid=')) {
        sessionCookie = setCookie.split(';')[0];
    }
    if (raw) {
        return { status: response.status, text: await response.text(), headers: response.headers };
    }
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text();
    return { status: response.status, data, headers: response.headers };
}

async function login() {
    await api('/api/setup', { method: 'POST', body: { username: 'admin', password: 'rahasia123' } });
    await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'rahasia123' } });
}

beforeAll(async () => {
    await applySchema();
});

beforeEach(() => {
    sessionCookie = '';
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('Dasar & penyiapan', () => {
    it('health dan setup awal', async () => {
        const health = await api('/api/health');
        expect(health.status).toBe(200);
        expect(health.data.ok).toBe(true);

        const before = await api('/api/setup');
        expect(before.data.needSetup).toBe(true);

        const created = await api('/api/setup', {
            method: 'POST',
            body: { username: 'admin', password: 'rahasia123' },
        });
        expect(created.status).toBe(201);

        const after = await api('/api/setup');
        expect(after.data.needSetup).toBe(false);
    });

    it('login, sesi, dan penolakan tanpa sesi', async () => {
        await login();
        const session = await api('/api/session');
        expect(session.data.user.username).toBe('admin');

        const noSession = await api('/api/monitors', { noAuth: true });
        expect(noSession.status).toBe(401);
    });
});

describe('Monitor', () => {
    it('membuat monitor HTTP dan menjalankan pemeriksaan manual', async () => {
        await login();
        mockRoutes({
            'https://contoh.id/': () => new Response('halo', { status: 200 }),
        });

        const created = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Situs Uji', type: 'http', url: 'https://contoh.id', interval: 3600 },
        });
        expect(created.status).toBe(201);
        const monitorId = created.data.monitor.id;

        const check = await api(`/api/monitors/${monitorId}/check`, { method: 'POST' });
        expect(check.status).toBe(200);
        expect(check.data.beat.status).toBe(1);
        expect(check.data.beat.msg).toMatch(/HTTP 200/);

        const detail = await api(`/api/monitors/${monitorId}`);
        expect(detail.data.uptime['24h'].up).toBeGreaterThanOrEqual(1);
        expect(detail.data.events.length).toBeGreaterThan(0);
        expect(detail.data.chart.length).toBeGreaterThan(0);
    });

    it('monitor kata kunci dan JSON memakai nilai yang diharapkan', async () => {
        await login();
        mockRoutes({
            'https://kata.id/': () => new Response('halo dunia', { status: 200 }),
            'https://json.id/': () => Response.json({ status: { ok: true } }),
        });

        const keyword = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Kata', type: 'keyword', url: 'https://kata.id', keyword: 'dunia', interval: 3600 },
        });
        const keywordCheck = await api(`/api/monitors/${keyword.data.monitor.id}/check`, { method: 'POST' });
        expect(keywordCheck.data.beat.status).toBe(1);

        const json = await api('/api/monitors', {
            method: 'POST',
            body: {
                name: 'JSON',
                type: 'json',
                url: 'https://json.id',
                jsonPath: '$.status.ok',
                expectedValue: 'true',
                interval: 3600,
            },
        });
        const jsonCheck = await api(`/api/monitors/${json.data.monitor.id}/check`, { method: 'POST' });
        expect(jsonCheck.data.beat.status).toBe(1);
        expect(jsonCheck.data.beat.msg).toMatch(/Nilai cocok/);
    });

    it('monitor push menerima denyut luar', async () => {
        await login();
        const created = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Push', type: 'push', interval: 3600 },
        });
        const token = created.data.monitor.pushToken;
        expect(token).toBeTruthy();

        const response = await exports.default.fetch(
            `https://prasasti.test/api/push/${token}?status=down&msg=uji`
        );
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload.beat.status).toBe(0);
    });

    it('monitor grup merekam denyut sendiri setelah anak diperiksa', async () => {
        await login();
        mockRoutes({
            'https://anak.id/': () => new Response('ok', { status: 200 }),
        });
        const child = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Anak', type: 'http', url: 'https://anak.id', interval: 3600 },
        });
        const group = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Grup', type: 'group', interval: 3600 },
        });
        await api(`/api/monitors/${child.data.monitor.id}`, {
            method: 'PATCH',
            body: { parentId: group.data.monitor.id },
        });
        await api(`/api/monitors/${child.data.monitor.id}/check`, { method: 'POST' });

        const groupDetail = await api(`/api/monitors/${group.data.monitor.id}`);
        expect(groupDetail.data.monitor.beats.length).toBeGreaterThan(0);
        expect(groupDetail.data.monitor.status).toBe(1);
        expect(groupDetail.data.uptime['24h'].uptime).not.toBeNull();
    });

    it('monitor ping dan docker dilaporkan belum tersedia di Workers', async () => {
        await login();
        const ping = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Ping', type: 'ping', hostname: 'contoh.id', interval: 3600 },
        });
        const pingCheck = await api(`/api/monitors/${ping.data.monitor.id}/check`, { method: 'POST' });
        expect(pingCheck.data.beat.status).toBe(2);
        expect(pingCheck.data.beat.msg).toMatch(/ICMP/);

        const docker = await api('/api/monitors', {
            method: 'POST',
            body: {
                name: 'Docker',
                type: 'docker',
                interval: 3600,
                options: { container: 'prasasti-api' },
            },
        });
        expect(docker.status).toBe(201);
        const dockerCheck = await api(`/api/monitors/${docker.data.monitor.id}/check`, { method: 'POST' });
        expect(dockerCheck.data.beat.status).toBe(2);
        expect(dockerCheck.data.beat.msg).toMatch(/Docker/);
    });

    it('mencoba ulang sebelum menandai monitor benar-benar down', async () => {
        await login();
        mockRoutes({
            'https://gagal.id/': () => new Response('err', { status: 500 }),
        });
        const created = await api('/api/monitors', {
            method: 'POST',
            body: {
                name: 'Retry',
                type: 'http',
                url: 'https://gagal.id',
                interval: 3600,
                retries: 2,
                retryInterval: 60,
            },
        });
        const id = created.data.monitor.id;
        const stub = env.MONITOR.get(env.MONITOR.idFromName(`monitor:${id}`));
        await stub.fetch('https://do/cancel', { method: 'POST', body: '{}' });

        const run = async () => {
            const response = await stub.fetch('https://do/run', { method: 'POST', body: '{}' });
            return response.json();
        };

        const first = await run();
        expect(first.beat.status).toBe(2);
        expect(first.beat.msg).toMatch(/Percobaan 1\/2/);

        const second = await run();
        expect(second.beat.status).toBe(2);
        expect(second.beat.msg).toMatch(/Percobaan 2\/2/);

        const third = await run();
        expect(third.beat.status).toBe(0);
        expect(third.beat.retry).toBe(false);
    });
});

describe('Status page', () => {
    it('status page terbit, dibaca publik, dan punya umpan RSS', async () => {
        await login();
        mockRoutes({
            'https://layanan.id/': () => new Response('ok', { status: 200 }),
        });
        const monitor = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Layanan', type: 'http', url: 'https://layanan.id', interval: 3600 },
        });
        const page = await api('/api/status-pages', {
            method: 'POST',
            body: {
                title: 'Status Uji',
                slug: 'uji',
                published: true,
                monitors: [monitor.data.monitor.id],
                announcement: 'Pemeliharaan malam ini.',
                lang: 'en',
            },
        });
        expect(page.status).toBe(201);
        expect(page.data.statusPage.domain).toBe('');

        const payload = await api('/api/status-page/uji');
        expect(payload.status).toBe(200);
        expect(payload.data.page.announcement).toBe('Pemeliharaan malam ini.');
        expect(payload.data.page.lang).toBe('en');
        expect(payload.data.monitors.length).toBe(1);

        const feed = await api('/status/uji/feed.xml', { raw: true });
        expect(feed.status).toBe(200);
        expect(feed.headers.get('content-type')).toMatch(/rss\+xml/);
        expect(feed.text).toMatch(/<rss version="2\.0">/);
        expect(feed.text).toMatch(/Status Uji/);
    });

    it('domain kustom melayani status page dan umpan RSS', async () => {
        await login();
        const page = await api('/api/status-pages', {
            method: 'POST',
            body: { title: 'Status Domain', slug: 'domain', published: true, domain: 'status.uji.local' },
        });
        expect(page.data.statusPage.domain).toBe('status.uji.local');

        const response = await exports.default.fetch('https://status.uji.local/', {
            headers: { host: 'status.uji.local' },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('id="status-root"');

        const feed = await exports.default.fetch('https://status.uji.local/feed.xml', {
            headers: { host: 'status.uji.local' },
        });
        expect(feed.status).toBe(200);
        expect(await feed.text()).toMatch(/<rss/);
    });
    it('slug status page yang tidak dikenal mengembalikan 404', async () => {
        const missing = await api('/status/tidak-ada', { raw: true });
        expect(missing.status).toBe(404);
        const feed = await api('/status/tidak-ada/feed.xml', { raw: true });
        expect(feed.status).toBe(404);
    });
    it('pelanggan realtime menerima snapshot status page', async () => {
        await login();
        const page = await api('/api/status-pages', {
            method: 'POST',
            body: { title: 'Status Realtime', slug: 'realtime', published: true },
        });
        expect(page.status).toBe(201);

        const response = await exports.default.fetch(
            new Request('https://prasasti.test/ws', { headers: { Upgrade: 'websocket' } })
        );
        expect(response.status).toBe(101);
        const client = response.webSocket;
        client.accept();

        const messages = [];
        client.addEventListener('message', (event) => {
            messages.push(JSON.parse(event.data));
        });
        client.send(JSON.stringify({ type: 'subscribe', slug: 'realtime' }));

        const started = Date.now();
        while (Date.now() - started < 5000 && !messages.some((m) => m.type === 'status:snapshot')) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const subscribed = messages.find((m) => m.type === 'subscribed');
        expect(subscribed.slug).toBe('realtime');
        const snapshot = messages.find((m) => m.type === 'status:snapshot');
        expect(snapshot.payload.page.slug).toBe('realtime');
        client.close();
    });
});

describe('Kunci API', () => {
    it('kunci baca bisa GET, ditolak saat menulis, dan bisa dicabut', async () => {
        await login();
        const created = await api('/api/api-keys', {
            method: 'POST',
            body: { name: 'Pembaca', scope: 'read' },
        });
        expect(created.status).toBe(201);
        expect(created.data.token).toMatch(/^pk_[0-9a-f]{48}$/);

        const bearer = { authorization: `Bearer ${created.data.token}` };
        const read = await api('/api/monitors', { headers: bearer });
        expect(read.status).toBe(200);

        const denied = await api('/api/monitors', {
            method: 'POST',
            headers: bearer,
            body: { name: 'Ditolak', type: 'http', url: 'https://contoh.id' },
        });
        expect(denied.status).toBe(403);

        const list = await api('/api/api-keys');
        const target = list.data.keys.find((key) => key.name === 'Pembaca');
        const revoked = await api(`/api/api-keys/${target.id}`, { method: 'DELETE' });
        expect(revoked.status).toBe(200);

        const after = await api('/api/monitors', { headers: bearer });
        expect(after.status).toBe(401);
    });
});

describe('Impor', () => {
    it('impor memetakan nama tag ke tag yang dibuat', async () => {
        await login();
        const imported = await api('/api/import', {
            method: 'POST',
            body: {
                tags: [{ id: 99, name: 'impor', color: '#123456' }],
                notifications: [],
                statusPages: [],
                monitors: [
                    {
                        id: 7,
                        name: 'Monitor Impor',
                        type: 'push',
                        interval: 3600,
                        tags: ['impor'],
                        notificationIds: [],
                    },
                ],
            },
        });
        expect(imported.status).toBe(200);
        expect(imported.data.imported.monitors).toBe(1);

        const bootstrap = await api('/api/bootstrap');
        const monitor = bootstrap.data.monitors.find((item) => item.name === 'Monitor Impor');
        expect(monitor).toBeTruthy();
        expect(monitor.tags.map((tag) => tag.name)).toContain('impor');
    });
});

describe('Notifikasi', () => {    it('kanal webhook menerima muatan uji', async () => {
        await login();
        let received = null;
        mockRoutes({
            'https://hook.id/uji': async (init) => {
                received = JSON.parse(init.body);
                return new Response('{"ok":true}', { status: 200 });
            },
        });

        const created = await api('/api/notifications', {
            method: 'POST',
            body: {
                name: 'Webhook Uji',
                type: 'webhook',
                config: { url: 'https://hook.id/uji' },
            },
        });
        const sent = await api(`/api/notifications/${created.data.notification.id}/test`, { method: 'POST' });
        expect(sent.status).toBe(200);
        expect(received.title).toMatch(/Uji coba notifikasi/);
        expect(received.status).toBe('up');

        const logs = await api('/api/notification-logs');
        expect(logs.data.logs.some((entry) => entry.event === 'test' && entry.ok === 1)).toBe(true);
    });

    it('kanal Pushover menolak konfigurasi belum lengkap', async () => {
        await login();
        const created = await api('/api/notifications', {
            method: 'POST',
            body: { name: 'Pushover Kosong', type: 'pushover', config: {} },
        });
        const failed = await api(`/api/notifications/${created.data.notification.id}/test`, { method: 'POST' });
        expect(failed.status).toBe(500);
        expect(String(failed.data.error)).toMatch(/Pushover/);
    });
});

describe('Badge & aset', () => {
    it('badge SVG tersedia tanpa sesi', async () => {
        await login();
        const monitor = await api('/api/monitors', {
            method: 'POST',
            body: { name: 'Badge', type: 'http', url: 'https://badge.id', interval: 3600 },
        });
        const response = await exports.default.fetch(
            `https://prasasti.test/api/badge/${monitor.data.monitor.id}/status`
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toMatch(/image\/svg\+xml/);
        expect(await response.text()).toMatch(/<svg/);
    });

    it('aset statis tersaji', async () => {
        const index = await exports.default.fetch('https://prasasti.test/');
        expect(index.status).toBe(200);
        expect(await index.text()).toContain('id="app"');

        const script = await exports.default.fetch('https://prasasti.test/js/status.js');
        expect(script.status).toBe(200);
        expect(script.headers.get('content-type')).toMatch(/javascript/);
    });
});
