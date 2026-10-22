/**
 * Worker Uptime Prasasti Websites.
 *
 * - `/api/*`      REST API (D1)
 * - `/ws`         realtime lewat Durable Object hub
 * - `/status/*`   status page publik dan umpan RSS
 * - lainnya       aset statis dari direktori public/
 */

import { Db } from './db.js';
import { handleApi, scheduleMonitor, monitorStub, statusPageSlugsForMonitor } from './api.js';
import { getPageBySlug, getPageByDomain, statusPageFeed } from './statuspage.js';
import { prune } from './engine.js';
import { Monitor } from './do/monitor.js';
import { Hub } from './do/hub.js';

export { Monitor, Hub };

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
    ].join('; '),
};

function withSecurity(response) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        headers.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers });
}

async function serveAsset(env, request, pathname, status = 200) {
    const url = new URL(request.url);
    const target = new URL(pathname, url.origin);
    const response = await env.ASSETS.fetch(new Request(target, request));
    const result = new Response(response.body, { status, headers: response.headers });
    return withSecurity(result);
}

async function serveNotFound(env, request) {
    return serveAsset(env, request, '/404.html', 404);
}

async function serveFeed(db, request, page) {
    const forwarded = request.headers.get('x-forwarded-proto') || '';
    const protocol = forwarded || new URL(request.url).protocol.replace(':', '');
    const host = request.headers.get('host') || 'localhost';
    const xml = await statusPageFeed(db, page, `${protocol}://${host}`);
    return withSecurity(
        new Response(xml, {
            status: 200,
            headers: {
                'Content-Type': 'application/rss+xml; charset=utf-8',
                'Cache-Control': 'no-store',
            },
        })
    );
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const db = new Db(env);

        if (url.pathname === '/ws') {
            const id = env.HUB.idFromName('hub');
            const stub = env.HUB.get(id);
            return stub.fetch(request);
        }

        if (url.pathname.startsWith('/api/')) {
            return withSecurity(await handleApi(request, env));
        }

        if (url.pathname.startsWith('/status/')) {
            const rest = decodeURIComponent(url.pathname.slice('/status/'.length)).replace(/\/+$/, '');
            const feedMatch = /^(.*)\/(feed\.xml|feed|rss\.xml)$/.exec(rest);
            if (feedMatch) {
                const page = await getPageBySlug(db, feedMatch[1]);
                if (!page || !page.published) {
                    return serveNotFound(env, request);
                }
                return serveFeed(db, request, page);
            }
            const page = await getPageBySlug(db, rest);
            if (!page || !page.published) {
                return serveNotFound(env, request);
            }
            return serveAsset(env, request, '/status.html');
        }

        // Status page dengan domain kustom.
        const host = String(request.headers.get('host') || '').split(':')[0].toLowerCase();
        const domainPage = host ? await getPageByDomain(db, host) : null;
        if (domainPage && domainPage.published) {
            if (url.pathname === '/feed.xml' || url.pathname === '/rss') {
                return serveFeed(db, request, domainPage);
            }
            if (url.pathname === '/' || url.pathname.startsWith('/status/')) {
                return serveAsset(env, request, '/status.html');
            }
        }

        return serveAsset(env, request, url.pathname === '/' ? '/index.html' : url.pathname);
    },

    /**
     * Cron setiap menit: menjalankan monitor yang tertunda, memangkas data lama,
     * dan membersihkan sesi kedaluwarsa.
     */
    async scheduled(event, env, ctx) {
        const db = new Db(env);
        ctx.waitUntil(
            (async () => {
                try {
                    const overdue = await db.all(
                        'SELECT id FROM monitor WHERE active = 1 AND type != ? AND type != ? AND (next_run IS NULL OR next_run <= ?)',
                        ['group', 'push', Date.now() - 60000]
                    );
                    for (const row of overdue) {
                        const stub = monitorStub(env, row.id);
                        const response = await stub
                            .fetch('https://do/run', { method: 'POST', body: '{}' })
                            .catch(() => null);
                        if (response) {
                            await response.text().catch(() => '');
                        }
                    }
                    // Pemangkasan data lama cukup sekali sejam: D1 menghitung
                    // setiap baris yang ditulis, termasuk DELETE.
                    if (new Date(event.scheduledTime).getUTCMinutes() === 0) {
                        const settings = await db.settings();
                        await prune(db, settings);
                    }
                } catch (error) {
                    console.error('[cron]', error);
                }
            })()
        );
    },
};
