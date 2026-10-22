/**
 * REST API untuk Worker.
 *
 * Menggantikan server/api.js: basis data D1 (async), autentikasi sesi atau
 * kunci API, dan penjadwalan lewat Durable Object.
 */

import {
    MONITOR_TYPES,
    NOTIFICATION_TYPES,
    NOTIFICATION_EVENTS,
    now,
    clamp,
    bool,
    parseJson,
    normalizeUrl,
    uid,
    randomToken,
    escapeHtml,
    percent,
    STATUS,
} from './util.js';
import { shapeMonitor, shapeNotification, shapeStatusPage, shapeIncident, shapeMaintenance, shapeBeat } from './models.js';
import {
    hashPassword,
    verifyPassword,
    createSession,
    getSessionUser,
    destroySession,
    destroyOtherSessions,
    sessionCookie,
    clearCookie,
    countUsers,
    getUserByName,
    isThrottled,
    recordFailure,
    clearFailures,
    parseCookies,
    createApiKey,
    findApiKey,
    touchApiKey,
    listApiKeys,
    revokeApiKey,
} from './auth.js';
import { Db } from './db.js';
import { dispatch } from './notifier.js';
import { statusPagePayload, getPageByDomain } from './statuspage.js';
import {
    summaryOf,
    summariesOf,
    statsOf,
    uptimeOf,
    beatsOf,
    chartOf,
    pushBeat,
} from './engine.js';

const TYPES = new Set(MONITOR_TYPES);
const NOTIFICATION_SET = new Set(NOTIFICATION_TYPES);
const DEFAULT_PORTS = { redis: 6379, mqtt: 1883, postgres: 5432 };

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function json(payload, status = 200, headers = {}) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers,
        },
    });
}

function text(body, status = 200, type = 'text/plain; charset=utf-8') {
    return new Response(body, { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

function fail(status, message) {
    return json({ error: message }, status);
}

function clientIp(request) {
    const direct = request.headers.get('cf-connecting-ip');
    if (direct) {
        return String(direct).trim().slice(0, 64);
    }
    const forwarded = request.headers.get('x-forwarded-for') || '';
    return String(forwarded).split(',')[0].trim().slice(0, 64);
}

function sameOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin) {
        return true;
    }
    try {
        return new URL(origin).host === request.headers.get('host');
    } catch {
        return false;
    }
}

async function readBody(request) {
    try {
        const text = await request.text();
        if (!text) {
            return {};
        }
        return JSON.parse(text);
    } catch {
        throw new ApiError(400, 'Body harus JSON yang valid');
    }
}

async function currentUser(request, db) {
    const cookies = parseCookies(request.headers.get('cookie'));
    return getSessionUser(db, cookies.prasasti_sid);
}

async function requireUser(request, db) {
    const header = request.headers.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) {
        const token = header.slice(7).trim();
        const key = await findApiKey(db, token);
        if (!key) {
            throw new ApiError(401, 'Kunci API tidak dikenal atau sudah kedaluwarsa');
        }
        await touchApiKey(db, key.id);
        return {
            id: Number(key.user_id),
            username: `api:${key.prefix}`,
            scope: key.scope,
            viaApiKey: true,
        };
    }
    const user = await currentUser(request, db);
    if (!user) {
        throw new ApiError(401, 'Silakan masuk terlebih dahulu');
    }
    return user;
}

/* ------------------------------------------------------------- monitor */

function validateOptions(type, source) {
    const raw = source.options && typeof source.options === 'object' ? source.options : parseJson(source.options, {});
    const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const clean = {};
    if (type === 'redis') {
        clean.password = String(options.password || '').slice(0, 200);
        clean.db = Math.round(clamp(options.db, 0, 1024, 0));
        clean.command = String(options.command || 'PING').trim().slice(0, 200) || 'PING';
        clean.expected = String(options.expected || '').slice(0, 200);
    }
    if (type === 'mqtt') {
        clean.topic = String(options.topic || '').trim().slice(0, 200);
        if (!clean.topic) {
            throw new ApiError(400, 'Topik MQTT wajib diisi');
        }
        clean.username = String(options.username || '').slice(0, 200);
        clean.password = String(options.password || '').slice(0, 200);
        clean.clientId = String(options.clientId || '').slice(0, 100);
        clean.expected = String(options.expected || '').slice(0, 200);
    }
    if (type === 'docker') {
        clean.container = String(options.container || '').trim().slice(0, 200);
        if (!clean.container) {
            throw new ApiError(400, 'Nama container wajib diisi');
        }
        clean.socket = String(options.socket || '').slice(0, 300);
    }
    if (type === 'postgres') {
        clean.user = String(options.user || 'postgres').trim().slice(0, 100) || 'postgres';
        clean.password = String(options.password || '').slice(0, 200);
        clean.database = String(options.database || '').trim().slice(0, 100);
        clean.query = String(options.query || 'SELECT 1').trim().slice(0, 500) || 'SELECT 1';
    }
    return clean;
}

function validateMonitorInput(body, existing = null) {
    const source = { ...(existing ? shapeMonitor(existing) : {}), ...body };
    const type = String(source.type || '').toLowerCase();
    if (!TYPES.has(type)) {
        throw new ApiError(400, 'Tipe monitor tidak dikenal');
    }
    const name = String(source.name || '').trim();
    if (!name || name.length > 150) {
        throw new ApiError(400, 'Nama monitor wajib diisi (maksimal 150 karakter)');
    }
    const interval = clamp(source.interval, 20, 86400, 60);
    const retries = clamp(source.retries, 0, 20, 0);
    const retryInterval = clamp(source.retryInterval, 5, 3600, 60);
    const timeout = clamp(source.timeout, 1, 120, 15);

    let url = String(source.url || '').trim();
    let hostname = String(source.hostname || '').trim();
    let port =
        source.port === '' || source.port === null || source.port === undefined ? null : Number(source.port);

    if (['http', 'keyword', 'json'].includes(type)) {
        url = normalizeUrl(url);
        if (!url) {
            throw new ApiError(400, 'URL tidak valid. Contoh: https://contoh.id');
        }
        hostname = new URL(url).host;
    } else if (['tcp', 'ping', 'dns'].includes(type)) {
        if (!hostname) {
            throw new ApiError(400, 'Hostname wajib diisi');
        }
        if (/^https?:\/\//i.test(hostname)) {
            hostname = new URL(hostname).hostname;
        }
        if (type === 'tcp') {
            if (!port || port < 1 || port > 65535) {
                throw new ApiError(400, 'Port wajib diisi (1-65535)');
            }
        } else {
            port = null;
        }
        url = '';
    } else if (['redis', 'mqtt', 'postgres'].includes(type)) {
        if (!hostname) {
            throw new ApiError(400, 'Hostname wajib diisi');
        }
        if (/^https?:\/\//i.test(hostname)) {
            hostname = new URL(hostname).hostname;
        }
        port = port ? Number(port) : DEFAULT_PORTS[type];
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
            throw new ApiError(400, 'Port wajib diisi (1-65535)');
        }
        url = '';
    } else if (type === 'docker') {
        hostname = hostname ? String(hostname).trim() : '';
        port = null;
        url = '';
    } else {
        url = '';
        hostname = '';
        port = null;
    }

    let headers = source.headers;
    if (typeof headers !== 'string') {
        headers = headers && typeof headers === 'object' ? JSON.stringify(headers, null, 2) : '';
    }
    if (headers.trim()) {
        const parsed = parseJson(headers, null);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ApiError(400, 'Header harus berupa objek JSON');
        }
        headers = JSON.stringify(parsed, null, 2);
    }

    let parentId =
        source.parentId === '' || source.parentId === null || source.parentId === undefined
            ? null
            : Number(source.parentId);

    let dnsRecordType = String(source.dnsRecordType || 'A').toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(dnsRecordType)) {
        dnsRecordType = 'A';
    }

    return {
        name,
        type,
        url,
        hostname,
        port,
        method: String(source.method || 'GET').toUpperCase().slice(0, 10),
        headers,
        body: String(source.body || ''),
        interval: Math.round(interval),
        retries: Math.round(retries),
        retry_interval: Math.round(retryInterval),
        timeout,
        upside_down: bool(source.upsideDown) ? 1 : 0,
        keyword: String(source.keyword || ''),
        json_path: String(source.jsonPath || ''),
        expected_value:
            source.expectedValue === null || source.expectedValue === undefined
                ? ''
                : String(source.expectedValue),
        accepted_codes: String(source.acceptedCodes || ''),
        max_redirects: Math.round(clamp(source.maxRedirects, 0, 20, 10)),
        ignore_tls: bool(source.ignoreTls) ? 1 : 0,
        cert_expiry_notification: bool(source.certExpiryNotification, true) ? 1 : 0,
        domain_expiry_notification: bool(source.domainExpiryNotification) ? 1 : 0,
        dns_record_type: dnsRecordType,
        dns_resolver: String(source.dnsResolver || ''),
        options: JSON.stringify(validateOptions(type, source)),
        parent_id: parentId,
        description: String(source.description || '').slice(0, 1000),
        active: bool(source.active, true) ? 1 : 0,
    };
}

async function saveMonitor(db, env, body, id = null) {
    const existing = id ? await db.one('SELECT * FROM monitor WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Monitor tidak ditemukan');
    }
    const values = validateMonitorInput(body, existing);

    if (values.parent_id !== null) {
        const parent = await db.one('SELECT * FROM monitor WHERE id = ?', [values.parent_id]);
        if (!parent || parent.type !== 'group') {
            throw new ApiError(400, 'Grup induk tidak valid');
        }
        if (existing && values.parent_id === existing.id) {
            throw new ApiError(400, 'Monitor tidak boleh menjadi induk dirinya sendiri');
        }
        if (values.type === 'group' && existing && values.parent_id) {
            let cursor = parent;
            const seen = new Set([existing.id]);
            while (cursor) {
                if (seen.has(cursor.id)) {
                    throw new ApiError(400, 'Siklus grup terdeteksi');
                }
                seen.add(cursor.id);
                cursor = cursor.parent_id
                    ? await db.one('SELECT * FROM monitor WHERE id = ?', [cursor.parent_id])
                    : null;
            }
        }
    }

    const timestamp = now();
    let monitorId = id;

    if (id) {
        await db.run(
            `UPDATE monitor SET name=?, type=?, url=?, hostname=?, port=?, method=?, headers=?, body=?,
             interval=?, retries=?, retry_interval=?, timeout=?, upside_down=?, keyword=?, json_path=?,
             expected_value=?, accepted_codes=?, max_redirects=?, ignore_tls=?, cert_expiry_notification=?,
             domain_expiry_notification=?, dns_record_type=?, dns_resolver=?, options=?, parent_id=?,
             description=?, active=?, updated_at=? WHERE id=?`,
            [
                values.name, values.type, values.url, values.hostname, values.port, values.method,
                values.headers, values.body, values.interval, values.retries, values.retry_interval,
                values.timeout, values.upside_down, values.keyword, values.json_path, values.expected_value,
                values.accepted_codes, values.max_redirects, values.ignore_tls,
                values.cert_expiry_notification, values.domain_expiry_notification, values.dns_record_type,
                values.dns_resolver, values.options, values.parent_id, values.description, values.active,
                timestamp, id,
            ]
        );
    } else {
        const pushToken = values.type === 'push' ? randomToken(12) : null;
        const info = await db.run(
            `INSERT INTO monitor (name, type, url, hostname, port, method, headers, body, interval, retries,
             retry_interval, timeout, upside_down, keyword, json_path, expected_value, accepted_codes,
             max_redirects, ignore_tls, cert_expiry_notification, domain_expiry_notification, dns_record_type,
             dns_resolver, options, parent_id, description, active, push_token, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                values.name, values.type, values.url, values.hostname, values.port, values.method,
                values.headers, values.body, values.interval, values.retries, values.retry_interval,
                values.timeout, values.upside_down, values.keyword, values.json_path, values.expected_value,
                values.accepted_codes, values.max_redirects, values.ignore_tls,
                values.cert_expiry_notification, values.domain_expiry_notification, values.dns_record_type,
                values.dns_resolver, values.options, values.parent_id, values.description, values.active,
                pushToken, timestamp, timestamp,
            ]
        );
        monitorId = Number(info.meta.last_row_id);
    }

    const statements = [];
    if (Array.isArray(body.tags)) {
        statements.push(db.prepare('DELETE FROM monitor_tag WHERE monitor_id = ?').bind(monitorId));
        for (const tagId of body.tags.slice(0, 30)) {
            const tag = await db.one('SELECT id FROM tag WHERE id = ?', [Number(tagId)]);
            if (tag) {
                statements.push(
                    db
                        .prepare('INSERT OR IGNORE INTO monitor_tag (monitor_id, tag_id) VALUES (?, ?)')
                        .bind(monitorId, Number(tagId))
                );
            }
        }
    }
    if (Array.isArray(body.notificationIds)) {
        statements.push(db.prepare('DELETE FROM monitor_notification WHERE monitor_id = ?').bind(monitorId));
        for (const notificationId of body.notificationIds.slice(0, 50)) {
            const notification = await db.one('SELECT id FROM notification WHERE id = ?', [
                Number(notificationId),
            ]);
            if (notification) {
                statements.push(
                    db
                        .prepare(
                            'INSERT OR IGNORE INTO monitor_notification (monitor_id, notification_id) VALUES (?, ?)'
                        )
                        .bind(monitorId, Number(notificationId))
                );
            }
        }
    }
    if (statements.length) {
        await db.batch(statements);
    }

    await scheduleMonitor(env, monitorId);
    return shapeMonitor(await db.one('SELECT * FROM monitor WHERE id = ?', [monitorId]));
}

/* ---------------------------------------------------------- notifikasi */

function validateNotification(body, existing = null) {
    const source = { ...(existing ? shapeNotification(existing) : {}), ...body };
    const name = String(source.name || '').trim();
    if (!name) {
        throw new ApiError(400, 'Nama notifikasi wajib diisi');
    }
    const type = String(source.type || '').toLowerCase();
    if (!NOTIFICATION_SET.has(type)) {
        throw new ApiError(400, 'Tipe notifikasi tidak dikenal');
    }
    const config = source.config && typeof source.config === 'object' ? source.config : parseJson(source.config, {});
    const rawEvents = Array.isArray(source.events)
        ? source.events
        : String(source.events || '')
              .split(',')
              .map((value) => value.trim());
    const events = rawEvents
        .map((value) => String(value).trim())
        .filter((value) => NOTIFICATION_EVENTS.includes(value));
    return {
        name,
        type,
        config: JSON.stringify(config || {}),
        active: bool(source.active, true) ? 1 : 0,
        is_default: bool(source.isDefault) ? 1 : 0,
        events: events.join(','),
        resend_interval: Number(clamp(source.resendInterval, 0, 1440, 0).toFixed(2)),
    };
}

async function saveNotification(db, body, id = null) {
    const existing = id ? await db.one('SELECT * FROM notification WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Notifikasi tidak ditemukan');
    }
    const values = validateNotification(body, existing);
    if (id) {
        await db.run(
            'UPDATE notification SET name=?, type=?, config=?, active=?, is_default=?, events=?, resend_interval=? WHERE id=?',
            [
                values.name, values.type, values.config, values.active, values.is_default, values.events,
                values.resend_interval, id,
            ]
        );
    } else {
        const info = await db.run(
            'INSERT INTO notification (name, type, config, active, is_default, events, resend_interval, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [
                values.name, values.type, values.config, values.active, values.is_default, values.events,
                values.resend_interval, now(),
            ]
        );
        id = Number(info.meta.last_row_id);
    }
    return shapeNotification(await db.one('SELECT * FROM notification WHERE id = ?', [id]));
}

/* ---------------------------------------------------------- status page */

async function syncStatusPageAssignments(db, pageId, body) {
    const statements = [];
    if (Array.isArray(body.monitors)) {
        statements.push(db.prepare('DELETE FROM status_page_monitor WHERE status_page_id = ?').bind(pageId));
        for (const [index, monitorId] of body.monitors.slice(0, 200).entries()) {
            const monitor = await db.one('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)]);
            if (monitor) {
                statements.push(
                    db
                        .prepare(
                            'INSERT OR IGNORE INTO status_page_monitor (status_page_id, monitor_id, weight) VALUES (?, ?, ?)'
                        )
                        .bind(pageId, Number(monitorId), index)
                );
            }
        }
    }
    if (Array.isArray(body.groups)) {
        const existingGroups = await db.all('SELECT id FROM status_page_group WHERE status_page_id = ?', [
            pageId,
        ]);
        for (const group of existingGroups) {
            statements.push(
                db.prepare('DELETE FROM status_page_group_monitor WHERE group_id = ?').bind(group.id)
            );
        }
        statements.push(db.prepare('DELETE FROM status_page_group WHERE status_page_id = ?').bind(pageId));
        for (const [index, group] of body.groups.slice(0, 40).entries()) {
            const name = String(group.name || '').trim();
            if (!name) {
                continue;
            }
            statements.push(
                db
                    .prepare(
                        'INSERT INTO status_page_group (status_page_id, name, weight) VALUES (?, ?, ?)'
                    )
                    .bind(pageId, name.slice(0, 100), index)
            );
        }
        if (statements.length) {
            await db.batch(statements);
        }
        const createdGroups = await db.all(
            'SELECT id FROM status_page_group WHERE status_page_id = ? ORDER BY id',
            [pageId]
        );
        const groupStatements = [];
        for (const [index, group] of body.groups.slice(0, 40).entries()) {
            const name = String(group.name || '').trim();
            if (!name || !createdGroups[index]) {
                continue;
            }
            const groupId = createdGroups[index].id;
            for (const [monitorIndex, monitorId] of (group.monitors || []).slice(0, 200).entries()) {
                const monitor = await db.one('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)]);
                if (monitor) {
                    groupStatements.push(
                        db
                            .prepare(
                                'INSERT OR IGNORE INTO status_page_group_monitor (group_id, monitor_id, weight) VALUES (?, ?, ?)'
                            )
                            .bind(groupId, Number(monitorId), monitorIndex)
                    );
                }
            }
        }
        if (groupStatements.length) {
            await db.batch(groupStatements);
        }
        return;
    }
    if (statements.length) {
        await db.batch(statements);
    }
    if (Array.isArray(body.maintenanceIds)) {
        const list = [];
        list.push(
            db.prepare('DELETE FROM maintenance_status_page WHERE status_page_id = ?').bind(pageId)
        );
        for (const maintenanceId of body.maintenanceIds) {
            const maintenance = await db.one('SELECT id FROM maintenance WHERE id = ?', [
                Number(maintenanceId),
            ]);
            if (maintenance) {
                list.push(
                    db
                        .prepare(
                            'INSERT OR IGNORE INTO maintenance_status_page (maintenance_id, status_page_id) VALUES (?, ?)'
                        )
                        .bind(Number(maintenanceId), pageId)
                );
            }
        }
        await db.batch(list);
    }
}

async function adminStatusPage(db, pageId) {
    const row = await db.one('SELECT * FROM status_page WHERE id = ?', [pageId]);
    if (!row) {
        return null;
    }
    const page = shapeStatusPage(row);
    const monitors = await db.all(
        'SELECT monitor_id, weight FROM status_page_monitor WHERE status_page_id = ? ORDER BY weight',
        [pageId]
    );
    const groups = await db.all(
        'SELECT * FROM status_page_group WHERE status_page_id = ? ORDER BY weight, id',
        [pageId]
    );
    const groupPayload = [];
    for (const group of groups) {
        const members = await db.all(
            'SELECT monitor_id FROM status_page_group_monitor WHERE group_id = ? ORDER BY weight',
            [group.id]
        );
        groupPayload.push({
            id: group.id,
            name: group.name,
            monitors: members.map((item) => Number(item.monitor_id)),
        });
    }
    const maintenanceIds = await db.all(
        'SELECT maintenance_id FROM maintenance_status_page WHERE status_page_id = ?',
        [pageId]
    );
    return {
        ...page,
        monitors: monitors.map((item) => ({ monitorId: Number(item.monitor_id), weight: Number(item.weight) })),
        groups: groupPayload,
        maintenanceIds: maintenanceIds.map((row) => Number(row.maintenance_id)),
    };
}

async function saveStatusPage(db, body, id = null) {
    const existing = id ? await db.one('SELECT * FROM status_page WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Status page tidak ditemukan');
    }
    const source = { ...(existing ? shapeStatusPage(existing) : {}), ...body };
    const title = String(source.title || '').trim();
    if (!title) {
        throw new ApiError(400, 'Judul status page wajib diisi');
    }
    let slug = String(source.slug || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    if (!slug) {
        slug = uid().toLowerCase();
    }
    const duplicate = await db.one('SELECT id FROM status_page WHERE slug = ? AND id != ?', [slug, id || 0]);
    if (duplicate) {
        throw new ApiError(400, 'Slug sudah dipakai status page lain');
    }
    let domain = String(source.domain || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
    if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        throw new ApiError(400, 'Domain kustom tidak valid. Contoh: status.contoh.id');
    }
    if (domain) {
        const owner = await db.one('SELECT id FROM status_page WHERE domain = ? AND id != ?', [domain, id || 0]);
        if (owner) {
            throw new ApiError(400, 'Domain kustom sudah dipakai status page lain');
        }
    }
    const lang = ['id', 'en', 'auto'].includes(source.lang) ? source.lang : 'id';
    const values = {
        slug,
        title: title.slice(0, 150),
        description: String(source.description || '').slice(0, 500),
        icon: String(source.icon || '/favicon.svg').slice(0, 300),
        theme: ['stone', 'light'].includes(source.theme) ? source.theme : 'stone',
        published: bool(source.published) || Boolean(body.publish) ? 1 : 0,
        show_tags: bool(source.showTags, true) ? 1 : 0,
        show_powered_by: bool(source.showPoweredBy, true) ? 1 : 0,
        footer_text: String(source.footerText || '').slice(0, 300),
        custom_css: String(source.customCss || '').slice(0, 20000),
        domain,
        announcement: String(source.announcement || '').slice(0, 2000),
        lang,
    };

    if (id) {
        await db.run(
            `UPDATE status_page SET slug=?, title=?, description=?, icon=?, theme=?, published=?, show_tags=?,
             show_powered_by=?, footer_text=?, custom_css=?, domain=?, announcement=?, lang=? WHERE id=?`,
            [
                values.slug, values.title, values.description, values.icon, values.theme, values.published,
                values.show_tags, values.show_powered_by, values.footer_text, values.custom_css, values.domain,
                values.announcement, values.lang, id,
            ]
        );
    } else {
        const info = await db.run(
            `INSERT INTO status_page (slug, title, description, icon, theme, published, show_tags,
             show_powered_by, footer_text, custom_css, domain, announcement, lang, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                values.slug, values.title, values.description, values.icon, values.theme, values.published,
                values.show_tags, values.show_powered_by, values.footer_text, values.custom_css, values.domain,
                values.announcement, values.lang, now(),
            ]
        );
        id = Number(info.meta.last_row_id);
    }
    await syncStatusPageAssignments(db, id, body);
    return adminStatusPage(db, id);
}

/* ---------------------------------------------------------- pemeliharaan */

async function saveMaintenance(db, body, id = null) {
    const existing = id ? await db.one('SELECT * FROM maintenance WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Pemeliharaan tidak ditemukan');
    }
    const source = { ...(existing ? shapeMaintenance(existing) : {}), ...body };
    const title = String(source.title || '').trim();
    if (!title) {
        throw new ApiError(400, 'Judul pemeliharaan wajib diisi');
    }
    const strategy = ['once', 'daily', 'weekly'].includes(source.strategy) ? source.strategy : 'once';
    const startAt = Number(source.startAt);
    const endAt = Number(source.endAt);
    if (!Number.isFinite(startAt) || startAt <= 0) {
        throw new ApiError(400, 'Waktu mulai wajib diisi');
    }
    if (!Number.isFinite(endAt) || endAt <= startAt) {
        throw new ApiError(400, 'Waktu selesai harus setelah waktu mulai');
    }
    const values = {
        title: title.slice(0, 150),
        description: String(source.description || '').slice(0, 2000),
        strategy,
        start_at: startAt,
        end_at: endAt,
        timezone: String(source.timezone || 'Asia/Jakarta'),
        active: bool(source.active, true) ? 1 : 0,
    };

    if (id) {
        await db.run(
            `UPDATE maintenance SET title=?, description=?, strategy=?, start_at=?, end_at=?, timezone=?, active=?, updated_at=?
             WHERE id=?`,
            [
                values.title, values.description, values.strategy, values.start_at, values.end_at,
                values.timezone, values.active, now(), id,
            ]
        );
    } else {
        const info = await db.run(
            `INSERT INTO maintenance (title, description, strategy, start_at, end_at, timezone, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                values.title, values.description, values.strategy, values.start_at, values.end_at,
                values.timezone, values.active, now(), now(),
            ]
        );
        id = Number(info.meta.last_row_id);
    }

    const statements = [];
    if (Array.isArray(body.monitorIds)) {
        statements.push(
            db.prepare('DELETE FROM maintenance_monitor WHERE maintenance_id = ?').bind(id)
        );
        for (const monitorId of body.monitorIds) {
            const monitor = await db.one('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)]);
            if (monitor) {
                statements.push(
                    db
                        .prepare(
                            'INSERT OR IGNORE INTO maintenance_monitor (maintenance_id, monitor_id) VALUES (?, ?)'
                        )
                        .bind(id, Number(monitorId))
                );
            }
        }
    }
    if (Array.isArray(body.statusPageIds)) {
        statements.push(
            db.prepare('DELETE FROM maintenance_status_page WHERE maintenance_id = ?').bind(id)
        );
        for (const pageId of body.statusPageIds) {
            const page = await db.one('SELECT id FROM status_page WHERE id = ?', [Number(pageId)]);
            if (page) {
                statements.push(
                    db
                        .prepare(
                            'INSERT OR IGNORE INTO maintenance_status_page (maintenance_id, status_page_id) VALUES (?, ?)'
                        )
                        .bind(id, Number(pageId))
                );
            }
        }
    }
    if (statements.length) {
        await db.batch(statements);
    }
    return maintenanceDetail(db, id);
}

async function maintenanceDetail(db, id) {
    const row = await db.one('SELECT * FROM maintenance WHERE id = ?', [id]);
    if (!row) {
        return null;
    }
    const monitors = await db.all('SELECT monitor_id FROM maintenance_monitor WHERE maintenance_id = ?', [
        id,
    ]);
    const pages = await db.all(
        'SELECT status_page_id FROM maintenance_status_page WHERE maintenance_id = ?',
        [id]
    );
    return {
        ...shapeMaintenance(row),
        monitorIds: monitors.map((item) => Number(item.monitor_id)),
        statusPageIds: pages.map((item) => Number(item.status_page_id)),
    };
}

/* --------------------------------------------------------------- badge */

function badgeSvg(label, value, color) {
    const labelWidth = 76;
    const valueWidth = Math.max(54, String(value).length * 8 + 18);
    const total = labelWidth + valueWidth;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeHtml(
        label
    )}: ${escapeHtml(value)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".12"/><stop offset="1" stop-opacity=".12"/></linearGradient>
  <rect width="${total}" height="20" rx="4" fill="#2a241e"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="20" rx="4" fill="${color}"/>
  <rect width="${total}" height="20" rx="4" fill="url(#s)"/>
  <g fill="#f5efe6" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14" text-anchor="middle" fill="#d9cfc2">${escapeHtml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" text-anchor="middle" font-weight="600">${escapeHtml(value)}</text>
  </g>
</svg>`;
}

function statusColor(status) {
    if (status === STATUS.UP) {
        return '#2f9e74';
    }
    if (status === STATUS.DOWN) {
        return '#b8452f';
    }
    if (status === STATUS.MAINTENANCE) {
        return '#8a7a5c';
    }
    return '#a9793f';
}

/* ------------------------------------------------------------ penjadwalan */

export function monitorStub(env, monitorId) {
    const id = env.MONITOR.idFromName(`monitor:${monitorId}`);
    return env.MONITOR.get(id);
}

export async function scheduleMonitor(env, monitorId, delayMs = 0) {
    try {
        const stub = monitorStub(env, monitorId);
        const response = await stub.fetch('https://do/schedule', {
            method: 'POST',
            body: JSON.stringify({ delay: delayMs }),
        });
        await response.text().catch(() => '');
    } catch {
        /* penjadwalan gagal, cron akan menyusul */
    }
}

export async function cancelMonitor(env, monitorId) {
    try {
        const stub = monitorStub(env, monitorId);
        const response = await stub.fetch('https://do/cancel', { method: 'POST', body: '{}' });
        await response.text().catch(() => '');
    } catch {
        /* abaikan */
    }
}

/* ----------------------------------------------------------------- API */

export async function handleApi(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const mutation = !['GET', 'HEAD'].includes(method);
    const db = new Db(env);

    if (path.startsWith('/api') && mutation && !sameOrigin(request)) {
        return fail(403, 'Origin tidak diizinkan');
    }

    try {
        // ---------- publik ----------
        if (path === '/api/health' && method === 'GET') {
            return json({ ok: true, name: 'Uptime Prasasti Websites', time: now() });
        }

        if (path === '/api/setup' && method === 'GET') {
            return json({ needSetup: (await countUsers(db)) === 0 });
        }

        if (path === '/api/setup' && method === 'POST') {
            if ((await countUsers(db)) > 0) {
                throw new ApiError(400, 'Setup sudah selesai');
            }
            const body = await readBody(request);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            if (username.length < 3) {
                throw new ApiError(400, 'Username minimal 3 karakter');
            }
            if (password.length < 8) {
                throw new ApiError(400, 'Kata sandi minimal 8 karakter');
            }
            const info = await db.run(
                'INSERT INTO user (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)',
                [username, await hashPassword(password), now()]
            );
            const userId = Number(info.meta.last_row_id);
            const session = await createSession(db, userId, {
                remember: true,
                ip: clientIp(request),
                userAgent: request.headers.get('user-agent') || '',
            });
            return json(
                { user: { id: userId, username } },
                201,
                { 'Set-Cookie': sessionCookie(session.token, session.expires) }
            );
        }

        if (path === '/api/login' && method === 'POST') {
            const body = await readBody(request);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            const ip = clientIp(request);
            if (isThrottled(ip, username)) {
                throw new ApiError(429, 'Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
            }
            const user = await getUserByName(db, username);
            const ok = user && user.active ? await verifyPassword(password, user.password_hash) : false;
            if (!ok) {
                recordFailure(ip, username);
                throw new ApiError(401, 'Username atau kata sandi salah');
            }
            clearFailures(ip, username);
            const session = await createSession(db, user.id, {
                remember: Boolean(body.remember),
                ip,
                userAgent: request.headers.get('user-agent') || '',
            });
            return json(
                { user: { id: user.id, username: user.username } },
                200,
                { 'Set-Cookie': sessionCookie(session.token, session.expires) }
            );
        }

        if (path === '/api/logout' && method === 'POST') {
            const cookies = parseCookies(request.headers.get('cookie'));
            await destroySession(db, cookies.prasasti_sid);
            return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
        }

        if (path === '/api/session' && method === 'GET') {
            const user = await currentUser(request, db);
            return json({ user: user || null, needSetup: (await countUsers(db)) === 0 });
        }

        if ((path === '/api/status-page' || path.startsWith('/api/status-page/')) && method === 'GET') {
            const slug =
                path === '/api/status-page'
                    ? ''
                    : decodeURIComponent(path.slice('/api/status-page/'.length));
            const host = String(request.headers.get('host') || '').split(':')[0];
            const row = slug
                ? await db.one('SELECT * FROM status_page WHERE slug = ?', [slug])
                : await getPageByDomain(db, host);
            if (!row || !row.published) {
                throw new ApiError(404, 'Status page tidak ditemukan');
            }
            return json(await statusPagePayload(db, row));
        }

        if (path.startsWith('/api/push/') && ['GET', 'POST'].includes(method)) {
            const token = path.slice('/api/push/'.length);
            const row = await db.one("SELECT * FROM monitor WHERE push_token = ? AND type = 'push'", [token]);
            if (!row) {
                throw new ApiError(404, 'Token push tidak dikenal');
            }
            let body = {};
            if (method === 'POST') {
                body = await readBody(request).catch(() => ({}));
            }
            const query = Object.fromEntries(url.searchParams.entries());
            const status = body.status || query.status || 'up';
            const msg = body.msg || body.message || query.msg || 'Heartbeat push diterima';
            const ping = body.ping || query.ping || null;
            const beat = await pushBeat(db, env, row, { status, msg, ping });
            await broadcastBeat(env, db, row, beat);
            return json({ ok: true, monitorId: row.id, beat });
        }

        if (path.startsWith('/api/badge/') && method === 'GET') {
            const parts = path.split('/').filter(Boolean);
            const monitorId = Number(parts[2]);
            const kind = parts[3] || 'status';
            const monitor = await db.one('SELECT * FROM monitor WHERE id = ?', [monitorId]);
            if (!monitor) {
                throw new ApiError(404, 'Monitor tidak ditemukan');
            }
            const summary = await summaryOf(db, monitor, { beatLimit: 30 });
            let label = 'uptime';
            let value = 'unknown';
            let color = '#8a7a5c';
            if (kind === 'uptime') {
                const hours = parts[4] ? Number(String(parts[4]).replace('h', '')) : 24;
                const uptime = await uptimeOf(db, monitorId, now() - clamp(hours, 1, 8760, 24) * 3600000);
                value = uptime.uptime === null ? 'no data' : `${uptime.uptime.toFixed(2)}%`;
                color =
                    uptime.uptime !== null && uptime.uptime >= 99
                        ? '#2f9e74'
                        : uptime.uptime >= 95
                          ? '#a9793f'
                          : '#b8452f';
            } else {
                value =
                    summary.status === STATUS.UP
                        ? 'up'
                        : summary.status === STATUS.DOWN
                          ? 'down'
                          : summary.status === STATUS.MAINTENANCE
                            ? 'maintenance'
                            : 'pending';
                color = statusColor(summary.status);
            }
            return text(badgeSvg(label, value, color), 200, 'image/svg+xml');
        }

        // ---------- perlu autentikasi ----------
        const user = await requireUser(request, db);
        if (user.viaApiKey) {
            if (mutation && user.scope !== 'write') {
                throw new ApiError(403, 'Kunci API ini hanya punya akses baca');
            }
            if (path.startsWith('/api/api-keys')) {
                throw new ApiError(403, 'Kunci API tidak dapat mengelola kunci API lain');
            }
        }

        if (path === '/api/bootstrap' && method === 'GET') {
            const settings = await db.settings();
            const statusPages = [];
            for (const row of await db.all('SELECT * FROM status_page ORDER BY title')) {
                statusPages.push(await adminStatusPage(db, row.id));
            }
            return json({
                user,
                settings,
                monitors: await summariesOf(db),
                tags: await db.all('SELECT * FROM tag ORDER BY name'),
                notifications: (await db.all('SELECT * FROM notification ORDER BY name')).map(shapeNotification),
                statusPages,
                maintenances: (
                    await db.all('SELECT * FROM maintenance ORDER BY start_at DESC')
                ).map((row) => maintenanceDetail(db, row.id)),
                incidents: (await db.all('SELECT * FROM incident ORDER BY started_at DESC LIMIT 100')).map(
                    shapeIncident
                ),
                stats: await statsOf(db),
                apiKeys: await listApiKeys(db, user.id),
                serverTime: now(),
                version: '1.0.0-workers',
            });
        }

        if (path === '/api/monitors' && method === 'GET') {
            return json({ monitors: await summariesOf(db), stats: await statsOf(db) });
        }

        if (path === '/api/monitors' && method === 'POST') {
            const body = await readBody(request);
            const monitor = await saveMonitor(db, env, body);
            return json({ monitor: await summaryOf(db, monitor) }, 201);
        }

        if (path === '/api/stats' && method === 'GET') {
            return json(await statsOf(db));
        }

        const monitorMatch = path.match(/^\/api\/monitors\/(\d+)(?:\/([a-z-]+))?$/);
        if (monitorMatch) {
            const monitorId = Number(monitorMatch[1]);
            const action = monitorMatch[2];
            const row = await db.one('SELECT * FROM monitor WHERE id = ?', [monitorId]);
            if (!row) {
                throw new ApiError(404, 'Monitor tidak ditemukan');
            }

            if (!action && method === 'GET') {
                const summary = await summaryOf(db, row);
                const nowTs = now();
                return json({
                    monitor: summary,
                    uptime: {
                        '24h': await uptimeOf(db, monitorId, nowTs - 86400000),
                        '7d': await uptimeOf(db, monitorId, nowTs - 7 * 86400000),
                        '30d': await uptimeOf(db, monitorId, nowTs - 30 * 86400000),
                        '90d': await uptimeOf(db, monitorId, nowTs - 90 * 86400000),
                        '365d': await uptimeOf(db, monitorId, nowTs - 365 * 86400000),
                    },
                    events: (
                        await db.all(
                            'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 50',
                            [monitorId]
                        )
                    ).map(shapeBeat),
                    incidents: (
                        await db.all(
                            'SELECT * FROM incident WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20',
                            [monitorId]
                        )
                    ).map(shapeIncident),
                    chart: await chartOf(db, monitorId, 24),
                });
            }

            if (!action && method === 'PATCH') {
                const body = await readBody(request);
                await saveMonitor(db, env, body, monitorId);
                const updated = await db.one('SELECT * FROM monitor WHERE id = ?', [monitorId]);
                return json({ monitor: await summaryOf(db, updated) });
            }

            if (!action && method === 'DELETE') {
                await db.run('DELETE FROM monitor WHERE id = ?', [monitorId]);
                await cancelMonitor(env, monitorId);
                return json({ ok: true });
            }

            if (action === 'pause' && method === 'POST') {
                await db.run('UPDATE monitor SET active = 0, updated_at = ? WHERE id = ?', [now(), monitorId]);
                await cancelMonitor(env, monitorId);
                return json({ ok: true });
            }

            if (action === 'resume' && method === 'POST') {
                await db.run('UPDATE monitor SET active = 1, updated_at = ? WHERE id = ?', [now(), monitorId]);
                await scheduleMonitor(env, monitorId);
                return json({ ok: true });
            }

            if (action === 'check' && method === 'POST') {
                // Pemeriksaan manual lewat DO supaya tidak berjalan bersamaan
                // dengan alarm pemeriksaan terjadwal.
                const response = await monitorStub(env, monitorId).fetch('https://do/check', {
                    method: 'POST',
                    body: '{}',
                });
                if (!response.ok) {
                    throw new ApiError(500, 'Pemeriksaan gagal dijalankan');
                }
                const data = await response.json();
                return json({
                    beat: data.beat,
                    summary: await summaryOf(db, row),
                });
            }

            if (action === 'chart' && method === 'GET') {
                const hours = clamp(url.searchParams.get('hours'), 1, 8760, 24);
                return json({ chart: await chartOf(db, monitorId, hours) });
            }

            if (action === 'beats' && method === 'GET') {
                const limit = clamp(url.searchParams.get('limit'), 1, 1000, 100);
                return json({ beats: await beatsOf(db, monitorId, limit) });
            }

            if (action === 'events' && method === 'GET') {
                const offset = clamp(url.searchParams.get('offset'), 0, 100000, 0);
                const limit = clamp(url.searchParams.get('limit'), 1, 200, 20);
                const events = (
                    await db.all(
                        'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT ? OFFSET ?',
                        [monitorId, limit, offset]
                    )
                ).map(shapeBeat);
                const total = await db.one('SELECT COUNT(*) AS total FROM heartbeat WHERE monitor_id = ?', [
                    monitorId,
                ]);
                return json({ events, total: Number(total.total) });
            }

            if (action === 'reset-token' && method === 'POST') {
                const token = randomToken(12);
                await db.run('UPDATE monitor SET push_token = ? WHERE id = ?', [token, monitorId]);
                return json({ pushToken: token });
            }
        }

        if (path === '/api/tags' && method === 'GET') {
            return json({ tags: await db.all('SELECT * FROM tag ORDER BY name') });
        }

        if (path === '/api/tags' && method === 'POST') {
            const body = await readBody(request);
            const name = String(body.name || '').trim();
            if (!name) {
                throw new ApiError(400, 'Nama tag wajib diisi');
            }
            const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#a8825a';
            const existing = await db.one('SELECT * FROM tag WHERE name = ?', [name]);
            if (existing) {
                return json({ tag: existing });
            }
            const info = await db.run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [
                name.slice(0, 40),
                color,
                now(),
            ]);
            return json({ tag: await db.one('SELECT * FROM tag WHERE id = ?', [Number(info.meta.last_row_id)]) }, 201);
        }

        const tagMatch = path.match(/^\/api\/tags\/(\d+)$/);
        if (tagMatch) {
            const tagId = Number(tagMatch[1]);
            if (method === 'PATCH') {
                const body = await readBody(request);
                const name = String(body.name || '').trim();
                const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#a8825a';
                if (!name) {
                    throw new ApiError(400, 'Nama tag wajib diisi');
                }
                await db.run('UPDATE tag SET name = ?, color = ? WHERE id = ?', [name.slice(0, 40), color, tagId]);
                return json({ tag: await db.one('SELECT * FROM tag WHERE id = ?', [tagId]) });
            }
            if (method === 'DELETE') {
                await db.run('DELETE FROM tag WHERE id = ?', [tagId]);
                return json({ ok: true });
            }
        }

        if (path === '/api/notifications' && method === 'GET') {
            return json({
                notifications: (await db.all('SELECT * FROM notification ORDER BY name')).map(shapeNotification),
            });
        }

        if (path === '/api/notifications' && method === 'POST') {
            const body = await readBody(request);
            return json({ notification: await saveNotification(db, body) }, 201);
        }

        const notificationMatch = path.match(/^\/api\/notifications\/(\d+)(?:\/(test))?$/);
        if (notificationMatch) {
            const notificationId = Number(notificationMatch[1]);
            const action = notificationMatch[2];
            const row = await db.one('SELECT * FROM notification WHERE id = ?', [notificationId]);
            if (!row) {
                throw new ApiError(404, 'Notifikasi tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(request);
                return json({ notification: await saveNotification(db, body, notificationId) });
            }
            if (!action && method === 'DELETE') {
                await db.run('DELETE FROM notification WHERE id = ?', [notificationId]);
                return json({ ok: true });
            }
            if (action === 'test' && method === 'POST') {
                const notification = shapeNotification(row);
                const message = await dispatch(notification, {
                    title: 'Uji coba notifikasi Prasasti',
                    message: 'Jika Anda membaca ini, integrasi notifikasi berfungsi dengan baik.',
                    status: 'up',
                    event: 'test',
                    time: now(),
                    monitor: { id: 0, name: 'Monitor contoh', url: 'https://prasasti.local', type: 'http' },
                    monitorUrl: 'https://prasasti.local',
                });
                await db.run(
                    'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, NULL, ?, 1, ?, ?)',
                    [notificationId, 'test', message || 'OK', now()]
                );
                return json({ ok: true, message });
            }
        }

        if (path === '/api/notification-logs' && method === 'GET') {
            return json({
                logs: await db.all(
                    `SELECT l.*, n.name AS notification_name, m.name AS monitor_name
                     FROM notification_log l
                     LEFT JOIN notification n ON n.id = l.notification_id
                     LEFT JOIN monitor m ON m.id = l.monitor_id
                     ORDER BY l.created_at DESC LIMIT 60`
                ),
            });
        }

        if (path === '/api/status-pages' && method === 'GET') {
            const pages = [];
            for (const row of await db.all('SELECT * FROM status_page ORDER BY title')) {
                pages.push(await adminStatusPage(db, row.id));
            }
            return json({ statusPages: pages });
        }

        if (path === '/api/status-pages' && method === 'POST') {
            const body = await readBody(request);
            return json({ statusPage: await saveStatusPage(db, body) }, 201);
        }

        const pageMatch = path.match(/^\/api\/status-pages\/(\d+)(?:\/(publish))?$/);
        if (pageMatch) {
            const pageId = Number(pageMatch[1]);
            const action = pageMatch[2];
            const row = await db.one('SELECT * FROM status_page WHERE id = ?', [pageId]);
            if (!row) {
                throw new ApiError(404, 'Status page tidak ditemukan');
            }
            if (!action && method === 'GET') {
                return json({ statusPage: await adminStatusPage(db, pageId) });
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(request);
                return json({ statusPage: await saveStatusPage(db, body, pageId) });
            }
            if (!action && method === 'DELETE') {
                await db.run('DELETE FROM status_page WHERE id = ?', [pageId]);
                return json({ ok: true });
            }
            if (action === 'publish' && method === 'POST') {
                const body = await readBody(request).catch(() => ({}));
                const published = body.published === undefined ? !row.published : Boolean(body.published);
                await db.run('UPDATE status_page SET published = ? WHERE id = ?', [published ? 1 : 0, pageId]);
                return json({ ok: true, published });
            }
        }

        if (path === '/api/incidents' && method === 'GET') {
            const pageId = url.searchParams.get('statusPageId');
            const rows = pageId
                ? await db.all(
                      'SELECT * FROM incident WHERE status_page_id = ? ORDER BY started_at DESC LIMIT 200',
                      [Number(pageId)]
                  )
                : await db.all('SELECT * FROM incident ORDER BY started_at DESC LIMIT 200');
            return json({ incidents: rows.map(shapeIncident) });
        }

        if (path === '/api/incidents' && method === 'POST') {
            const body = await readBody(request);
            const title = String(body.title || '').trim();
            if (!title) {
                throw new ApiError(400, 'Judul insiden wajib diisi');
            }
            const pageId = body.statusPageId ? Number(body.statusPageId) : null;
            const monitorId = body.monitorId ? Number(body.monitorId) : null;
            const startedAt = Number(body.startedAt) || now();
            const style = ['info', 'warning', 'danger', 'success'].includes(body.style) ? body.style : 'warning';
            const info = await db.run(
                `INSERT INTO incident (monitor_id, status_page_id, title, content, style, started_at, pinned, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    monitorId, pageId, title.slice(0, 200), String(body.content || '').slice(0, 5000), style,
                    startedAt, bool(body.pinned) ? 1 : 0, now(),
                ]
            );
            await broadcastRefresh(env, { scope: 'incidents' });
            return json({ incident: shapeIncident(await db.one('SELECT * FROM incident WHERE id = ?', [Number(info.meta.last_row_id)])) }, 201);
        }

        const incidentMatch = path.match(/^\/api\/incidents\/(\d+)(?:\/(resolve|pin))?$/);
        if (incidentMatch) {
            const incidentId = Number(incidentMatch[1]);
            const action = incidentMatch[2];
            const row = await db.one('SELECT * FROM incident WHERE id = ?', [incidentId]);
            if (!row) {
                throw new ApiError(404, 'Insiden tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(request);
                const title = String(body.title ?? row.title).trim();
                await db.run(
                    'UPDATE incident SET title=?, content=?, style=?, pinned=?, started_at=? WHERE id=?',
                    [
                        title.slice(0, 200),
                        String(body.content ?? row.content).slice(0, 5000),
                        ['info', 'warning', 'danger', 'success'].includes(body.style) ? body.style : row.style,
                        body.pinned === undefined ? row.pinned : bool(body.pinned) ? 1 : 0,
                        Number(body.startedAt) || row.started_at,
                        incidentId,
                    ]
                );
                await broadcastRefresh(env, { scope: 'incidents' });
                return json({ incident: shapeIncident(await db.one('SELECT * FROM incident WHERE id = ?', [incidentId])) });
            }
            if (!action && method === 'DELETE') {
                await db.run('DELETE FROM incident WHERE id = ?', [incidentId]);
                await broadcastRefresh(env, { scope: 'incidents' });
                return json({ ok: true });
            }
            if (action === 'resolve' && method === 'POST') {
                await db.run('UPDATE incident SET resolved_at = ? WHERE id = ?', [now(), incidentId]);
                await broadcastRefresh(env, { scope: 'incidents' });
                return json({ ok: true });
            }
            if (action === 'pin' && method === 'POST') {
                await db.run('UPDATE incident SET pinned = ? WHERE id = ?', [row.pinned ? 0 : 1, incidentId]);
                return json({ ok: true });
            }
        }

        if (path === '/api/maintenances' && method === 'GET') {
            const rows = await db.all('SELECT * FROM maintenance ORDER BY start_at DESC');
            const list = [];
            for (const row of rows) {
                list.push(await maintenanceDetail(db, row.id));
            }
            return json({ maintenances: list });
        }

        if (path === '/api/maintenances' && method === 'POST') {
            const body = await readBody(request);
            return json({ maintenance: await saveMaintenance(db, body) }, 201);
        }

        const maintenanceMatch = path.match(/^\/api\/maintenances\/(\d+)(?:\/(pause|resume))?$/);
        if (maintenanceMatch) {
            const maintenanceId = Number(maintenanceMatch[1]);
            const action = maintenanceMatch[2];
            const row = await db.one('SELECT * FROM maintenance WHERE id = ?', [maintenanceId]);
            if (!row) {
                throw new ApiError(404, 'Pemeliharaan tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(request);
                return json({ maintenance: await saveMaintenance(db, body, maintenanceId) });
            }
            if (!action && method === 'DELETE') {
                await db.run('DELETE FROM maintenance WHERE id = ?', [maintenanceId]);
                return json({ ok: true });
            }
            if (action === 'pause' && method === 'POST') {
                await db.run('UPDATE maintenance SET active = 0 WHERE id = ?', [maintenanceId]);
                return json({ ok: true });
            }
            if (action === 'resume' && method === 'POST') {
                await db.run('UPDATE maintenance SET active = 1 WHERE id = ?', [maintenanceId]);
                return json({ ok: true });
            }
        }

        if (path === '/api/settings' && method === 'GET') {
            return json({ settings: await db.settings() });
        }

        if (path === '/api/settings' && method === 'PATCH') {
            const body = await readBody(request);
            const allowed = [
                'title', 'description', 'timezone', 'theme', 'retentionDays', 'certificateExpiryDays',
                'domainExpiryDays', 'heartbeatBarSize', 'showPoweredBy',
            ];
            for (const key of allowed) {
                if (body[key] !== undefined) {
                    await db.setSetting(key, String(body[key]).slice(0, 2000));
                }
            }
            const settings = await db.settings();
            await broadcastSettings(env, settings);
            return json({ settings });
        }

        if (path === '/api/password' && method === 'POST') {
            const body = await readBody(request);
            const row = await db.one('SELECT * FROM user WHERE id = ?', [user.id]);
            const ok = await verifyPassword(String(body.current || ''), row.password_hash);
            if (!ok) {
                throw new ApiError(400, 'Kata sandi saat ini salah');
            }
            const next = String(body.next || '');
            if (next.length < 8) {
                throw new ApiError(400, 'Kata sandi baru minimal 8 karakter');
            }
            await db.run('UPDATE user SET password_hash = ? WHERE id = ?', [
                await hashPassword(next),
                user.id,
            ]);
            const cookies = parseCookies(request.headers.get('cookie'));
            await destroyOtherSessions(db, user.id, cookies.prasasti_sid);
            return json({ ok: true });
        }

        if (path === '/api/users' && method === 'POST') {
            const body = await readBody(request);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            if (username.length < 3 || password.length < 8) {
                throw new ApiError(400, 'Username minimal 3 karakter dan sandi minimal 8 karakter');
            }
            if (await getUserByName(db, username)) {
                throw new ApiError(400, 'Username sudah dipakai');
            }
            await db.run('INSERT INTO user (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)', [
                username,
                await hashPassword(password),
                now(),
            ]);
            return json({ ok: true }, 201);
        }

        if (path === '/api/api-keys' && method === 'GET') {
            return json({ keys: await listApiKeys(db, user.id) });
        }

        if (path === '/api/api-keys' && method === 'POST') {
            const body = await readBody(request);
            const name = String(body.name || '').trim();
            if (!name) {
                throw new ApiError(400, 'Nama kunci wajib diisi');
            }
            const scope = body.scope === 'write' ? 'write' : 'read';
            const created = await createApiKey(db, user.id, {
                name,
                scope,
                expiresInDays: clamp(body.expiresInDays, 0, 3650, 0),
            });
            return json(
                {
                    key: {
                        id: created.id,
                        name: created.name,
                        scope: created.scope,
                        prefix: created.prefix,
                        createdAt: created.createdAt,
                        expiresAt: created.expiresAt,
                    },
                    token: created.token,
                },
                201
            );
        }

        const apiKeyMatch = path.match(/^\/api\/api-keys\/(\d+)$/);
        if (apiKeyMatch && method === 'DELETE') {
            await revokeApiKey(db, Number(apiKeyMatch[1]), user.id);
            return json({ ok: true });
        }

        if (path === '/api/export' && method === 'GET') {
            const monitors = [];
            for (const row of await db.all('SELECT * FROM monitor')) {
                const monitor = shapeMonitor(row);
                const tags = await db.all(
                    `SELECT t.id, t.name, t.color FROM tag t
                     JOIN monitor_tag mt ON mt.tag_id = t.id WHERE mt.monitor_id = ? ORDER BY t.name`,
                    [row.id]
                );
                const notificationIds = (
                    await db.all('SELECT notification_id FROM monitor_notification WHERE monitor_id = ?', [
                        row.id,
                    ])
                ).map((item) => Number(item.notification_id));
                monitors.push({ ...monitor, tags: tags.map((tag) => tag.name), notificationIds });
            }
            const statusPages = [];
            for (const row of await db.all('SELECT * FROM status_page')) {
                statusPages.push(await adminStatusPage(db, row.id));
            }
            const maintenances = [];
            for (const row of await db.all('SELECT * FROM maintenance')) {
                maintenances.push(await maintenanceDetail(db, row.id));
            }
            return json({
                version: 1,
                exportedAt: new Date().toISOString(),
                settings: await db.settings(),
                tags: await db.all('SELECT * FROM tag'),
                notifications: (await db.all('SELECT * FROM notification')).map(shapeNotification),
                monitors,
                statusPages,
                maintenances,
            });
        }

        if (path === '/api/import' && method === 'POST') {
            const body = await readBody(request);
            const payload = body.data && typeof body.data === 'object' ? body.data : body;
            const imported = { monitors: 0, notifications: 0, statusPages: 0 };
            const tagIds = new Map();
            for (const tag of payload.tags || []) {
                if (!tag.name) {
                    continue;
                }
                let row = await db.one('SELECT * FROM tag WHERE name = ?', [String(tag.name)]);
                if (!row) {
                    const info = await db.run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [
                        String(tag.name).slice(0, 40),
                        String(tag.color || '#a8825a'),
                        now(),
                    ]);
                    row = await db.one('SELECT * FROM tag WHERE id = ?', [Number(info.meta.last_row_id)]);
                }
                tagIds.set(String(tag.id), row.id);
                tagIds.set(String(tag.name), row.id);
            }
            const notificationIds = {};
            for (const notification of payload.notifications || []) {
                const saved = await saveNotification(db, {
                    name: notification.name,
                    type: notification.type,
                    config: notification.config,
                    active: notification.active,
                    isDefault: notification.isDefault,
                    events: notification.events,
                    resendInterval: notification.resendInterval,
                });
                notificationIds[notification.id] = saved.id;
                imported.notifications += 1;
            }
            for (const monitor of payload.monitors || []) {
                const tags = [];
                for (const value of monitor.tags || []) {
                    const key = String(value);
                    let tagId = tagIds.get(key);
                    if (!tagId) {
                        let row = await db.one('SELECT id FROM tag WHERE name = ?', [key]);
                        if (!row) {
                            const info = await db.run(
                                'INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)',
                                [key.slice(0, 40), '#a8825a', now()]
                            );
                            row = { id: Number(info.meta.last_row_id) };
                        }
                        tagId = Number(row.id);
                        tagIds.set(key, tagId);
                    }
                    tags.push(tagId);
                }
                await saveMonitor(db, env, {
                    ...monitor,
                    tags,
                    notificationIds: (monitor.notificationIds || []).map((id) => notificationIds[id]).filter(Boolean),
                });
                imported.monitors += 1;
            }
            for (const page of payload.statusPages || []) {
                await saveStatusPage(db, {
                    ...page,
                    groups: (page.groups || []).map((group) => ({ name: group.name, monitors: group.monitors || [] })),
                });
                imported.statusPages += 1;
            }
            return json({ ok: true, imported });
        }

        throw new ApiError(404, 'Endpoint tidak ditemukan');
    } catch (caught) {
        if (caught instanceof ApiError) {
            return fail(caught.status, caught.message);
        }
        console.error('[api]', caught);
        return fail(500, caught.message || 'Kesalahan server');
    }
}

/* --------------------------------------------------------------- realtime */

export async function broadcastBeat(env, db, monitorRow, beat) {
    try {
        const monitor = await db.one('SELECT * FROM monitor WHERE id = ?', [monitorRow.id]);
        const summary = await summaryOf(db, monitor);
        const slugs = await statusPageSlugsForMonitor(db, monitorRow.id);
        await hubFetch(env, {
            type: 'beat',
            monitorId: monitorRow.id,
            beat,
            summary,
            slugs,
        });
    } catch (error) {
        console.error('[broadcast]', error);
    }
}

export async function broadcastRefresh(env, payload = {}) {
    try {
        await hubFetch(env, { type: 'refresh', ...payload });
    } catch (error) {
        console.error('[broadcast]', error);
    }
}

export async function broadcastSettings(env, settings) {
    try {
        await hubFetch(env, { type: 'settings', settings });
    } catch (error) {
        console.error('[broadcast]', error);
    }
}

export async function statusPageSlugsForMonitor(db, monitorId) {
    const rows = await db.all(
        `SELECT DISTINCT sp.slug FROM status_page sp
         WHERE sp.published = 1 AND (
            sp.id IN (SELECT status_page_id FROM status_page_monitor WHERE monitor_id = ?)
            OR sp.id IN (
                SELECT g.status_page_id FROM status_page_group g
                JOIN status_page_group_monitor gm ON gm.group_id = g.id
                WHERE gm.monitor_id = ?
            )
         )`,
        [monitorId, monitorId]
    );
    return rows.map((row) => row.slug);
}

export async function hubFetch(env, payload) {
    const id = env.HUB.idFromName('hub');
    const stub = env.HUB.get(id);
    const response = await stub.fetch('https://hub/broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
    await response.text().catch(() => '');
}
