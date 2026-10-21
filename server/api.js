'use strict';

const {
    all,
    get,
    run,
    getSettings,
    setSetting,
    transaction,
} = require('./db');
const {
    STATUS,
    MONITOR_TYPES,
    NOTIFICATION_TYPES,
    now,
    clamp,
    bool,
    parseJson,
    normalizeUrl,
    uid,
    randomToken,
    escapeHtml,
    percent,
} = require('./util');
const {
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
} = require('./auth');
const {
    shapeMonitor,
    shapeNotification,
    shapeStatusPage,
    shapeIncident,
    shapeMaintenance,
    shapeBeat,
} = require('./models');
const engine = require('./engine');
const { dispatch } = require('./notifier');
const { statusPagePayload } = require('./statuspage');

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const TYPES = new Set(MONITOR_TYPES);
const NOTIFICATION_SET = new Set(NOTIFICATION_TYPES);

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
}

function error(res, status, message) {
    sendJson(res, status, { error: message });
}

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) {
        return true;
    }
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

function currentUser(req) {
    const cookies = parseCookies(req.headers.cookie);
    return getSessionUser(cookies.prasasti_sid);
}

function requireUser(req) {
    const user = currentUser(req);
    if (!user) {
        throw new ApiError(401, 'Silakan masuk terlebih dahulu');
    }
    return user;
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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
    let port = source.port === '' || source.port === null || source.port === undefined ? null : Number(source.port);

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

    let parentId = source.parentId === '' || source.parentId === null || source.parentId === undefined
        ? null
        : Number(source.parentId);
    if (parentId !== null) {
        const parent = get('SELECT * FROM monitor WHERE id = ?', [parentId]);
        if (!parent || parent.type !== 'group') {
            throw new ApiError(400, 'Grup induk tidak valid');
        }
        if (existing && parentId === existing.id) {
            throw new ApiError(400, 'Monitor tidak boleh menjadi induk dirinya sendiri');
        }
        if (type === 'group' && existing && parentId) {
            let cursor = parent;
            const seen = new Set([existing.id]);
            while (cursor) {
                if (seen.has(cursor.id)) {
                    throw new ApiError(400, 'Siklus grup terdeteksi');
                }
                seen.add(cursor.id);
                cursor = cursor.parent_id ? get('SELECT * FROM monitor WHERE id = ?', [cursor.parent_id]) : null;
            }
        }
    }

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
        expected_value: source.expectedValue === null || source.expectedValue === undefined
            ? ''
            : String(source.expectedValue),
        accepted_codes: String(source.acceptedCodes || ''),
        max_redirects: Math.round(clamp(source.maxRedirects, 0, 20, 10)),
        ignore_tls: bool(source.ignoreTls) ? 1 : 0,
        cert_expiry_notification: bool(source.certExpiryNotification, true) ? 1 : 0,
        domain_expiry_notification: bool(source.domainExpiryNotification) ? 1 : 0,
        dns_record_type: dnsRecordType,
        dns_resolver: String(source.dnsResolver || ''),
        parent_id: parentId,
        description: String(source.description || '').slice(0, 1000),
        active: bool(source.active, true) ? 1 : 0,
    };
}

function saveMonitor(body, id = null) {
    const existing = id ? get('SELECT * FROM monitor WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Monitor tidak ditemukan');
    }
    const values = validateMonitorInput(body, existing);
    const timestamp = now();
    let monitorId = id;

    transaction(() => {
        if (id) {
            run(
                `UPDATE monitor SET name=?, type=?, url=?, hostname=?, port=?, method=?, headers=?, body=?,
                 interval=?, retries=?, retry_interval=?, timeout=?, upside_down=?, keyword=?, json_path=?,
                 expected_value=?, accepted_codes=?, max_redirects=?, ignore_tls=?, cert_expiry_notification=?,
                 domain_expiry_notification=?, dns_record_type=?, dns_resolver=?, parent_id=?, description=?,
                 active=?, updated_at=? WHERE id=?`,
                [
                    values.name, values.type, values.url, values.hostname, values.port, values.method,
                    values.headers, values.body, values.interval, values.retries, values.retry_interval,
                    values.timeout, values.upside_down, values.keyword, values.json_path, values.expected_value,
                    values.accepted_codes, values.max_redirects, values.ignore_tls,
                    values.cert_expiry_notification, values.domain_expiry_notification, values.dns_record_type,
                    values.dns_resolver, values.parent_id, values.description, values.active, timestamp, id,
                ]
            );
        } else {
            const pushToken = values.type === 'push' ? randomToken(12) : null;
            const info = run(
                `INSERT INTO monitor (name, type, url, hostname, port, method, headers, body, interval, retries,
                 retry_interval, timeout, upside_down, keyword, json_path, expected_value, accepted_codes,
                 max_redirects, ignore_tls, cert_expiry_notification, domain_expiry_notification, dns_record_type,
                 dns_resolver, parent_id, description, active, push_token, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    values.name, values.type, values.url, values.hostname, values.port, values.method,
                    values.headers, values.body, values.interval, values.retries, values.retry_interval,
                    values.timeout, values.upside_down, values.keyword, values.json_path, values.expected_value,
                    values.accepted_codes, values.max_redirects, values.ignore_tls,
                    values.cert_expiry_notification, values.domain_expiry_notification, values.dns_record_type,
                    values.dns_resolver, values.parent_id, values.description, values.active, pushToken,
                    timestamp, timestamp,
                ]
            );
            monitorId = Number(info.lastInsertRowid);
        }

        if (Array.isArray(body.tags)) {
            run('DELETE FROM monitor_tag WHERE monitor_id = ?', [monitorId]);
            for (const tagId of body.tags.slice(0, 30)) {
                if (get('SELECT id FROM tag WHERE id = ?', [Number(tagId)])) {
                    run('INSERT OR IGNORE INTO monitor_tag (monitor_id, tag_id) VALUES (?, ?)', [monitorId, Number(tagId)]);
                }
            }
        }

        if (Array.isArray(body.notificationIds)) {
            run('DELETE FROM monitor_notification WHERE monitor_id = ?', [monitorId]);
            for (const notificationId of body.notificationIds.slice(0, 50)) {
                if (get('SELECT id FROM notification WHERE id = ?', [Number(notificationId)])) {
                    run('INSERT OR IGNORE INTO monitor_notification (monitor_id, notification_id) VALUES (?, ?)', [
                        monitorId,
                        Number(notificationId),
                    ]);
                }
            }
        }
    });

    const monitor = shapeMonitor(get('SELECT * FROM monitor WHERE id = ?', [monitorId]));
    engine.unschedule(monitorId);
    if (monitor.active && monitor.type !== 'group' && monitor.type !== 'push') {
        engine.schedule(monitor);
    }
    return monitor;
}

function notificationPayload(row) {
    return shapeNotification(row);
}

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
    return {
        name,
        type,
        config: JSON.stringify(config || {}),
        active: bool(source.active, true) ? 1 : 0,
        is_default: bool(source.isDefault) ? 1 : 0,
    };
}

function saveNotification(body, id = null) {
    const existing = id ? get('SELECT * FROM notification WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Notifikasi tidak ditemukan');
    }
    const values = validateNotification(body, existing);
    if (id) {
        run('UPDATE notification SET name=?, type=?, config=?, active=?, is_default=? WHERE id=?', [
            values.name, values.type, values.config, values.active, values.is_default, id,
        ]);
    } else {
        const info = run(
            'INSERT INTO notification (name, type, config, active, is_default, created_at) VALUES (?,?,?,?,?,?)',
            [values.name, values.type, values.config, values.active, values.is_default, now()]
        );
        id = Number(info.lastInsertRowid);
    }
    return notificationPayload(get('SELECT * FROM notification WHERE id = ?', [id]));
}

function syncStatusPageAssignments(pageId, body) {
    if (Array.isArray(body.monitors)) {
        run('DELETE FROM status_page_monitor WHERE status_page_id = ?', [pageId]);
        body.monitors.slice(0, 200).forEach((monitorId, index) => {
            if (get('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)])) {
                run('INSERT OR IGNORE INTO status_page_monitor (status_page_id, monitor_id, weight) VALUES (?, ?, ?)', [
                    pageId, Number(monitorId), index,
                ]);
            }
        });
    }
    if (Array.isArray(body.groups)) {
        const existingGroups = all('SELECT id FROM status_page_group WHERE status_page_id = ?', [pageId]);
        for (const group of existingGroups) {
            run('DELETE FROM status_page_group_monitor WHERE group_id = ?', [group.id]);
        }
        run('DELETE FROM status_page_group WHERE status_page_id = ?', [pageId]);
        body.groups.slice(0, 40).forEach((group, index) => {
            const name = String(group.name || '').trim();
            if (!name) {
                return;
            }
            const info = run('INSERT INTO status_page_group (status_page_id, name, weight) VALUES (?, ?, ?)', [
                pageId, name.slice(0, 100), index,
            ]);
            const groupId = Number(info.lastInsertRowid);
            (Array.isArray(group.monitors) ? group.monitors : []).slice(0, 200).forEach((monitorId, monitorIndex) => {
                if (get('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)])) {
                    run(
                        'INSERT OR IGNORE INTO status_page_group_monitor (group_id, monitor_id, weight) VALUES (?, ?, ?)',
                        [groupId, Number(monitorId), monitorIndex]
                    );
                }
            });
        });
    }
    if (Array.isArray(body.maintenanceIds)) {
        run('DELETE FROM maintenance_status_page WHERE status_page_id = ?', [pageId]);
        for (const maintenanceId of body.maintenanceIds) {
            if (get('SELECT id FROM maintenance WHERE id = ?', [Number(maintenanceId)])) {
                run('INSERT OR IGNORE INTO maintenance_status_page (maintenance_id, status_page_id) VALUES (?, ?)', [
                    Number(maintenanceId), pageId,
                ]);
            }
        }
    }
}

function saveStatusPage(body, id = null) {
    const existing = id ? get('SELECT * FROM status_page WHERE id = ?', [id]) : null;
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
    const duplicate = get('SELECT id FROM status_page WHERE slug = ? AND id != ?', [slug, id || 0]);
    if (duplicate) {
        throw new ApiError(400, 'Slug sudah dipakai status page lain');
    }
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
    };

    let pageId = id;
    transaction(() => {
        if (id) {
            run(
                `UPDATE status_page SET slug=?, title=?, description=?, icon=?, theme=?, published=?, show_tags=?,
                 show_powered_by=?, footer_text=?, custom_css=? WHERE id=?`,
                [
                    values.slug, values.title, values.description, values.icon, values.theme, values.published,
                    values.show_tags, values.show_powered_by, values.footer_text, values.custom_css, id,
                ]
            );
        } else {
            const info = run(
                `INSERT INTO status_page (slug, title, description, icon, theme, published, show_tags,
                 show_powered_by, footer_text, custom_css, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [
                    values.slug, values.title, values.description, values.icon, values.theme, values.published,
                    values.show_tags, values.show_powered_by, values.footer_text, values.custom_css, now(),
                ]
            );
            pageId = Number(info.lastInsertRowid);
        }
        syncStatusPageAssignments(pageId, body);
    });
    return adminStatusPage(pageId);
}

function adminStatusPage(pageId) {
    const row = get('SELECT * FROM status_page WHERE id = ?', [pageId]);
    if (!row) {
        return null;
    }
    const page = shapeStatusPage(row);
    return {
        ...page,
        monitors: all('SELECT monitor_id, weight FROM status_page_monitor WHERE status_page_id = ? ORDER BY weight', [pageId]).map(
            (item) => ({ monitorId: Number(item.monitor_id), weight: Number(item.weight) })
        ),
        groups: all('SELECT * FROM status_page_group WHERE status_page_id = ? ORDER BY weight, id', [pageId]).map((group) => ({
            id: group.id,
            name: group.name,
            monitors: all(
                'SELECT monitor_id FROM status_page_group_monitor WHERE group_id = ? ORDER BY weight',
                [group.id]
            ).map((item) => Number(item.monitor_id)),
        })),
        maintenanceIds: all('SELECT maintenance_id FROM maintenance_status_page WHERE status_page_id = ?', [pageId]).map(
            (row) => Number(row.maintenance_id)
        ),
    };
}

function saveMaintenance(body, id = null) {
    const existing = id ? get('SELECT * FROM maintenance WHERE id = ?', [id]) : null;
    if (id && !existing) {
        throw new ApiError(404, 'Pemeliharaan tidak ditemukan');
    }
    const source = { ...(existing ? shapeMaintenance(existing) : {}), ...body };
    const title = String(source.title || '').trim();
    if (!title) {
        throw new ApiError(400, 'Judul pemeliharaan wajib diisi');
    }
    const strategy = ['once', 'daily', 'weekly'].includes(source.strategy) ? source.strategy : 'once';
    let startAt = Number(source.startAt);
    let endAt = Number(source.endAt);
    if (!Number.isFinite(startAt) || startAt <= 0) {
        throw new ApiError(400, 'Waktu mulai wajib diisi');
    }
    if (!Number.isFinite(endAt) || endAt <= startAt) {
        throw new ApiError(400, 'Waktu selesai harus setelah waktu mulai');
    }
    let maintenanceId = id;
    transaction(() => {
        if (id) {
            run(
                `UPDATE maintenance SET title=?, description=?, strategy=?, start_at=?, end_at=?, timezone=?, active=?, updated_at=?
                 WHERE id=?`,
                [
                    title.slice(0, 150), String(source.description || '').slice(0, 2000), strategy, startAt, endAt,
                    String(source.timezone || 'Asia/Jakarta'), bool(source.active, true) ? 1 : 0, now(), id,
                ]
            );
        } else {
            const info = run(
                `INSERT INTO maintenance (title, description, strategy, start_at, end_at, timezone, active, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                    title.slice(0, 150), String(source.description || '').slice(0, 2000), strategy, startAt, endAt,
                    String(source.timezone || 'Asia/Jakarta'), bool(source.active, true) ? 1 : 0, now(), now(),
                ]
            );
            maintenanceId = Number(info.lastInsertRowid);
        }
        if (Array.isArray(body.monitorIds)) {
            run('DELETE FROM maintenance_monitor WHERE maintenance_id = ?', [maintenanceId]);
            for (const monitorId of body.monitorIds) {
                if (get('SELECT id FROM monitor WHERE id = ?', [Number(monitorId)])) {
                    run('INSERT OR IGNORE INTO maintenance_monitor (maintenance_id, monitor_id) VALUES (?, ?)', [
                        maintenanceId, Number(monitorId),
                    ]);
                }
            }
        }
        if (Array.isArray(body.statusPageIds)) {
            run('DELETE FROM maintenance_status_page WHERE maintenance_id = ?', [maintenanceId]);
            for (const pageId of body.statusPageIds) {
                if (get('SELECT id FROM status_page WHERE id = ?', [Number(pageId)])) {
                    run('INSERT OR IGNORE INTO maintenance_status_page (maintenance_id, status_page_id) VALUES (?, ?)', [
                        maintenanceId, Number(pageId),
                    ]);
                }
            }
        }
    });
    return maintenanceDetail(maintenanceId);
}

function maintenanceDetail(id) {
    const row = get('SELECT * FROM maintenance WHERE id = ?', [id]);
    if (!row) {
        return null;
    }
    return {
        ...shapeMaintenance(row),
        monitorIds: all('SELECT monitor_id FROM maintenance_monitor WHERE maintenance_id = ?', [id]).map((item) =>
            Number(item.monitor_id)
        ),
        statusPageIds: all('SELECT status_page_id FROM maintenance_status_page WHERE maintenance_id = ?', [id]).map((item) =>
            Number(item.status_page_id)
        ),
    };
}

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

async function handleApi(req, res, url, readBody) {
    const method = req.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const mutation = !['GET', 'HEAD'].includes(method);

    if (path.startsWith('/api') && mutation && !sameOrigin(req)) {
        return error(res, 403, 'Origin tidak diizinkan');
    }

    try {
        // ---------- public ----------
        if (path === '/api/health' && method === 'GET') {
            return sendJson(res, 200, { ok: true, name: 'Uptime Prasasti Websites', time: now() });
        }

        if (path === '/api/setup' && method === 'GET') {
            return sendJson(res, 200, { needSetup: countUsers() === 0 });
        }

        if (path === '/api/setup' && method === 'POST') {
            if (countUsers() > 0) {
                throw new ApiError(400, 'Setup sudah selesai');
            }
            const body = await readBody(req);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            if (username.length < 3) {
                throw new ApiError(400, 'Username minimal 3 karakter');
            }
            if (password.length < 8) {
                throw new ApiError(400, 'Kata sandi minimal 8 karakter');
            }
            const info = run('INSERT INTO user (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)', [
                username,
                await hashPassword(password),
                now(),
            ]);
            const userId = Number(info.lastInsertRowid);
            const session = createSession(userId, {
                remember: true,
                ip: clientIp(req),
                userAgent: req.headers['user-agent'],
            });
            res.setHeader('Set-Cookie', sessionCookie(session.token, session.expires));
            return sendJson(res, 201, { user: { id: userId, username } });
        }

        if (path === '/api/login' && method === 'POST') {
            const body = await readBody(req);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            const ip = clientIp(req);
            if (isThrottled(ip, username)) {
                throw new ApiError(429, 'Terlalu banyak percobaan. Coba lagi dalam 10 menit.');
            }
            const user = getUserByName(username);
            const ok = user && user.active ? await verifyPassword(password, user.password_hash) : false;
            if (!ok) {
                recordFailure(ip, username);
                throw new ApiError(401, 'Username atau kata sandi salah');
            }
            clearFailures(ip, username);
            const session = createSession(user.id, {
                remember: Boolean(body.remember),
                ip,
                userAgent: req.headers['user-agent'],
            });
            res.setHeader('Set-Cookie', sessionCookie(session.token, session.expires));
            return sendJson(res, 200, { user: { id: user.id, username: user.username } });
        }

        if (path === '/api/logout' && method === 'POST') {
            const cookies = parseCookies(req.headers.cookie);
            destroySession(cookies.prasasti_sid);
            res.setHeader('Set-Cookie', clearCookie());
            return sendJson(res, 200, { ok: true });
        }

        if (path === '/api/session' && method === 'GET') {
            const user = currentUser(req);
            return sendJson(res, 200, { user: user || null, needSetup: countUsers() === 0 });
        }

        if (path.startsWith('/api/status-page/') && method === 'GET') {
            const slug = decodeURIComponent(path.slice('/api/status-page/'.length));
            const row = get('SELECT * FROM status_page WHERE slug = ?', [slug]);
            if (!row || !row.published) {
                throw new ApiError(404, 'Status page tidak ditemukan');
            }
            return sendJson(res, 200, statusPagePayload(row));
        }

        if (path.startsWith('/api/push/') && ['GET', 'POST'].includes(method)) {
            const token = path.slice('/api/push/'.length);
            const row = get("SELECT * FROM monitor WHERE push_token = ? AND type = 'push'", [token]);
            if (!row) {
                throw new ApiError(404, 'Token push tidak dikenal');
            }
            let body = {};
            if (method === 'POST') {
                body = await readBody(req).catch(() => ({}));
            }
            const query = Object.fromEntries(url.searchParams.entries());
            const status = body.status || query.status || 'up';
            const msg = body.msg || body.message || query.msg || 'Heartbeat push diterima';
            const ping = body.ping || query.ping || null;
            const monitor = shapeMonitor(row);
            const beat = engine.push(monitor, { status, msg, ping });
            return sendJson(res, 200, { ok: true, monitorId: monitor.id, beat });
        }

        if (path.startsWith('/api/badge/') && method === 'GET') {
            const parts = path.split('/').filter(Boolean); // api, badge, id, status|uptime, hours?
            const monitorId = Number(parts[2]);
            const kind = parts[3] || 'status';
            const monitor = get('SELECT * FROM monitor WHERE id = ?', [monitorId]);
            if (!monitor) {
                throw new ApiError(404, 'Monitor tidak ditemukan');
            }
            const summary = engine.summary(monitor, { beatLimit: 30 });
            let label = 'uptime';
            let value = 'unknown';
            let color = '#8a7a5c';
            if (kind === 'uptime') {
                const hours = parts[4] ? Number(String(parts[4]).replace('h', '')) : 24;
                const uptime = engine.uptime(monitorId, now() - clamp(hours, 1, 8760, 24) * 3600000);
                value = uptime.uptime === null ? 'no data' : `${uptime.uptime.toFixed(2)}%`;
                color = uptime.uptime !== null && uptime.uptime >= 99 ? '#2f9e74' : uptime.uptime >= 95 ? '#a9793f' : '#b8452f';
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
            return sendText(res, 200, badgeSvg(label, value, color), 'image/svg+xml');
        }

        // ---------- authenticated ----------
        const user = requireUser(req);

        if (path === '/api/bootstrap' && method === 'GET') {
            const settings = getSettings();
            const statusPages = all('SELECT * FROM status_page ORDER BY title').map((row) => adminStatusPage(row.id));
            return sendJson(res, 200, {
                user,
                settings,
                monitors: engine.summaries(),
                tags: all('SELECT * FROM tag ORDER BY name'),
                notifications: all('SELECT * FROM notification ORDER BY name').map(notificationPayload),
                statusPages,
                maintenances: all('SELECT * FROM maintenance ORDER BY start_at DESC').map((row) => maintenanceDetail(row.id)),
                incidents: all('SELECT * FROM incident ORDER BY started_at DESC LIMIT 100').map(shapeIncident),
                stats: engine.stats(),
                serverTime: now(),
                version: '1.0.0',
            });
        }

        if (path === '/api/monitors' && method === 'GET') {
            return sendJson(res, 200, { monitors: engine.summaries(), stats: engine.stats() });
        }

        if (path === '/api/monitors' && method === 'POST') {
            const body = await readBody(req);
            const monitor = saveMonitor(body);
            engine.bus.emit('monitors:changed', { id: monitor.id });
            return sendJson(res, 201, { monitor: engine.summary(get('SELECT * FROM monitor WHERE id = ?', [monitor.id])) });
        }

        if (path === '/api/stats' && method === 'GET') {
            return sendJson(res, 200, engine.stats());
        }

        const monitorMatch = path.match(/^\/api\/monitors\/(\d+)(?:\/([a-z-]+))?$/);
        if (monitorMatch) {
            const monitorId = Number(monitorMatch[1]);
            const action = monitorMatch[2];
            const row = get('SELECT * FROM monitor WHERE id = ?', [monitorId]);
            if (!row) {
                throw new ApiError(404, 'Monitor tidak ditemukan');
            }
            const monitor = shapeMonitor(row);

            if (!action && method === 'GET') {
                const summary = engine.summary(row);
                const nowTs = now();
                return sendJson(res, 200, {
                    monitor: summary,
                    uptime: {
                        '24h': engine.uptime(monitorId, nowTs - 86400000),
                        '7d': engine.uptime(monitorId, nowTs - 7 * 86400000),
                        '30d': engine.uptime(monitorId, nowTs - 30 * 86400000),
                        '365d': engine.uptime(monitorId, nowTs - 365 * 86400000),
                    },
                    events: all(
                        'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT 50',
                        [monitorId]
                    ).map(shapeBeat),
                    incidents: all(
                        'SELECT * FROM incident WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 20',
                        [monitorId]
                    ).map(shapeIncident),
                    chart: engine.chart(monitorId, 24),
                });
            }

            if (!action && method === 'PATCH') {
                const body = await readBody(req);
                saveMonitor(body, monitorId);
                engine.bus.emit('monitors:changed', { id: monitorId });
                return sendJson(res, 200, { monitor: engine.summary(get('SELECT * FROM monitor WHERE id = ?', [monitorId])) });
            }

            if (!action && method === 'DELETE') {
                run('DELETE FROM monitor WHERE id = ?', [monitorId]);
                engine.unschedule(monitorId);
                engine.bus.emit('monitors:changed', { id: monitorId, deleted: true });
                return sendJson(res, 200, { ok: true });
            }

            if (action === 'pause' && method === 'POST') {
                run('UPDATE monitor SET active = 0, updated_at = ? WHERE id = ?', [now(), monitorId]);
                engine.unschedule(monitorId);
                engine.bus.emit('monitors:changed', { id: monitorId });
                return sendJson(res, 200, { ok: true });
            }

            if (action === 'resume' && method === 'POST') {
                run('UPDATE monitor SET active = 1, updated_at = ? WHERE id = ?', [now(), monitorId]);
                engine.schedule(monitor);
                engine.bus.emit('monitors:changed', { id: monitorId });
                return sendJson(res, 200, { ok: true });
            }

            if (action === 'check' && method === 'POST') {
                const beat = await engine.performCheck(monitor, { manual: true });
                return sendJson(res, 200, {
                    beat,
                    summary: engine.summary(get('SELECT * FROM monitor WHERE id = ?', [monitorId])),
                });
            }

            if (action === 'chart' && method === 'GET') {
                const hours = clamp(url.searchParams.get('hours'), 1, 8760, 24);
                return sendJson(res, 200, { chart: engine.chart(monitorId, hours) });
            }

            if (action === 'beats' && method === 'GET') {
                const limit = clamp(url.searchParams.get('limit'), 1, 1000, 100);
                return sendJson(res, 200, { beats: engine.beats(monitorId, limit) });
            }

            if (action === 'events' && method === 'GET') {
                const offset = clamp(url.searchParams.get('offset'), 0, 100000, 0);
                const limit = clamp(url.searchParams.get('limit'), 1, 200, 20);
                const events = all(
                    'SELECT * FROM heartbeat WHERE monitor_id = ? ORDER BY time DESC LIMIT ? OFFSET ?',
                    [monitorId, limit, offset]
                ).map(shapeBeat);
                const total = get('SELECT COUNT(*) AS total FROM heartbeat WHERE monitor_id = ?', [monitorId]).total;
                return sendJson(res, 200, { events, total: Number(total) });
            }

            if (action === 'reset-token' && method === 'POST') {
                const token = randomToken(12);
                run('UPDATE monitor SET push_token = ? WHERE id = ?', [token, monitorId]);
                return sendJson(res, 200, { pushToken: token });
            }
        }

        if (path === '/api/tags' && method === 'GET') {
            return sendJson(res, 200, { tags: all('SELECT * FROM tag ORDER BY name') });
        }

        if (path === '/api/tags' && method === 'POST') {
            const body = await readBody(req);
            const name = String(body.name || '').trim();
            if (!name) {
                throw new ApiError(400, 'Nama tag wajib diisi');
            }
            const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#a8825a';
            const existing = get('SELECT * FROM tag WHERE name = ?', [name]);
            if (existing) {
                return sendJson(res, 200, { tag: existing });
            }
            const info = run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [name.slice(0, 40), color, now()]);
            return sendJson(res, 201, { tag: get('SELECT * FROM tag WHERE id = ?', [Number(info.lastInsertRowid)]) });
        }

        const tagMatch = path.match(/^\/api\/tags\/(\d+)$/);
        if (tagMatch) {
            const tagId = Number(tagMatch[1]);
            if (method === 'PATCH') {
                const body = await readBody(req);
                const name = String(body.name || '').trim();
                const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#a8825a';
                if (!name) {
                    throw new ApiError(400, 'Nama tag wajib diisi');
                }
                run('UPDATE tag SET name = ?, color = ? WHERE id = ?', [name.slice(0, 40), color, tagId]);
                return sendJson(res, 200, { tag: get('SELECT * FROM tag WHERE id = ?', [tagId]) });
            }
            if (method === 'DELETE') {
                run('DELETE FROM tag WHERE id = ?', [tagId]);
                return sendJson(res, 200, { ok: true });
            }
        }

        if (path === '/api/notifications' && method === 'GET') {
            return sendJson(res, 200, {
                notifications: all('SELECT * FROM notification ORDER BY name').map(notificationPayload),
            });
        }

        if (path === '/api/notifications' && method === 'POST') {
            const body = await readBody(req);
            return sendJson(res, 201, { notification: saveNotification(body) });
        }

        const notificationMatch = path.match(/^\/api\/notifications\/(\d+)(?:\/(test))?$/);
        if (notificationMatch) {
            const notificationId = Number(notificationMatch[1]);
            const action = notificationMatch[2];
            const row = get('SELECT * FROM notification WHERE id = ?', [notificationId]);
            if (!row) {
                throw new ApiError(404, 'Notifikasi tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(req);
                return sendJson(res, 200, { notification: saveNotification(body, notificationId) });
            }
            if (!action && method === 'DELETE') {
                run('DELETE FROM notification WHERE id = ?', [notificationId]);
                return sendJson(res, 200, { ok: true });
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
                run(
                    'INSERT INTO notification_log (notification_id, monitor_id, event, ok, error, created_at) VALUES (?, NULL, ?, 1, ?, ?)',
                    [notificationId, 'test', message || 'OK', now()]
                );
                return sendJson(res, 200, { ok: true, message });
            }
        }

        if (path === '/api/notification-logs' && method === 'GET') {
            return sendJson(res, 200, {
                logs: all(
                    `SELECT l.*, n.name AS notification_name, m.name AS monitor_name
                     FROM notification_log l
                     LEFT JOIN notification n ON n.id = l.notification_id
                     LEFT JOIN monitor m ON m.id = l.monitor_id
                     ORDER BY l.created_at DESC LIMIT 60`
                ),
            });
        }

        if (path === '/api/status-pages' && method === 'GET') {
            return sendJson(res, 200, {
                statusPages: all('SELECT * FROM status_page ORDER BY title').map((row) => adminStatusPage(row.id)),
            });
        }

        if (path === '/api/status-pages' && method === 'POST') {
            const body = await readBody(req);
            return sendJson(res, 201, { statusPage: saveStatusPage(body) });
        }

        const pageMatch = path.match(/^\/api\/status-pages\/(\d+)(?:\/(publish))?$/);
        if (pageMatch) {
            const pageId = Number(pageMatch[1]);
            const action = pageMatch[2];
            const row = get('SELECT * FROM status_page WHERE id = ?', [pageId]);
            if (!row) {
                throw new ApiError(404, 'Status page tidak ditemukan');
            }
            if (!action && method === 'GET') {
                return sendJson(res, 200, { statusPage: adminStatusPage(pageId) });
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(req);
                return sendJson(res, 200, { statusPage: saveStatusPage(body, pageId) });
            }
            if (!action && method === 'DELETE') {
                run('DELETE FROM status_page WHERE id = ?', [pageId]);
                return sendJson(res, 200, { ok: true });
            }
            if (action === 'publish' && method === 'POST') {
                const body = await readBody(req).catch(() => ({}));
                const published = body.published === undefined ? !row.published : Boolean(body.published);
                run('UPDATE status_page SET published = ? WHERE id = ?', [published ? 1 : 0, pageId]);
                return sendJson(res, 200, { ok: true, published });
            }
        }

        if (path === '/api/incidents' && method === 'GET') {
            const pageId = url.searchParams.get('statusPageId');
            const rows = pageId
                ? all('SELECT * FROM incident WHERE status_page_id = ? ORDER BY started_at DESC LIMIT 200', [Number(pageId)])
                : all('SELECT * FROM incident ORDER BY started_at DESC LIMIT 200');
            return sendJson(res, 200, { incidents: rows.map(shapeIncident) });
        }

        if (path === '/api/incidents' && method === 'POST') {
            const body = await readBody(req);
            const title = String(body.title || '').trim();
            if (!title) {
                throw new ApiError(400, 'Judul insiden wajib diisi');
            }
            const pageId = body.statusPageId ? Number(body.statusPageId) : null;
            const monitorId = body.monitorId ? Number(body.monitorId) : null;
            const startedAt = Number(body.startedAt) || now();
            const style = ['info', 'warning', 'danger', 'success'].includes(body.style) ? body.style : 'warning';
            const info = run(
                `INSERT INTO incident (monitor_id, status_page_id, title, content, style, started_at, pinned, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    monitorId, pageId, title.slice(0, 200), String(body.content || '').slice(0, 5000), style,
                    startedAt, bool(body.pinned) ? 1 : 0, now(),
                ]
            );
            const incident = shapeIncident(get('SELECT * FROM incident WHERE id = ?', [Number(info.lastInsertRowid)]));
            engine.bus.emit('incident:new', { id: incident.id, manual: true });
            return sendJson(res, 201, { incident });
        }

        const incidentMatch = path.match(/^\/api\/incidents\/(\d+)(?:\/(resolve|pin))?$/);
        if (incidentMatch) {
            const incidentId = Number(incidentMatch[1]);
            const action = incidentMatch[2];
            const row = get('SELECT * FROM incident WHERE id = ?', [incidentId]);
            if (!row) {
                throw new ApiError(404, 'Insiden tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(req);
                const title = String(body.title ?? row.title).trim();
                run(
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
                engine.bus.emit('incident:new', { id: incidentId, manual: true });
                return sendJson(res, 200, { incident: shapeIncident(get('SELECT * FROM incident WHERE id = ?', [incidentId])) });
            }
            if (!action && method === 'DELETE') {
                run('DELETE FROM incident WHERE id = ?', [incidentId]);
                engine.bus.emit('incident:new', { id: incidentId, manual: true });
                return sendJson(res, 200, { ok: true });
            }
            if (action === 'resolve' && method === 'POST') {
                run('UPDATE incident SET resolved_at = ? WHERE id = ?', [now(), incidentId]);
                engine.bus.emit('incident:new', { id: incidentId, manual: true });
                return sendJson(res, 200, { ok: true });
            }
            if (action === 'pin' && method === 'POST') {
                run('UPDATE incident SET pinned = ? WHERE id = ?', [row.pinned ? 0 : 1, incidentId]);
                return sendJson(res, 200, { ok: true });
            }
        }

        if (path === '/api/maintenances' && method === 'GET') {
            return sendJson(res, 200, {
                maintenances: all('SELECT * FROM maintenance ORDER BY start_at DESC').map((row) => maintenanceDetail(row.id)),
            });
        }

        if (path === '/api/maintenances' && method === 'POST') {
            const body = await readBody(req);
            return sendJson(res, 201, { maintenance: saveMaintenance(body) });
        }

        const maintenanceMatch = path.match(/^\/api\/maintenances\/(\d+)(?:\/(pause|resume))?$/);
        if (maintenanceMatch) {
            const maintenanceId = Number(maintenanceMatch[1]);
            const action = maintenanceMatch[2];
            const row = get('SELECT * FROM maintenance WHERE id = ?', [maintenanceId]);
            if (!row) {
                throw new ApiError(404, 'Pemeliharaan tidak ditemukan');
            }
            if (!action && method === 'PATCH') {
                const body = await readBody(req);
                return sendJson(res, 200, { maintenance: saveMaintenance(body, maintenanceId) });
            }
            if (!action && method === 'DELETE') {
                run('DELETE FROM maintenance WHERE id = ?', [maintenanceId]);
                return sendJson(res, 200, { ok: true });
            }
            if (action === 'pause' && method === 'POST') {
                run('UPDATE maintenance SET active = 0 WHERE id = ?', [maintenanceId]);
                return sendJson(res, 200, { ok: true });
            }
            if (action === 'resume' && method === 'POST') {
                run('UPDATE maintenance SET active = 1 WHERE id = ?', [maintenanceId]);
                return sendJson(res, 200, { ok: true });
            }
        }

        if (path === '/api/settings' && method === 'GET') {
            return sendJson(res, 200, { settings: getSettings() });
        }

        if (path === '/api/settings' && method === 'PATCH') {
            const body = await readBody(req);
            const allowed = [
                'title', 'description', 'timezone', 'theme', 'retentionDays', 'certificateExpiryDays',
                'domainExpiryDays', 'heartbeatBarSize', 'showPoweredBy',
            ];
            for (const key of allowed) {
                if (body[key] !== undefined) {
                    setSetting(key, String(body[key]).slice(0, 2000));
                }
            }
            engine.reloadSettings();
            engine.bus.emit('settings:changed', getSettings());
            return sendJson(res, 200, { settings: getSettings() });
        }

        if (path === '/api/password' && method === 'POST') {
            const body = await readBody(req);
            const row = get('SELECT * FROM user WHERE id = ?', [user.id]);
            const ok = await verifyPassword(String(body.current || ''), row.password_hash);
            if (!ok) {
                throw new ApiError(400, 'Kata sandi saat ini salah');
            }
            const next = String(body.next || '');
            if (next.length < 8) {
                throw new ApiError(400, 'Kata sandi baru minimal 8 karakter');
            }
            run('UPDATE user SET password_hash = ? WHERE id = ?', [await hashPassword(next), user.id]);
            const cookies = parseCookies(req.headers.cookie);
            destroyOtherSessions(user.id, cookies.prasasti_sid);
            return sendJson(res, 200, { ok: true });
        }

        if (path === '/api/users' && method === 'POST') {
            const body = await readBody(req);
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            if (username.length < 3 || password.length < 8) {
                throw new ApiError(400, 'Username minimal 3 karakter dan sandi minimal 8 karakter');
            }
            if (getUserByName(username)) {
                throw new ApiError(400, 'Username sudah dipakai');
            }
            run('INSERT INTO user (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)', [
                username,
                await hashPassword(password),
                now(),
            ]);
            return sendJson(res, 201, { ok: true });
        }

        if (path === '/api/export' && method === 'GET') {
            const monitors = all('SELECT * FROM monitor').map((row) => ({
                ...shapeMonitor(row),
                tags: engine.tags(row.id).map((tag) => tag.name),
                notificationIds: engine.notificationIds(row.id),
            }));
            return sendJson(res, 200, {
                version: 1,
                exportedAt: new Date().toISOString(),
                settings: getSettings(),
                tags: all('SELECT * FROM tag'),
                notifications: all('SELECT * FROM notification').map(notificationPayload),
                monitors,
                statusPages: all('SELECT * FROM status_page').map((row) => adminStatusPage(row.id)),
                maintenances: all('SELECT * FROM maintenance').map((row) => maintenanceDetail(row.id)),
            });
        }

        if (path === '/api/import' && method === 'POST') {
            const body = await readBody(req);
            const payload = body.data && typeof body.data === 'object' ? body.data : body;
            const imported = { monitors: 0, notifications: 0, statusPages: 0 };
            const tagIds = {};
            for (const tag of payload.tags || []) {
                if (!tag.name) {
                    continue;
                }
                let row = get('SELECT * FROM tag WHERE name = ?', [String(tag.name)]);
                if (!row) {
                    const info = run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [
                        String(tag.name).slice(0, 40), String(tag.color || '#a8825a'), now(),
                    ]);
                    row = get('SELECT * FROM tag WHERE id = ?', [Number(info.lastInsertRowid)]);
                }
                tagIds[tag.id] = row.id;
            }
            const notificationIds = {};
            for (const notification of payload.notifications || []) {
                const saved = saveNotification({
                    name: notification.name,
                    type: notification.type,
                    config: notification.config,
                    active: notification.active,
                });
                notificationIds[notification.id] = saved.id;
                imported.notifications += 1;
            }
            for (const monitor of payload.monitors || []) {
                const saved = saveMonitor({
                    ...monitor,
                    tags: (monitor.tags || []).map((name) => {
                        const found = get('SELECT id FROM tag WHERE name = ?', [String(name)]);
                        if (found) {
                            return found.id;
                        }
                        const info = run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [
                            String(name).slice(0, 40), '#a8825a', now(),
                        ]);
                        return Number(info.lastInsertRowid);
                    }),
                    notificationIds: (monitor.notificationIds || []).map((id) => notificationIds[id]).filter(Boolean),
                });
                imported.monitors += 1;
                void saved;
            }
            for (const page of payload.statusPages || []) {
                saveStatusPage({
                    ...page,
                    groups: (page.groups || []).map((group) => ({ name: group.name, monitors: group.monitors || [] })),
                });
                imported.statusPages += 1;
            }
            engine.rescheduleAll(500);
            return sendJson(res, 200, { ok: true, imported });
        }

        throw new ApiError(404, 'Endpoint tidak ditemukan');
    } catch (caught) {
        if (caught instanceof ApiError) {
            return error(res, caught.status, caught.message);
        }
        console.error('[api]', caught);
        return error(res, 500, caught.message || 'Kesalahan server');
    }
}

module.exports = { handleApi, sendJson };
