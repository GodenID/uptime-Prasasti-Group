'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { getSettings, get, DB_PATH, close } = require('./db');
const { handleApi } = require('./api');
const { createWebSocketServer } = require('./ws');
const { parseCookies, getSessionUser } = require('./auth');
const engine = require('./engine');
const { statusPagePayload, getPageBySlug, getPageByDomain, statusPageFeed, pageMonitorsFlat } = require('./statuspage');
const { now } = require('./util');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = '1.0.0';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
};

function readBody(req, limit = 2 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('Payload terlalu besar'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('Body harus JSON yang valid'));
            }
        });
        req.on('error', reject);
    });
}

function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src 'self' ws: wss:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
        ].join('; ')
    );
}

function serveFile(req, res, filePath, { cache = false, status = 200 } = {}) {
    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Tidak ditemukan');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag });
            res.end();
            return;
        }
        res.setHeader('Content-Type', type);
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', cache ? 'public, max-age=3600' : 'no-cache');

        if (req.method === 'HEAD') {
            res.writeHead(status, { 'Content-Length': stat.size });
            res.end();
            return;
        }

        const compressible = ['text/html', 'text/javascript', 'text/css', 'image/svg+xml', 'application/json'].some(
            (prefix) => type.startsWith(prefix)
        );
        const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
        if (compressible && acceptsGzip && stat.size > 1024) {
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.writeHead(status);
            fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
            return;
        }

        res.writeHead(status, { 'Content-Length': stat.size });
        fs.createReadStream(filePath).pipe(res);
    });
}

function safeJoin(root, target) {
    const resolved = path.resolve(root, `.${path.posix.normalize(`/${target}`)}`);
    return resolved.startsWith(path.resolve(root)) ? resolved : null;
}

function serveFeed(req, res, page) {
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwarded || (req.socket.encrypted ? 'https' : 'http');
    const host = req.headers.host || 'localhost';
    const xml = statusPageFeed(page, `${protocol}://${host}`);
    res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(xml),
    });
    res.end(xml);
}

const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        res.writeHead(400);
        res.end('Permintaan tidak valid');
        return;
    }

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' });
        res.end();
        return;
    }

    if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url, readBody);
        return;
    }

    if (url.pathname === '/ws') {
        res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('WebSocket hanya melalui upgrade');
        return;
    }

    if (url.pathname.startsWith('/status/')) {
        const rest = decodeURIComponent(url.pathname.slice('/status/'.length)).replace(/\/+$/, '');
        const feedMatch = /^(.*)\/(feed\.xml|feed|rss\.xml)$/.exec(rest);
        if (feedMatch) {
            const page = getPageBySlug(feedMatch[1]);
            if (!page || !page.published) {
                serveFile(req, res, path.join(PUBLIC_DIR, '404.html'), { status: 404 });
                return;
            }
            serveFeed(req, res, page);
            return;
        }
        const page = getPageBySlug(rest);
        if (!page || !page.published) {
            serveFile(req, res, path.join(PUBLIC_DIR, '404.html'), { status: 404 });
            return;
        }
        serveFile(req, res, path.join(PUBLIC_DIR, 'status.html'));
        return;
    }

    // Status page dengan domain kustom: seluruh path publik memakai halaman itu.
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const domainPage = host ? getPageByDomain(host) : null;
    if (domainPage && domainPage.published) {
        if (url.pathname === '/feed.xml' || url.pathname === '/rss') {
            serveFeed(req, res, domainPage);
            return;
        }
        if (url.pathname === '/' || url.pathname.startsWith('/status/')) {
            serveFile(req, res, path.join(PUBLIC_DIR, 'status.html'));
            return;
        }
    }

    if (url.pathname === '/favicon.ico') {
        serveFile(req, res, path.join(PUBLIC_DIR, 'favicon.svg'), { cache: true });
        return;
    }

    if (url.pathname === '/') {
        serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
        return;
    }

    const filePath = safeJoin(PUBLIC_DIR, url.pathname);
    if (!filePath) {
        res.writeHead(400);
        res.end('Path tidak valid');
        return;
    }
    serveFile(req, res, filePath, { cache: true });
});

// ---------- realtime ----------
const statusSubscribers = new Map();
const statusThrottle = new Map();

function broadcastAuthed(payload) {
    const text = JSON.stringify(payload);
    for (const client of wss.clients) {
        if (client.user) {
            client.send(text);
        }
    }
}

function pushStatusUpdate(slug) {
    const last = statusThrottle.get(slug) || 0;
    if (Date.now() - last < 1500) {
        return;
    }
    statusThrottle.set(slug, Date.now());
    const page = getPageBySlug(slug);
    if (!page || !page.published) {
        return;
    }
    const subscribers = statusSubscribers.get(slug);
    if (!subscribers || !subscribers.size) {
        return;
    }
    const payload = statusPagePayload(page);
    for (const client of subscribers) {
        client.send({ type: 'status:snapshot', slug, payload });
    }
}

const wss = createWebSocketServer(server, {
    path: '/ws',
    onConnection(client) {
        const cookies = parseCookies(client.request.headers.cookie);
        client.user = getSessionUser(cookies.prasasti_sid);
        client.subscribedSlug = null;
        if (client.user) {
            client.send({ type: 'ready', user: { id: client.user.id, username: client.user.username } });
        }

        client.on('message', (raw) => {
            let message;
            try {
                message = JSON.parse(raw);
            } catch {
                return;
            }
            if (!message || typeof message.type !== 'string') {
                return;
            }
            if (message.type === 'subscribe' && message.slug) {
                const slug = String(message.slug).slice(0, 60);
                if (!statusSubscribers.has(slug)) {
                    statusSubscribers.set(slug, new Set());
                }
                statusSubscribers.get(slug).add(client);
                client.subscribedSlug = slug;
                client.send({ type: 'subscribed', slug });
                const page = getPageBySlug(slug);
                if (page && page.published) {
                    client.send({ type: 'status:snapshot', slug, payload: statusPagePayload(page) });
                }
                return;
            }
            if (message.type === 'unsubscribe') {
                const slug = client.subscribedSlug;
                if (slug && statusSubscribers.has(slug)) {
                    statusSubscribers.get(slug).delete(client);
                }
                client.subscribedSlug = null;
                return;
            }
            if (message.type === 'ping') {
                client.send({ type: 'pong', time: now() });
            }
        });

        client.on('close', () => {
            const slug = client.subscribedSlug;
            if (slug && statusSubscribers.has(slug)) {
                statusSubscribers.get(slug).delete(client);
            }
        });
    },
});

engine.bus.on('beat', ({ monitorId, beat }) => {
    const row = get('SELECT * FROM monitor WHERE id = ?', [monitorId]);
    if (!row) {
        return;
    }
    const summary = engine.summary(row);
    broadcastAuthed({ type: 'beat', monitorId, beat, summary });
    for (const [slug, subscribers] of statusSubscribers) {
        if (!subscribers.size) {
            continue;
        }
        const page = getPageBySlug(slug);
        if (!page) {
            continue;
        }
        if (pageMonitorsFlat(page.id).some((monitor) => monitor.id === monitorId)) {
            pushStatusUpdate(slug);
        }
    }
});

engine.bus.on('incident:new', () => {
    broadcastAuthed({ type: 'refresh', scope: 'incidents' });
    for (const slug of statusSubscribers.keys()) {
        pushStatusUpdate(slug);
    }
});

engine.bus.on('incident:resolved', () => {
    broadcastAuthed({ type: 'refresh', scope: 'incidents' });
    for (const slug of statusSubscribers.keys()) {
        pushStatusUpdate(slug);
    }
});

engine.bus.on('monitors:changed', (payload) => {
    broadcastAuthed({ type: 'refresh', scope: 'monitors', ...payload });
});

engine.bus.on('maintenance:update', () => {
    broadcastAuthed({ type: 'refresh', scope: 'maintenance' });
});

engine.bus.on('settings:changed', (settings) => {
    broadcastAuthed({ type: 'settings', settings });
});

engine.bus.on('error', (error) => {
    console.error('[engine]', error.message || error);
});

engine.start();

setInterval(() => {
    for (const client of wss.clients) {
        if (!client.user) {
            const cookies = parseCookies(client.request.headers.cookie);
            const user = getSessionUser(cookies.prasasti_sid);
            if (user) {
                client.user = user;
                client.send({ type: 'ready', user: { id: user.id, username: user.username } });
            }
        }
    }
}, 15000).unref();

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} sudah dipakai proses lain.`);
        console.error('  Hentikan proses tersebut, atau jalankan dengan port lain:');
        console.error('    PowerShell : $env:PORT=3002; npm start');
        console.error('    cmd        : set PORT=3002 && npm start');
        console.error('    bash       : PORT=3002 npm start\n');
        process.exit(1);
    }
    console.error('\n  Server gagal berjalan:', error.message, '\n');
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const settings = getSettings();
    console.log(`\n  ${settings.title} ${VERSION}`);
    console.log(`  Berjalan di http://localhost:${PORT}`);
    console.log(`  Basis data: ${DB_PATH}\n`);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`\n[${signal}] Menghentikan Prasasti...`);
    engine.stop();
    wss.closeAll();
    server.close(() => {
        close();
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
    console.error('[unhandled]', error);
});

module.exports = server;
