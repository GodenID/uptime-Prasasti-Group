/**
 * Durable Object hub realtime.
 *
 * Menyimpan koneksi WebSocket admin dan pelanggan status page. Memakai API
 * hibernasi supaya koneksi tetap hidup saat DO di-evict. Langganan slug disimpan
 * di attachment socket karena tag tidak bisa diubah setelah socket diterima.
 */

import { Db } from '../db.js';
import { statusPagePayload, getPageBySlug } from '../statuspage.js';
import { getSessionUser, parseCookies } from '../auth.js';

const SNAPSHOT_THROTTLE = 1500;

export class Hub {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.lastSnapshot = new Map();
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (request.headers.get('Upgrade') === 'websocket') {
            const user = await this.authenticate(request);
            const pair = new WebSocketPair();
            const client = pair[0];
            const server = pair[1];
            this.ctx.acceptWebSocket(server, user ? ['admin'] : ['public']);
            server.serializeAttachment({ admin: Boolean(user), slug: null });
            if (user) {
                server.send(JSON.stringify({ type: 'ready', user: { id: user.id, username: user.username } }));
            }
            return new Response(null, { status: 101, webSocket: client });
        }

        if (url.pathname === '/broadcast') {
            const payload = await request.json().catch(() => ({}));
            await this.broadcast(payload);
            return Response.json({ ok: true });
        }

        if (url.pathname === '/snapshot') {
            const body = await request.json().catch(() => ({}));
            const count = await this.pushSnapshot(String(body.slug || ''));
            return Response.json({ ok: true, sent: count });
        }

        return new Response('Hub', { status: 200 });
    }

    async authenticate(request) {
        const db = new Db(this.env);
        const cookies = parseCookies(request.headers.get('cookie'));
        try {
            return await getSessionUser(db, cookies.prasasti_sid);
        } catch {
            return null;
        }
    }

    /**
     * Pesan dari klien: subscribe/unsubscribe/ping.
     */
    async webSocketMessage(ws, message) {
        let payload;
        try {
            payload = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
        } catch {
            return;
        }
        if (!payload || typeof payload.type !== 'string') {
            return;
        }
        if (payload.type === 'subscribe' && payload.slug) {
            const slug = String(payload.slug).slice(0, 60);
            const attachment = ws.deserializeAttachment() || {};
            ws.serializeAttachment({ ...attachment, slug });
            ws.send(JSON.stringify({ type: 'subscribed', slug }));
            await this.pushSnapshot(slug, true);
            return;
        }
        if (payload.type === 'unsubscribe') {
            const attachment = ws.deserializeAttachment() || {};
            ws.serializeAttachment({ ...attachment, slug: null });
            return;
        }
        if (payload.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        }
    }

    async webSocketClose(ws, code, reason, wasClean) {
        /* hibernasi membersihkan socket secara otomatis */
    }

    async webSocketError(ws, error) {
        /* diabaikan */
    }

    async broadcast(payload) {
        const sockets = this.ctx.getWebSockets();
        if (payload.type === 'beat' || payload.type === 'refresh' || payload.type === 'settings') {
            const message = JSON.stringify(payload);
            for (const socket of sockets) {
                const attachment = socket.deserializeAttachment() || {};
                if (attachment.admin) {
                    try {
                        socket.send(message);
                    } catch {
                        /* socket sudah tertutup */
                    }
                }
            }
        }
        const slugs = Array.isArray(payload.slugs) ? payload.slugs : [];
        if (slugs.length) {
            for (const slug of slugs) {
                await this.pushSnapshot(slug);
            }
        }
        if (payload.type === 'refresh' && !slugs.length) {
            const db = new Db(this.env);
            const rows = await db.all('SELECT slug FROM status_page WHERE published = 1');
            for (const row of rows) {
                await this.pushSnapshot(row.slug);
            }
        }
    }

    /**
     * Kirim snapshot status page ke semua pelanggan yang berlangganan slug.
     */
    async pushSnapshot(slug, force = false) {
        if (!slug) {
            return 0;
        }
        const last = this.lastSnapshot.get(slug) || 0;
        if (!force && Date.now() - last < SNAPSHOT_THROTTLE) {
            return 0;
        }
        this.lastSnapshot.set(slug, Date.now());
        const db = new Db(this.env);
        const page = await getPageBySlug(db, slug);
        if (!page || !page.published) {
            return 0;
        }
        const payload = await statusPagePayload(db, page);
        const message = JSON.stringify({ type: 'status:snapshot', slug, payload });
        let sent = 0;
        for (const socket of this.ctx.getWebSockets()) {
            const attachment = socket.deserializeAttachment() || {};
            if (attachment.slug === slug) {
                try {
                    socket.send(message);
                    sent += 1;
                } catch {
                    /* socket sudah tertutup */
                }
            }
        }
        return sent;
    }
}
