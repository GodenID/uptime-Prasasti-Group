'use strict';

const { EventEmitter } = require('node:events');
const { all, get, run, getSettings, getSetting } = require('./db');
const { STATUS, now, clamp, percent, parseJson } = require('./util');
const { runCheck } = require('./checks');
const { dispatch } = require('./notifier');
const { shapeBeat, shapeMonitor, shapeIncident } = require('./models');

const MIN_INTERVAL = 20;
const DAY = 86400000;

class Engine {
    constructor() {
        this.bus = new EventEmitter();
        this.bus.setMaxListeners(50);
        this.runtimes = new Map();
        this.settings = getSettings();
        this.pruneTimer = null;
        this.maintenanceTimer = null;
        this.started = false;
    }

    reloadSettings() {
        this.settings = getSettings();
    }

    start() {
        if (this.started) {
            return;
        }
        this.started = true;
        this.rescheduleAll(700);
        this.pruneTimer = setInterval(() => this.prune(), 60 * 60 * 1000);
        this.pruneTimer.unref?.();
        this.maintenanceTimer = setInterval(() => this.rollMaintenance(), 60 * 1000);
        this.maintenanceTimer.unref?.();
        this.prune();
    }

    stop() {
        for (const runtime of this.runtimes.values()) {
            clearTimeout(runtime.timer);
        }
        this.runtimes.clear();
        clearInterval(this.pruneTimer);
        clearInterval(this.maintenanceTimer);
        this.started = false;
    }

    runtime(monitor) {
        let runtime = this.runtimes.get(monitor.id);
        if (!runtime) {
            runtime = { timer: null, running: false, attempts: 0, nextAt: null };
            this.runtimes.set(monitor.id, runtime);
        }
        return runtime;
    }

    rescheduleAll(delay = 0) {
        for (const runtime of this.runtimes.values()) {
            clearTimeout(runtime.timer);
        }
        this.runtimes.clear();
        const monitors = all('SELECT * FROM monitor WHERE active = 1');
        monitors.forEach((monitor, index) => {
            if (monitor.type === 'group' || monitor.type === 'push') {
                return;
            }
            this.schedule(monitor, delay + index * 120);
        });
    }

    schedule(monitor, delay = null) {
        const runtime = this.runtime(monitor);
        clearTimeout(runtime.timer);
        if (!monitor.active || monitor.type === 'group' || monitor.type === 'push') {
            runtime.nextAt = null;
            return;
        }
        const wait = delay === null ? Math.max(MIN_INTERVAL, Number(monitor.interval)) * 1000 : delay;
        runtime.nextAt = now() + wait;
        runtime.timer = setTimeout(() => {
            this.performCheck(monitor).catch((error) => {
                this.bus.emit('error', error);
            });
        }, wait);
        runtime.timer.unref?.();
    }

    unschedule(monitorId) {
        const runtime = this.runtimes.get(monitorId);
        if (runtime) {
            clearTimeout(runtime.timer);
            this.runtimes.delete(monitorId);
        }
    }

    getMonitor(monitorId) {
        const row = get('SELECT * FROM monitor WHERE id = ?', [monitorId]);
        return row ? shapeMonitor(row) : null;
    }

    activeMaintenance(monitorId) {
        const timestamp = now();
        return get(
            `SELECT m.* FROM maintenance m
             JOIN maintenance_monitor mm ON mm.maintenance_id = m.id
             WHERE mm.monitor_id = ? AND m.active = 1 AND m.start_at <= ? AND m.end_at >= ?
             ORDER BY m.start_at DESC LIMIT 1`,
            [monitorId, timestamp, timestamp]
        );
    }

    rollMaintenance() {
        const timestamp = now();
        const recurring = all("SELECT * FROM maintenance WHERE active = 1 AND strategy != 'once'");
        for (const row of recurring) {
            const step = row.strategy === 'weekly' ? 7 * DAY : DAY;
            let start = Number(row.start_at);
            let end = Number(row.end_at);
            if (end >= timestamp) {
                continue;
            }
            while (end < timestamp) {
                start += step;
                end += step;
            }
            run('UPDATE maintenance SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?', [
                start,
                end,
                timestamp,
                row.id,
            ]);
            this.bus.emit('maintenance:update', { id: row.id });
        }
    }

    async performCheck(monitor, options = {}) {
        const runtime = this.runtime(monitor);
        if (runtime.running) {
            return null;
        }
        runtime.running = true;
        const startedAt = Date.now();
        try {
            const maintenance = options.manual ? null : this.activeMaintenance(monitor.id);
            if (maintenance) {
                const beat = this.insertBeat(monitor, {
                    status: STATUS.MAINTENANCE,
                    msg: `Pemeliharaan: ${maintenance.title}`,
                    ping: null,
                    important: false,
                });
                this.broadcastBeat(monitor, beat);
                this.schedule(monitor);
                return beat;
            }

            const result = options.pushResult || (await runCheck(monitor));
            const outcome = this.applyResult(monitor, result, {
                manual: Boolean(options.manual),
                source: options.source || 'scheduler',
            });

            if (this.started && !options.manual) {
                const wait = outcome.retry
                    ? Math.max(5, Number(monitor.retryInterval) || 60) * 1000
                    : Math.max(MIN_INTERVAL, Number(monitor.interval)) * 1000;
                const drift = Date.now() - startedAt;
                this.schedule(monitor, Math.max(1500, wait - Math.min(drift, wait / 2)));
            }
            return outcome.beat;
        } catch (error) {
            this.bus.emit('error', error);
            const beat = this.insertBeat(monitor, {
                status: STATUS.DOWN,
                msg: `Kesalahan internal: ${String(error.message).slice(0, 160)}`,
                ping: null,
                important: false,
            });
            this.broadcastBeat(monitor, beat);
            if (this.started && !options.manual) {
                this.schedule(monitor);
            }
            return beat;
        } finally {
            runtime.running = false;
        }
    }

    applyResult(monitor, result, { manual = false, source = 'scheduler' } = {}) {
        const runtime = this.runtime(monitor);
        const previous = this.lastBeat(monitor.id);
        const previousStatus = previous ? previous.status : null;
        let status = result.status;
        let message = result.msg || '';
        let retry = false;
        let important = false;

        const failing = status === STATUS.DOWN;
        if (
            failing &&
            !manual &&
            monitor.retries > 0 &&
            runtime.attempts < monitor.retries &&
            previousStatus !== STATUS.DOWN
        ) {
            runtime.attempts += 1;
            status = STATUS.PENDING;
            message = `Percobaan ${runtime.attempts}/${monitor.retries}: ${message}`;
            retry = true;
        } else {
            runtime.attempts = 0;
        }

        if (previousStatus === null) {
            important = status !== STATUS.PENDING;
        } else if (previousStatus !== status && status !== STATUS.PENDING) {
            important = true;
        }

        const certInfo = {};
        if (result.cert) {
            certInfo.cert = result.cert;
        }
        if (result.domain) {
            certInfo.domain = result.domain;
        }
        if (result.dns) {
            certInfo.dns = result.dns;
        }
        if (result.httpStatus) {
            certInfo.httpStatus = result.httpStatus;
        }

        const beat = this.insertBeat(monitor, {
            status,
            msg: message,
            ping: result.ping ?? null,
            important,
            certInfo: Object.keys(certInfo).length ? certInfo : null,
        });

        if (important) {
            this.handleTransition(monitor, beat, previousStatus);
        }

        if (result.cert && monitor.certExpiryNotification) {
            this.maybeCertificateAlert(monitor, result.cert);
        }
        if (result.domain && monitor.domainExpiryNotification) {
            this.maybeDomainAlert(monitor, result.domain);
        }

        this.broadcastBeat(monitor, beat);
        return { beat, retry };
    }

    insertBeat(monitor, { status, msg, ping, important, certInfo }) {
        const timestamp = now();
        const previous = this.lastBeat(monitor.id);
        const duration = previous ? Math.max(0, timestamp - previous.time) : 0;
        const info = run(
            `INSERT INTO heartbeat (monitor_id, status, msg, ping, time, important, duration, cert_info)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                monitor.id,
                status,
                String(msg || '').slice(0, 500),
                ping === null || ping === undefined ? null : Math.round(Number(ping) * 100) / 100,
                timestamp,
                important ? 1 : 0,
                duration,
                certInfo ? JSON.stringify(certInfo) : null,
            ]
        );
        return {
            id: Number(info.lastInsertRowid),
            monitorId: monitor.id,
            status,
            msg: String(msg || '').slice(0, 500),
            ping: ping === null || ping === undefined ? null : Math.round(Number(ping) * 100) / 100,
            time: timestamp,
            important: Boolean(important),
            duration,
            certInfo,
        };
    }

    lastBeat(monitorId) {
        const row = get('SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1', [monitorId]);
        return row ? shapeBeat(row) : null;
    }

    handleTransition(monitor, beat, previousStatus) {
        if (beat.status === STATUS.DOWN) {
            this.openIncidents(monitor, beat);
        } else if (beat.status === STATUS.UP && previousStatus === STATUS.DOWN) {
            this.resolveIncidents(monitor);
        }
        const event = beat.status === STATUS.DOWN ? 'down' : beat.status === STATUS.UP ? 'up' : 'status';
        this.notify(monitor, {
            title:
                beat.status === STATUS.DOWN
                    ? `${monitor.name} mengalami gangguan`
                    : `${monitor.name} kembali operasional`,
            message: beat.msg,
            status: beat.status === STATUS.DOWN ? 'down' : beat.status === STATUS.UP ? 'up' : 'warning',
            event,
            time: beat.time,
        }).catch((error) => this.bus.emit('error', error));
    }

    statusPagesForMonitor(monitorId) {
        return all(
            `SELECT DISTINCT sp.* FROM status_page sp
             WHERE sp.id IN (SELECT status_page_id FROM status_page_monitor WHERE monitor_id = ?)
                OR sp.id IN (
                    SELECT g.status_page_id FROM status_page_group g
                    JOIN status_page_group_monitor gm ON gm.group_id = g.id
                    WHERE gm.monitor_id = ?
                )`,
            [monitorId, monitorId]
        );
    }

    openIncidents(monitor, beat) {
        const timestamp = now();
        const pages = this.statusPagesForMonitor(monitor.id);
        const targets = pages.length ? pages : [{ id: null }];
        for (const page of targets) {
            const existing = get(
                `SELECT id FROM incident WHERE monitor_id = ? AND resolved_at IS NULL
                 AND (status_page_id IS ? OR status_page_id = ?) LIMIT 1`,
                [monitor.id, page.id, page.id]
            );
            if (existing) {
                continue;
            }
            const info = run(
                `INSERT INTO incident (monitor_id, status_page_id, title, content, style, started_at, pinned, created_at)
                 VALUES (?, ?, ?, ?, 'danger', ?, 0, ?)`,
                [
                    monitor.id,
                    page.id,
                    `Gangguan pada ${monitor.name}`,
                    beat.msg || 'Monitor terdeteksi tidak tersedia.',
                    timestamp,
                    timestamp,
                ]
            );
            this.bus.emit('incident:new', { id: Number(info.lastInsertRowid), monitorId: monitor.id });
        }
    }

    resolveIncidents(monitor) {
        const timestamp = now();
        const open = all('SELECT id FROM incident WHERE monitor_id = ? AND resolved_at IS NULL', [monitor.id]);
        if (!open.length) {
            return;
        }
        run('UPDATE incident SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL', [
            timestamp,
            monitor.id,
        ]);
        this.bus.emit('incident:resolved', { monitorId: monitor.id, ids: open.map((row) => row.id) });
    }

    recipients(monitorId) {
        const explicit = all(
            `SELECT n.* FROM notification n
             JOIN monitor_notification mn ON mn.notification_id = n.id
             WHERE mn.monitor_id = ? AND n.active = 1`,
            [monitorId]
        );
        const defaults = all('SELECT * FROM notification WHERE active = 1 AND is_default = 1');
        const seen = new Set();
        const merged = [];
        for (const row of [...explicit, ...defaults]) {
            if (seen.has(row.id)) {
                continue;
            }
            seen.add(row.id);
            merged.push(row);
        }
        return merged.map((row) => ({ ...row, config: parseJson(row.config, {}) }));
    }

    async notify(monitor, payload) {
        const recipients = this.recipients(monitor.id);
        if (!recipients.length) {
            return [];
        }
        const results = [];
        for (const notification of recipients) {
            const started = Date.now();
            try {
                const message = await dispatch(notification, {
                    ...payload,
                    monitor,
                    monitorUrl: monitor.url || '',
                });
                run(
                    'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, ?, ?, 1, ?, ?)',
                    [notification.id, monitor.id, payload.event || 'status', message || 'OK', Date.now()]
                );
                results.push({ id: notification.id, ok: true, message });
            } catch (error) {
                run(
                    'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, ?, ?, 0, ?, ?)',
                    [
                        notification.id,
                        monitor.id,
                        payload.event || 'status',
                        String(error.message).slice(0, 400),
                        Date.now(),
                    ]
                );
                results.push({ id: notification.id, ok: false, message: error.message });
            }
            this.bus.emit('notification:sent', {
                notificationId: notification.id,
                monitorId: monitor.id,
                ok: results[results.length - 1].ok,
                elapsed: Date.now() - started,
            });
        }
        return results;
    }

    maybeCertificateAlert(monitor, cert) {
        const days = cert.daysRemaining;
        if (typeof days !== 'number' || days < 0) {
            return;
        }
        const threshold = Number(getSetting('certificateExpiryDays', '14')) || 14;
        if (days > threshold) {
            return;
        }
        const since = now() - 20 * 60 * 60 * 1000;
        const recent = get(
            "SELECT id FROM notification_log WHERE monitor_id = ? AND event = 'certificate' AND created_at > ? LIMIT 1",
            [monitor.id, since]
        );
        if (recent) {
            return;
        }
        this.notify(monitor, {
            title: `Sertifikat TLS ${monitor.name} segera kedaluwarsa`,
            message: `Sertifikat berlaku hingga ${cert.validTo || 'tidak diketahui'} (${days} hari lagi).`,
            status: 'warning',
            event: 'certificate',
            time: now(),
        }).catch((error) => this.bus.emit('error', error));
    }

    maybeDomainAlert(monitor, domain) {
        if (!domain || !domain.expiresAt) {
            return;
        }
        const days = Math.floor((domain.expiresAt - now()) / DAY);
        if (days < 0) {
            return;
        }
        const threshold = Number(getSetting('domainExpiryDays', '30')) || 30;
        if (days > threshold) {
            return;
        }
        const since = now() - 20 * 60 * 60 * 1000;
        const recent = get(
            "SELECT id FROM notification_log WHERE monitor_id = ? AND event = 'domain' AND created_at > ? LIMIT 1",
            [monitor.id, since]
        );
        if (recent) {
            return;
        }
        this.notify(monitor, {
            title: `Domain ${domain.domain} segera kedaluwarsa`,
            message: `Domain ${domain.domain} kedaluwarsa dalam ${days} hari.`,
            status: 'warning',
            event: 'domain',
            time: now(),
        }).catch((error) => this.bus.emit('error', error));
    }

    broadcastBeat(monitor, beat) {
        this.bus.emit('beat', {
            monitorId: monitor.id,
            monitorName: monitor.name,
            beat,
        });
    }

    // ---------- queries ----------

    uptime(monitorId, sinceMs) {
        const row = get(
            `SELECT
                SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS up,
                SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS down,
                SUM(CASE WHEN status IN (0, 1) THEN 1 ELSE 0 END) AS total,
                AVG(CASE WHEN status = 1 THEN ping END) AS avg_ping
             FROM heartbeat WHERE monitor_id = ? AND time >= ?`,
            [monitorId, sinceMs]
        );
        const up = Number(row?.up || 0);
        const down = Number(row?.down || 0);
        const total = Number(row?.total || 0);
        return {
            up,
            down,
            total,
            uptime: percent(up, total),
            avgPing: row?.avg_ping === null || row?.avg_ping === undefined ? null : Math.round(Number(row.avg_ping) * 10) / 10,
        };
    }

    beats(monitorId, limit = 60) {
        const rows = all(
            'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?',
            [monitorId, clamp(limit, 1, 2000, 60)]
        );
        return rows.map(shapeBeat).reverse();
    }

    chart(monitorId, hours = 24, limit = 720) {
        const since = now() - clamp(hours, 1, 24 * 365, 24) * 3600 * 1000;
        const rows = all(
            'SELECT time, status, ping FROM heartbeat WHERE monitor_id = ? AND time >= ? ORDER BY time ASC LIMIT ?',
            [monitorId, since, clamp(limit, 10, 5000, 720)]
        );
        return rows.map((row) => ({
            time: Number(row.time),
            status: Number(row.status),
            ping: row.ping === null ? null : Number(row.ping),
        }));
    }

    certInfo(monitorId) {
        const row = get(
            'SELECT cert_info, time FROM heartbeat WHERE monitor_id = ? AND cert_info IS NOT NULL ORDER BY time DESC LIMIT 1',
            [monitorId]
        );
        if (!row) {
            return null;
        }
        return { ...parseJson(row.cert_info, {}), time: Number(row.time) };
    }

    tags(monitorId) {
        return all(
            `SELECT t.id, t.name, t.color FROM tag t
             JOIN monitor_tag mt ON mt.tag_id = t.id WHERE mt.monitor_id = ? ORDER BY t.name`,
            [monitorId]
        );
    }

    notificationIds(monitorId) {
        return all('SELECT notification_id FROM monitor_notification WHERE monitor_id = ?', [monitorId]).map(
            (row) => Number(row.notification_id)
        );
    }

    computeGroupStatus(children) {
        if (!children.length) {
            return STATUS.PENDING;
        }
        const statuses = children.map((child) => child.status);
        if (statuses.includes(STATUS.DOWN)) {
            return STATUS.DOWN;
        }
        if (statuses.includes(STATUS.PENDING)) {
            return STATUS.PENDING;
        }
        if (statuses.every((status) => status === STATUS.MAINTENANCE)) {
            return STATUS.MAINTENANCE;
        }
        return STATUS.UP;
    }

    summary(monitorRow, options = {}) {
        const monitor = shapeMonitor(monitorRow);
        const limit = clamp(options.beatLimit || Number(this.settings.heartbeatBarSize || 60), 5, 200, 60);
        const last = this.lastBeat(monitor.id);
        const children = all('SELECT * FROM monitor WHERE parent_id = ? ORDER BY name', [monitor.id]);
        const childSummaries = children.map((child) => this.summary(child, { beatLimit: limit, shallow: true }));
        let status = last ? last.status : STATUS.PENDING;
        if (monitor.type === 'group') {
            status = this.computeGroupStatus(childSummaries);
        }
        const day = this.uptime(monitor.id, now() - DAY);
        const beats = monitor.type === 'group' ? childSummaries[0]?.beats || [] : this.beats(monitor.id, limit);
        const cert = this.certInfo(monitor.id);
        return {
            ...monitor,
            status,
            lastBeat: last,
            beats,
            uptime24: day.uptime,
            avgPing24: day.avgPing,
            cert: cert ? cert.cert || null : null,
            domain: cert ? cert.domain || null : null,
            dns: cert ? cert.dns || null : null,
            tags: this.tags(monitor.id),
            notificationIds: this.notificationIds(monitor.id),
            children: options.shallow ? undefined : childSummaries,
            childrenCount: childSummaries.length,
            parentName: monitor.parentId
                ? get('SELECT name FROM monitor WHERE id = ?', [monitor.parentId])?.name || null
                : null,
        };
    }

    summaries() {
        const rows = all('SELECT * FROM monitor ORDER BY type = \'group\' DESC, name');
        return rows.map((row) => this.summary(row));
    }

    stats() {
        const rows = all('SELECT * FROM monitor');
        const counts = { up: 0, down: 0, pending: 0, maintenance: 0 };
        for (const row of rows) {
            const summary = this.summary(row, { beatLimit: 1, shallow: true });
            if (summary.status === STATUS.UP) {
                counts.up += 1;
            } else if (summary.status === STATUS.DOWN) {
                counts.down += 1;
            } else if (summary.status === STATUS.MAINTENANCE) {
                counts.maintenance += 1;
            } else {
                counts.pending += 1;
            }
        }
        const dayStart = now() - DAY;
        const beatRow = get(
            'SELECT AVG(ping) AS avg_ping, COUNT(*) AS total FROM heartbeat WHERE time >= ? AND status = 1',
            [dayStart]
        );
        const stored = get('SELECT COUNT(*) AS total FROM heartbeat');
        const latest = get('SELECT MAX(time) AS last FROM heartbeat');
        return {
            total: rows.length,
            ...counts,
            avgPing: beatRow && beatRow.avg_ping ? Math.round(Number(beatRow.avg_ping) * 10) / 10 : null,
            checks24h: beatRow ? Number(beatRow.total) : 0,
            storedBeats: stored ? Number(stored.total) : 0,
            lastBeat: latest && latest.last ? Number(latest.last) : null,
        };
    }

    prune() {
        const retention = clamp(this.settings.retentionDays || 180, 1, 3650, 180) * DAY;
        run('DELETE FROM heartbeat WHERE time < ? AND important = 0', [now() - retention]);
        run('DELETE FROM heartbeat WHERE time < ?', [now() - retention * 2]);
        run('DELETE FROM notification_log WHERE created_at < ?', [now() - 90 * DAY]);
        run('DELETE FROM session WHERE expires_at < ?', [now()]);
    }

    push(monitor, { status = 'up', msg = '', ping = null } = {}) {
        const timestamp = now();
        const normalized =
            String(status).toLowerCase() === 'down' || String(status) === '0' ? STATUS.DOWN : STATUS.UP;
        const beat = this.insertBeat(monitor, {
            status: normalized,
            msg: msg || 'Heartbeat push diterima',
            ping: ping === null || ping === '' ? null : Number(ping),
            important: false,
        });
        const previous = get(
            'SELECT status FROM heartbeat WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
            [monitor.id, beat.id]
        );
        if (!previous || Number(previous.status) !== normalized) {
            beat.important = true;
            run('UPDATE heartbeat SET important = 1 WHERE id = ?', [beat.id]);
            this.handleTransition(monitor, beat, previous ? Number(previous.status) : null);
        }
        this.broadcastBeat(monitor, beat);
        return beat;
    }

    manualIncident(incident) {
        return shapeIncident(incident);
    }
}

const engine = new Engine();

module.exports = engine;
