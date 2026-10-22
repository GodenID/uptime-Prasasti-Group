/**
 * Mesin pemantauan untuk Workers.
 *
 * Semua fungsi menerima `db` (D1) dan `env` sehingga bisa dipakai dari
 * Worker maupun Durable Object.
 */

import { STATUS, now, clamp, percent, parseJson, floorToDay } from './util.js';
import { shapeBeat, shapeMonitor, shapeIncident, shapeNotification } from './models.js';
import { runCheck } from './checks.js';
import { dispatch } from './notifier.js';

const MIN_INTERVAL = 20;
const DAY = 86400000;

const resendState = new Map();

/* --------------------------------------------------------------- denyut */

async function lastBeat(db, monitorId) {
    const row = await db.one(
        'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT 1',
        [monitorId]
    );
    return row ? shapeBeat(row) : null;
}

async function recordDaily(db, monitorId, timestamp, status, ping, duration) {
    const day = floorToDay(timestamp);
    const hasPing = ping !== null && ping !== undefined && Number.isFinite(Number(ping));
    await db.run(
        `INSERT INTO heartbeat_daily (monitor_id, day, up_count, down_count, pending_count, maintenance_count,
            ping_sum, ping_count, downtime_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(monitor_id, day) DO UPDATE SET
            up_count = up_count + excluded.up_count,
            down_count = down_count + excluded.down_count,
            pending_count = pending_count + excluded.pending_count,
            maintenance_count = maintenance_count + excluded.maintenance_count,
            ping_sum = ping_sum + excluded.ping_sum,
            ping_count = ping_count + excluded.ping_count,
            downtime_ms = downtime_ms + excluded.downtime_ms`,
        [
            monitorId,
            day,
            status === STATUS.UP ? 1 : 0,
            status === STATUS.DOWN ? 1 : 0,
            status === STATUS.PENDING ? 1 : 0,
            status === STATUS.MAINTENANCE ? 1 : 0,
            hasPing ? Number(ping) : 0,
            hasPing ? 1 : 0,
            status === STATUS.DOWN ? duration : 0,
        ]
    );
}

async function insertBeat(db, monitor, { status, msg, ping, important, certInfo }) {
    const timestamp = now();
    const previous = await lastBeat(db, monitor.id);
    const duration = previous ? Math.max(0, timestamp - previous.time) : 0;
    const info = await db.run(
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
    await recordDaily(db, monitor.id, timestamp, status, ping, duration);
    return {
        id: Number(info.meta.last_row_id),
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

/* -------------------------------------------------------------- uptime */

export async function uptimeRange(db, monitorId, from, to) {
    const start = Math.max(0, Number(from) || 0);
    const end = Math.max(start, Number(to) || start);
    const startDay = floorToDay(start);
    const endDay = floorToDay(end);
    const firstFullDay = start === startDay ? startDay : startDay + DAY;
    const rawEnd = Math.min(firstFullDay, endDay);

    let up = 0;
    let down = 0;
    let pingSum = 0;
    let pingCount = 0;
    let downtime = 0;

    const addRaw = async (fromTs, toTs) => {
        if (toTs <= fromTs) {
            return;
        }
        const row = await db.one(
            `SELECT SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS up,
                    SUM(CASE WHEN status = 0 THEN 1 ELSE 0 END) AS down,
                    SUM(CASE WHEN status = 1 AND ping IS NOT NULL THEN ping ELSE 0 END) AS ping_sum,
                    SUM(CASE WHEN status = 1 AND ping IS NOT NULL THEN 1 ELSE 0 END) AS ping_count,
                    SUM(CASE WHEN status = 0 THEN duration ELSE 0 END) AS downtime
             FROM heartbeat WHERE monitor_id = ? AND time >= ? AND time < ?`,
            [monitorId, fromTs, toTs]
        );
        up += Number(row?.up || 0);
        down += Number(row?.down || 0);
        pingSum += Number(row?.ping_sum || 0);
        pingCount += Number(row?.ping_count || 0);
        downtime += Number(row?.downtime || 0);
    };

    await addRaw(start, rawEnd);

    if (firstFullDay < endDay) {
        const daily = await db.one(
            `SELECT SUM(up_count) AS up, SUM(down_count) AS down,
                    SUM(ping_sum) AS ping_sum, SUM(ping_count) AS ping_count,
                    SUM(downtime_ms) AS downtime
             FROM heartbeat_daily WHERE monitor_id = ? AND day >= ? AND day < ?`,
            [monitorId, firstFullDay, endDay]
        );
        up += Number(daily?.up || 0);
        down += Number(daily?.down || 0);
        pingSum += Number(daily?.ping_sum || 0);
        pingCount += Number(daily?.ping_count || 0);
        downtime += Number(daily?.downtime || 0);
    }

    await addRaw(Math.max(start, endDay), end);

    const total = up + down;
    return {
        up,
        down,
        total,
        uptime: percent(up, total),
        avgPing: pingCount ? Math.round((pingSum / pingCount) * 10) / 10 : null,
        downtime,
    };
}

export async function uptimeOf(db, monitorId, sinceMs) {
    return uptimeRange(db, monitorId, sinceMs, now());
}

/* ------------------------------------------------------------ ringkasan */

export async function beatsOf(db, monitorId, limit = 60) {
    const rows = await db.all(
        'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC, id DESC LIMIT ?',
        [monitorId, clamp(limit, 1, 2000, 60)]
    );
    return rows.map(shapeBeat).reverse();
}

export async function chartOf(db, monitorId, hours = 24, limit = 720) {
    const since = now() - clamp(hours, 1, 24 * 365, 24) * 3600 * 1000;
    const rows = await db.all(
        'SELECT time, status, ping FROM heartbeat WHERE monitor_id = ? AND time >= ? ORDER BY time ASC LIMIT ?',
        [monitorId, since, clamp(limit, 10, 5000, 720)]
    );
    return rows.map((row) => ({
        time: Number(row.time),
        status: Number(row.status),
        ping: row.ping === null ? null : Number(row.ping),
    }));
}

export async function certInfoOf(db, monitorId) {
    const row = await db.one(
        'SELECT cert_info, time FROM heartbeat WHERE monitor_id = ? AND cert_info IS NOT NULL ORDER BY time DESC LIMIT 1',
        [monitorId]
    );
    if (!row) {
        return null;
    }
    return { ...parseJson(row.cert_info, {}), time: Number(row.time) };
}

export function computeGroupStatus(children) {
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

export async function summaryOf(db, monitorRow, options = {}) {
    const monitor = shapeMonitor(monitorRow);
    const limit = clamp(options.beatLimit || 60, 5, 200, 60);
    const last = await lastBeat(db, monitor.id);
    const children = await db.all('SELECT * FROM monitor WHERE parent_id = ? ORDER BY name', [monitor.id]);
    const childSummaries = [];
    for (const child of children) {
        childSummaries.push(await summaryOf(db, child, { beatLimit: limit, shallow: true }));
    }
    let status = last ? last.status : STATUS.PENDING;
    if (monitor.type === 'group') {
        status = computeGroupStatus(childSummaries);
    }
    const day = await uptimeOf(db, monitor.id, now() - DAY);
    const ownBeats = await beatsOf(db, monitor.id, limit);
    const beats =
        ownBeats.length || monitor.type !== 'group' ? ownBeats : childSummaries[0]?.beats || [];
    const cert = await certInfoOf(db, monitor.id);
    const tags = await db.all(
        `SELECT t.id, t.name, t.color FROM tag t
         JOIN monitor_tag mt ON mt.tag_id = t.id WHERE mt.monitor_id = ? ORDER BY t.name`,
        [monitor.id]
    );
    const notificationRows = await db.all(
        'SELECT notification_id FROM monitor_notification WHERE monitor_id = ?',
        [monitor.id]
    );
    const parent = monitor.parentId
        ? await db.one('SELECT name FROM monitor WHERE id = ?', [monitor.parentId])
        : null;
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
        tags,
        notificationIds: notificationRows.map((row) => Number(row.notification_id)),
        children: options.shallow ? undefined : childSummaries,
        childrenCount: childSummaries.length,
        parentName: parent?.name || null,
    };
}

export async function summariesOf(db) {
    const rows = await db.all("SELECT * FROM monitor ORDER BY type = 'group' DESC, name");
    const result = [];
    for (const row of rows) {
        result.push(await summaryOf(db, row));
    }
    return result;
}

export async function statsOf(db) {
    const rows = await db.all('SELECT * FROM monitor');
    const counts = { up: 0, down: 0, pending: 0, maintenance: 0 };
    for (const row of rows) {
        const summary = await summaryOf(db, row, { beatLimit: 1, shallow: true });
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
    const beatRow = await db.one(
        'SELECT AVG(ping) AS avg_ping, COUNT(*) AS total FROM heartbeat WHERE time >= ? AND status = 1',
        [dayStart]
    );
    const stored = await db.one('SELECT COUNT(*) AS total FROM heartbeat');
    const latest = await db.one('SELECT MAX(time) AS last FROM heartbeat');
    return {
        total: rows.length,
        ...counts,
        avgPing: beatRow?.avg_ping ? Math.round(Number(beatRow.avg_ping) * 10) / 10 : null,
        checks24h: beatRow ? Number(beatRow.total) : 0,
        storedBeats: stored ? Number(stored.total) : 0,
        lastBeat: latest?.last ? Number(latest.last) : null,
    };
}

/* --------------------------------------------------------- notifikasi */

export async function recipientsOf(db, monitorId) {
    const explicit = await db.all(
        `SELECT n.* FROM notification n
         JOIN monitor_notification mn ON mn.notification_id = n.id
         WHERE mn.monitor_id = ? AND n.active = 1`,
        [monitorId]
    );
    const defaults = await db.all('SELECT * FROM notification WHERE active = 1 AND is_default = 1');
    const seen = new Set();
    const merged = [];
    for (const row of [...explicit, ...defaults]) {
        if (seen.has(row.id)) {
            continue;
        }
        seen.add(row.id);
        merged.push(row);
    }
    return merged.map((row) => shapeNotification(row));
}

export function wantsEvent(notification, event) {
    const events = notification.events || [];
    if (!events.length) {
        return true;
    }
    return events.includes(event);
}

export async function notify(db, env, monitor, payload) {
    const event = payload.event || 'status';
    const recipients = (await recipientsOf(db, monitor.id)).filter((item) => wantsEvent(item, event));
    if (!recipients.length) {
        return [];
    }
    const results = [];
    for (const notification of recipients) {
        if (event === 'down') {
            resendState.set(`${monitor.id}:${notification.id}`, now());
        }
        try {
            const message = await dispatch(notification, {
                ...payload,
                monitor,
                monitorUrl: monitor.url || '',
            });
            await db.run(
                'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, ?, ?, 1, ?, ?)',
                [notification.id, monitor.id, event, message || 'OK', now()]
            );
            results.push({ id: notification.id, ok: true, message });
        } catch (error) {
            await db.run(
                'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, ?, ?, 0, ?, ?)',
                [notification.id, monitor.id, event, String(error.message).slice(0, 400), now()]
            );
            results.push({ id: notification.id, ok: false, message: error.message });
        }
    }
    return results;
}

async function maybeResend(db, env, monitor, beat) {
    const recipients = await recipientsOf(db, monitor.id);
    const timestamp = now();
    for (const notification of recipients) {
        const interval = Number(notification.resendInterval || 0);
        if (!interval || !wantsEvent(notification, 'down')) {
            continue;
        }
        const key = `${monitor.id}:${notification.id}`;
        const last = resendState.get(key) || 0;
        if (timestamp - last < interval * 60000) {
            continue;
        }
        resendState.set(key, timestamp);
        await notify(db, env, monitor, {
            title: `${monitor.name} masih mengalami gangguan`,
            message: beat.msg,
            status: 'down',
            event: 'down',
            time: beat.time,
            resend: true,
        }).catch(() => {});
    }
}

/* ------------------------------------------------------------- insiden */

async function statusPagesForMonitor(db, monitorId) {
    return db.all(
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

async function openIncidents(db, monitor, beat) {
    const timestamp = now();
    const pages = await statusPagesForMonitor(db, monitor.id);
    const targets = pages.length ? pages : [{ id: null }];
    for (const page of targets) {
        const existing = await db.one(
            `SELECT id FROM incident WHERE monitor_id = ? AND resolved_at IS NULL
             AND (status_page_id IS ? OR status_page_id = ?) LIMIT 1`,
            [monitor.id, page.id, page.id]
        );
        if (existing) {
            continue;
        }
        await db.run(
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
    }
}

async function resolveIncidents(db, monitor) {
    const timestamp = now();
    const open = await db.all(
        'SELECT id FROM incident WHERE monitor_id = ? AND resolved_at IS NULL',
        [monitor.id]
    );
    if (!open.length) {
        return;
    }
    await db.run('UPDATE incident SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL', [
        timestamp,
        monitor.id,
    ]);
}

async function handleTransition(db, env, monitor, beat, previousStatus) {
    if (beat.status === STATUS.DOWN) {
        await openIncidents(db, monitor, beat);
    } else if (beat.status === STATUS.UP && previousStatus === STATUS.DOWN) {
        await resolveIncidents(db, monitor);
    }
    const event = beat.status === STATUS.DOWN ? 'down' : beat.status === STATUS.UP ? 'up' : 'status';
    await notify(db, env, monitor, {
        title:
            beat.status === STATUS.DOWN
                ? `${monitor.name} mengalami gangguan`
                : `${monitor.name} kembali operasional`,
        message: beat.msg,
        status: beat.status === STATUS.DOWN ? 'down' : beat.status === STATUS.UP ? 'up' : 'warning',
        event,
        time: beat.time,
    }).catch(() => {});
}

/* --------------------------------------------------------------- grup */

export async function updateGroupAncestors(db, monitor) {
    let parentId = monitor.parent_id ?? monitor.parentId ?? null;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = await db.one('SELECT * FROM monitor WHERE id = ?', [parentId]);
        if (!parent) {
            break;
        }
        const children = await db.all('SELECT id, interval FROM monitor WHERE parent_id = ?', [parentId]);
        const statuses = [];
        for (const child of children) {
            const beat = await lastBeat(db, child.id);
            statuses.push(beat ? beat.status : STATUS.PENDING);
        }
        const status = computeGroupStatus(statuses);
        const previous = await lastBeat(db, parentId);
        const interval = children.length
            ? Math.max(MIN_INTERVAL, Math.min(...children.map((child) => Number(child.interval) || 60)))
            : MIN_INTERVAL;
        const due =
            !previous || previous.status !== status || now() - previous.time >= interval * 1000;
        if (due) {
            const healthy = statuses.filter((item) => item === STATUS.UP).length;
            await insertBeat(db, parent, {
                status,
                msg: `${healthy} dari ${children.length} monitor anak sehat`,
                ping: null,
                important: Boolean(previous && previous.status !== status),
            });
        }
        parentId = parent.parent_id;
    }
}

async function maybeDomainAlert(db, env, monitor, domain) {
    if (!domain || !domain.expiresAt) {
        return;
    }
    const days = Math.floor((Number(domain.expiresAt) - now()) / DAY);
    if (!Number.isFinite(days) || days < 0) {
        return;
    }
    const settings = await db.settings();
    const threshold = Number(settings.domainExpiryDays || 30) || 30;
    if (days > threshold) {
        return;
    }
    const since = now() - 20 * 60 * 60 * 1000;
    const recent = await db.one(
        "SELECT id FROM notification_log WHERE monitor_id = ? AND event = 'domain' AND created_at > ? LIMIT 1",
        [monitor.id, since]
    );
    if (recent) {
        return;
    }
    await notify(db, env, monitor, {
        title: `Domain ${domain.domain || monitor.name} segera kedaluwarsa`,
        message: `Domain ${domain.domain || monitor.name} kedaluwarsa dalam ${days} hari.`,
        status: 'warning',
        event: 'domain',
        time: now(),
    });
}

/* ------------------------------------------------------------- pemeriksaan */

export async function performCheck(db, env, monitorRow, options = {}) {
    const monitor = shapeMonitor(monitorRow);
    const previous = await lastBeat(db, monitor.id);
    const previousStatus = previous ? previous.status : null;

    if (!options.manual) {
        const maintenance = await db.one(
            `SELECT m.* FROM maintenance m
             JOIN maintenance_monitor mm ON mm.maintenance_id = m.id
             WHERE mm.monitor_id = ? AND m.active = 1 AND m.start_at <= ? AND m.end_at >= ?
             ORDER BY m.start_at DESC LIMIT 1`,
            [monitor.id, now(), now()]
        );
        if (maintenance) {
            const beat = await insertBeat(db, monitor, {
                status: STATUS.MAINTENANCE,
                msg: `Pemeliharaan: ${maintenance.title}`,
                ping: null,
                important: false,
            });
            return beat;
        }
    }

    const result = options.pushResult || (await runCheck(monitor));
    let status = result.status;
    let message = result.msg || '';
    let important = false;
    let retry = false;

    const maxRetries = options.manual ? 0 : Math.max(0, Number(monitor.retries) || 0);
    const attempts = Math.max(0, Number(options.attempts) || 0);
    if (status === STATUS.DOWN && maxRetries > 0 && attempts < maxRetries && previousStatus !== STATUS.DOWN) {
        status = STATUS.PENDING;
        message = `Percobaan ${attempts + 1}/${maxRetries}: ${message}`;
        retry = true;
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

    const beat = await insertBeat(db, monitor, {
        status,
        msg: message,
        ping: result.ping ?? null,
        important,
        certInfo: Object.keys(certInfo).length ? certInfo : null,
    });

    if (important) {
        await handleTransition(db, env, monitor, beat, previousStatus);
        if (beat.status === STATUS.UP) {
            for (const key of [...resendState.keys()]) {
                if (key.startsWith(`${monitor.id}:`)) {
                    resendState.delete(key);
                }
            }
        }
    } else if (status === STATUS.DOWN && previousStatus === STATUS.DOWN) {
        await maybeResend(db, env, monitor, beat);
    }

    if (result.domain && monitor.domainExpiryNotification) {
        try {
            await maybeDomainAlert(db, env, monitor, result.domain);
        } catch (error) {
            console.error('[domain-expiry]', error);
        }
    }

    await updateGroupAncestors(db, monitorRow);
    beat.retry = retry;
    return beat;
}

export async function pushBeat(db, env, monitorRow, { status = 'up', msg = '', ping = null } = {}) {
    const monitor = shapeMonitor(monitorRow);
    const timestamp = now();
    const normalized =
        String(status).toLowerCase() === 'down' || String(status) === '0' ? STATUS.DOWN : STATUS.UP;
    const beat = await insertBeat(db, monitor, {
        status: normalized,
        msg: msg || 'Heartbeat push diterima',
        ping: ping === null || ping === '' ? null : Number(ping),
        important: false,
    });
    const previous = await db.one(
        'SELECT status FROM heartbeat WHERE monitor_id = ? AND id < ? ORDER BY id DESC LIMIT 1',
        [monitor.id, beat.id]
    );
    if (!previous || Number(previous.status) !== normalized) {
        beat.important = true;
        await db.run('UPDATE heartbeat SET important = 1 WHERE id = ?', [beat.id]);
        await handleTransition(db, env, monitor, beat, previous ? Number(previous.status) : null);
    }
    await updateGroupAncestors(db, monitorRow);
    return beat;
}

export async function prune(db, settings) {
    const retention = clamp(settings.retentionDays || 180, 1, 3650, 180) * DAY;
    await db.run('DELETE FROM heartbeat WHERE time < ? AND important = 0', [now() - retention]);
    await db.run('DELETE FROM heartbeat WHERE time < ?', [now() - retention * 2]);
    await db.run('DELETE FROM heartbeat_daily WHERE day < ?', [now() - retention * 2]);
    await db.run('DELETE FROM notification_log WHERE created_at < ?', [now() - 90 * DAY]);
    await db.run('DELETE FROM session WHERE expires_at < ?', [now()]);
}
