/**
 * Durable Object per monitor.
 *
 * Setiap monitor punya satu DO dengan alarm sendiri. Alarm memicu pemeriksaan,
 * lalu DO menjadwalkan pemeriksaan berikutnya. Pemeriksaan manual dari API
 * juga lewat DO ini supaya tidak ada dua pemeriksaan berjalan bersamaan.
 */

import { Db } from '../db.js';
import { performCheck } from '../engine.js';
import { broadcastBeat } from '../api.js';

export class Monitor {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
    }

    get monitorId() {
        const name = String(this.ctx.id.name || '');
        const parts = name.split(':');
        return Number(parts[parts.length - 1]);
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/schedule') {
            const body = await request.json().catch(() => ({}));
            const delay = Math.max(0, Number(body.delay) || 0);
            await this.ctx.storage.setAlarm(Date.now() + delay);
            return Response.json({ ok: true, nextRun: Date.now() + delay });
        }
        if (url.pathname === '/cancel') {
            await this.ctx.storage.deleteAlarm();
            return Response.json({ ok: true });
        }
        if (url.pathname === '/status') {
            const alarm = await this.ctx.storage.getAlarm();
            return Response.json({ nextRun: alarm || null });
        }
        if (url.pathname === '/check') {
            const beat = await this.runCheck({ manual: true });
            return Response.json({ beat });
        }
        if (url.pathname === '/run') {
            const beat = await this.runCheck({ manual: false });
            return Response.json({ beat });
        }
        return new Response('Monitor DO', { status: 200 });
    }

    async alarm() {
        try {
            await this.runCheck({ manual: false });
        } catch (error) {
            // Alarm tidak boleh melempar: kegagalan sementara dicatat dan
            // pemeriksaan dicoba lagi satu menit kemudian.
            console.error('[alarm]', error);
            try {
                await this.ctx.storage.setAlarm(Date.now() + 60000);
            } catch {
                /* storage tidak tersedia */
            }
        }
    }

    /**
     * Jalankan satu pemeriksaan lalu jadwalkan yang berikutnya.
     * Percobaan ulang disimpan di storage DO supaya tetap hidup saat DO
     * di-evict di antara dua alarm.
     */
    async runCheck({ manual = false } = {}) {
        const db = new Db(this.env);
        const id = this.monitorId;
        if (!id) {
            return null;
        }
        const row = await db.one('SELECT * FROM monitor WHERE id = ?', [id]);
        if (!row) {
            await this.ctx.storage.deleteAlarm();
            return null;
        }
        if (!manual && !row.active) {
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.delete('attempts');
            await db.run('UPDATE monitor SET next_run = NULL WHERE id = ?', [id]);
            return null;
        }

        if (manual) {
            await this.ctx.storage.put('attempts', 0);
        }
        const attempts = manual ? 0 : Number((await this.ctx.storage.get('attempts')) || 0);
        const beat = await performCheck(db, this.env, row, { manual, attempts });
        await broadcastBeat(this.env, db, row, beat);

        if (!manual) {
            const retry = Boolean(beat && beat.retry);
            await this.ctx.storage.put('attempts', retry ? attempts + 1 : 0);
            const seconds = retry
                ? Math.max(5, Number(row.retry_interval) || 60)
                : Math.max(20, Number(row.interval) || 60);
            const nextRun = Date.now() + seconds * 1000;
            await db.run('UPDATE monitor SET next_run = ? WHERE id = ?', [nextRun, id]);
            await this.ctx.storage.setAlarm(nextRun);
        }
        return beat;
    }
}
