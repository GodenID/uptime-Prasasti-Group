/**
 * Helper murni yang dipakai bersama Worker dan Durable Object.
 * Salinan dari server/util.js tanpa bagian khusus Node.js.
 */

export const STATUS = Object.freeze({
    DOWN: 0,
    UP: 1,
    PENDING: 2,
    MAINTENANCE: 3,
});

export const STATUS_NAME = {
    [STATUS.DOWN]: 'down',
    [STATUS.UP]: 'up',
    [STATUS.PENDING]: 'pending',
    [STATUS.MAINTENANCE]: 'maintenance',
};

export const MONITOR_TYPES = Object.freeze([
    'http',
    'keyword',
    'json',
    'tcp',
    'ping',
    'dns',
    'push',
    'group',
    'redis',
    'mqtt',
    'docker',
    'postgres',
]);

export const NOTIFICATION_TYPES = Object.freeze([
    'webhook',
    'discord',
    'telegram',
    'slack',
    'ntfy',
    'gotify',
    'smtp',
    'pushover',
    'homeassistant',
    'apprise',
]);

export const NOTIFICATION_EVENTS = Object.freeze(['down', 'up', 'certificate', 'domain']);

export function now() {
    return Date.now();
}

export function randomToken(bytes = 32) {
    const bytesArray = new Uint8Array(bytes);
    crypto.getRandomValues(bytesArray);
    return [...bytesArray].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function uid() {
    return randomToken(12);
}

export function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

export function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

export function parseJson(value, fallback) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }
    if (typeof value === 'object') {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function normalizeUrl(input) {
    let value = String(input || '').trim();
    if (!value) {
        return '';
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        value = `https://${value}`;
    }
    try {
        const url = new URL(value);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
            return '';
        }
        return url.toString();
    } catch {
        return '';
    }
}

export function hostnameOf(input) {
    const value = String(input || '').trim();
    if (!value) {
        return '';
    }
    try {
        return new URL(value.includes('://') ? value : `http://${value}`).host;
    } catch {
        return value;
    }
}

export function domainOf(input) {
    const host = hostnameOf(input).split(':')[0].toLowerCase();
    if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
        return '';
    }
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) {
        return '';
    }
    const twoLevel = new Set([
        'co.id', 'ac.id', 'go.id', 'or.id', 'net.id', 'web.id', 'sch.id', 'mil.id',
        'co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.jp', 'com.br', 'com.in',
    ]);
    const tail = parts.slice(-2).join('.');
    if (twoLevel.has(tail) && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }
    return tail;
}

export function parseAcceptedCodes(input) {
    const fallback = [[200, 299]];
    if (input === undefined || input === null || String(input).trim() === '') {
        return fallback;
    }
    const ranges = [];
    for (const chunk of String(input).split(',')) {
        const part = chunk.trim();
        if (!part) {
            continue;
        }
        const range = part.match(/^(\d{3})\s*-\s*(\d{3})$/);
        if (range) {
            ranges.push([Number(range[1]), Number(range[2])]);
            continue;
        }
        if (/^\d{3}$/.test(part)) {
            ranges.push([Number(part), Number(part)]);
        }
    }
    return ranges.length ? ranges : fallback;
}

export function statusFromAccepted(code, accepted) {
    return accepted.some(([min, max]) => code >= min && code <= max);
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
        return '0d';
    }
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
}

export function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function safeEqual(a, b) {
    const bufA = new TextEncoder().encode(String(a));
    const bufB = new TextEncoder().encode(String(b));
    if (bufA.length !== bufB.length) {
        return false;
    }
    let diff = 0;
    for (let index = 0; index < bufA.length; index += 1) {
        diff |= bufA[index] ^ bufB[index];
    }
    return diff === 0;
}

/**
 * Subset JSONPath: $.a.b, $['a'], $.items[0].name, $.items[*].name
 */
export function queryJson(payload, expression) {
    const path = String(expression || '').trim();
    if (!path || path === '$') {
        return { found: true, value: payload };
    }
    const tokens = [];
    let index = path.startsWith('$') ? 1 : 0;
    if (index === 1 && path[1] === '.') {
        index = 2;
    }
    while (index < path.length) {
        const char = path[index];
        if (char === '.') {
            index += 1;
            continue;
        }
        if (char === '[') {
            const close = path.indexOf(']', index);
            if (close === -1) {
                return { found: false };
            }
            const raw = path.slice(index + 1, close).replace(/^['"]|['"]$/g, '');
            tokens.push(raw === '*' ? '*' : /^\d+$/.test(raw) ? Number(raw) : raw);
            index = close + 1;
            continue;
        }
        let end = index;
        while (end < path.length && path[end] !== '.' && path[end] !== '[') {
            end += 1;
        }
        tokens.push(path.slice(index, end));
        index = end;
    }

    let current = payload;
    for (const token of tokens) {
        if (token === '*') {
            return { found: true, value: current };
        }
        if (current === null || current === undefined) {
            return { found: false };
        }
        if (typeof token === 'number') {
            if (!Array.isArray(current) || token >= current.length) {
                return { found: false };
            }
            current = current[token];
            continue;
        }
        if (typeof current !== 'object' || !(token in current)) {
            return { found: false };
        }
        current = current[token];
    }
    return { found: true, value: current };
}

export function percent(up, total) {
    if (!total) {
        return null;
    }
    return Number(((up / total) * 100).toFixed(4));
}

/**
 * Awal hari UTC. Bucket harian memakai batas UTC supaya agregat uptime
 * tidak bergantung pada zona waktu server.
 */
export function floorToDay(timestamp) {
    return Math.floor(Number(timestamp) / 86400000) * 86400000;
}
