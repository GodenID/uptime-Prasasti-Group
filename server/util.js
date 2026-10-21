'use strict';

const crypto = require('node:crypto');

const STATUS = Object.freeze({
    DOWN: 0,
    UP: 1,
    PENDING: 2,
    MAINTENANCE: 3,
});

const STATUS_NAME = {
    [STATUS.DOWN]: 'down',
    [STATUS.UP]: 'up',
    [STATUS.PENDING]: 'pending',
    [STATUS.MAINTENANCE]: 'maintenance',
};

const MONITOR_TYPES = Object.freeze([
    'http',
    'keyword',
    'json',
    'tcp',
    'ping',
    'dns',
    'push',
    'group',
]);

const NOTIFICATION_TYPES = Object.freeze([
    'webhook',
    'discord',
    'telegram',
    'slack',
    'ntfy',
    'gotify',
    'smtp',
]);

const REGIONS = {
    'id': 'Asia/Jakarta',
};

function now() {
    return Date.now();
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function uid() {
    return crypto.randomBytes(9).toString('base64url');
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, number));
}

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function parseJson(value, fallback) {
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

function normalizeUrl(input) {
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

function hostnameOf(input) {
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

function domainOf(input) {
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
        'co.uk', 'org.uk', 'ac.uk', 'com.au', 'co.jp', 'com.br', 'co.in',
    ]);
    const tail = parts.slice(-2).join('.');
    if (twoLevel.has(tail) && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }
    return tail;
}

function parseAcceptedCodes(input) {
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

function statusFromAccepted(code, accepted) {
    return accepted.some(([min, max]) => code >= min && code <= max);
}

function formatDuration(ms) {
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

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Minimal JSONPath subset: $.a.b, $['a'], $.items[0].name, $.items[*].name
 */
function queryJson(payload, expression) {
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

function percent(up, total) {
    if (!total) {
        return null;
    }
    return Number(((up / total) * 100).toFixed(4));
}

function floorToDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

module.exports = {
    STATUS,
    STATUS_NAME,
    MONITOR_TYPES,
    NOTIFICATION_TYPES,
    now,
    randomToken,
    uid,
    clamp,
    bool,
    parseJson,
    normalizeUrl,
    hostnameOf,
    domainOf,
    parseAcceptedCodes,
    statusFromAccepted,
    formatDuration,
    escapeHtml,
    safeEqual,
    queryJson,
    percent,
    floorToDay,
    REGIONS,
};
