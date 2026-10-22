/**
 * Bentuk data API. Fungsi murni, dipakai Worker dan Durable Object.
 */

import { parseJson, STATUS } from './util.js';

/**
 * Terima baris basis data (snake_case) maupun bentuk API (camelCase).
 */
function normalize(row) {
    const pairs = [
        ['retry_interval', 'retryInterval'],
        ['upside_down', 'upsideDown'],
        ['json_path', 'jsonPath'],
        ['expected_value', 'expectedValue'],
        ['accepted_codes', 'acceptedCodes'],
        ['max_redirects', 'maxRedirects'],
        ['ignore_tls', 'ignoreTls'],
        ['cert_expiry_notification', 'certExpiryNotification'],
        ['domain_expiry_notification', 'domainExpiryNotification'],
        ['dns_record_type', 'dnsRecordType'],
        ['dns_resolver', 'dnsResolver'],
        ['parent_id', 'parentId'],
        ['push_token', 'pushToken'],
        ['created_at', 'createdAt'],
        ['updated_at', 'updatedAt'],
    ];
    const result = { ...row };
    for (const [snake, camel] of pairs) {
        if (result[snake] === undefined && result[camel] !== undefined) {
            result[snake] = result[camel];
        }
    }
    return result;
}

export function shapeMonitor(row) {
    if (!row) {
        return null;
    }
    row = normalize(row);
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        url: row.url || '',
        hostname: row.hostname || '',
        port: row.port === null || row.port === undefined ? null : Number(row.port),
        method: row.method || 'GET',
        headers: row.headers || '',
        body: row.body || '',
        interval: Number(row.interval),
        retries: Number(row.retries),
        retryInterval: Number(row.retry_interval),
        timeout: Number(row.timeout),
        upsideDown: Boolean(row.upside_down),
        keyword: row.keyword || '',
        jsonPath: row.json_path || '',
        expectedValue: row.expected_value || '',
        acceptedCodes: row.accepted_codes || '',
        maxRedirects: Number(row.max_redirects),
        ignoreTls: Boolean(row.ignore_tls),
        certExpiryNotification: Boolean(row.cert_expiry_notification),
        domainExpiryNotification: Boolean(row.domain_expiry_notification),
        dnsRecordType: row.dns_record_type || 'A',
        dnsResolver: row.dns_resolver || '',
        options: parseJson(row.options, {}),
        parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
        description: row.description || '',
        active: Boolean(row.active),
        pushToken: row.push_token || null,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}

export function shapeNotification(row) {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        config: parseJson(row.config, {}),
        active: Boolean(row.active),
        isDefault: Boolean(row.is_default),
        events: String(row.events || '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        resendInterval: Number(row.resend_interval || 0),
        createdAt: Number(row.created_at),
    };
}

export function shapeStatusPage(row) {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description || '',
        icon: row.icon || '/favicon.svg',
        theme: row.theme || 'stone',
        published: Boolean(row.published),
        showTags: Boolean(row.show_tags),
        showPoweredBy: Boolean(row.show_powered_by),
        footerText: row.footer_text || '',
        customCss: row.custom_css || '',
        domain: row.domain || '',
        announcement: row.announcement || '',
        lang: row.lang || 'id',
        createdAt: Number(row.created_at),
    };
}

export function shapeIncident(row) {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        monitorId: row.monitor_id === null ? null : Number(row.monitor_id),
        statusPageId: row.status_page_id === null ? null : Number(row.status_page_id),
        title: row.title,
        content: row.content || '',
        style: row.style || 'warning',
        startedAt: Number(row.started_at),
        resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
        pinned: Boolean(row.pinned),
        createdAt: Number(row.created_at),
    };
}

export function shapeMaintenance(row) {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        title: row.title,
        description: row.description || '',
        strategy: row.strategy || 'once',
        startAt: Number(row.start_at),
        endAt: Number(row.end_at),
        timezone: row.timezone || 'Asia/Jakarta',
        active: Boolean(row.active),
        createdAt: Number(row.created_at),
    };
}

export function shapeBeat(row) {
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        monitorId: Number(row.monitor_id),
        status: Number(row.status),
        msg: row.msg || '',
        ping: row.ping === null || row.ping === undefined ? null : Number(row.ping),
        time: Number(row.time),
        important: Boolean(row.important),
        duration: Number(row.duration || 0),
        certInfo: parseJson(row.cert_info, null),
    };
}

const STATUS_TEXT = {
    [STATUS.UP]: 'Operasional',
    [STATUS.DOWN]: 'Gangguan',
    [STATUS.PENDING]: 'Menunggu',
    [STATUS.MAINTENANCE]: 'Pemeliharaan',
};

export function statusName(status) {
    return STATUS_TEXT[status] || 'Tidak diketahui';
}
