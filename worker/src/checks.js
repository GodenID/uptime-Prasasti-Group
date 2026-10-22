/**
 * Pemeriksaan monitor di Workers.
 *
 * HTTP, kata kunci, dan JSON memakai fetch. DNS memakai DNS-over-HTTPS karena
 * Workers tidak punya UDP. Pemeriksaan berbasis TCP (port, Redis, MQTT,
 * PostgreSQL) memakai Sockets API dan hanya tersedia di Workers Paid.
 * ICMP ping dan Docker tidak mungkin di Workers dan dilaporkan sebagai
 * tidak tersedia.
 */

import {
    STATUS,
    normalizeUrl,
    parseJson,
    parseAcceptedCodes,
    statusFromAccepted,
    queryJson,
    domainOf,
} from './util.js';
import { redisCommand, mqttProbe, postgresQuery, tcpProbe } from './protocols.js';

const MAX_BODY = 2 * 1024 * 1024;
const USER_AGENT =
    'Mozilla/5.0 (compatible; UptimePrasasti/1.0; +https://github.com/GodenID/uptime-Prasasti-Group)';

const DOMAIN_CACHE = new Map();
const DOMAIN_TTL = 6 * 60 * 60 * 1000;

function statusFor(monitor, ok) {
    const inverted = Boolean(monitor.upsideDown);
    const effective = inverted ? !ok : ok;
    return effective ? STATUS.UP : STATUS.DOWN;
}

export function monitorOptions(monitor) {
    const raw = monitor.options;
    if (!raw) {
        return {};
    }
    if (typeof raw === 'object') {
        return raw;
    }
    const parsed = parseJson(raw, null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function buildHeaders(monitor) {
    const headers = { ...(parseJson(monitor.headers, {}) || {}) };
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/^[A-Za-z0-9!#$%&'*+.^`_|~-]+$/.test(key)) {
            normalized[key] = String(value);
        }
    }
    return normalized;
}

async function readLimited(response) {
    if (!response.body) {
        return { text: '', truncated: false };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let truncated = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        const room = MAX_BODY - size;
        if (value.byteLength > room) {
            if (room > 0) {
                chunks.push(value.subarray(0, room));
                size += room;
            }
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
        }
        chunks.push(value);
        size += value.byteLength;
    }
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(merged), truncated };
}

function friendlyError(error) {
    const message = String((error && error.message) || error || 'Unknown error');
    if (message === 'Timeout' || /timeout|abort/i.test(message)) {
        return 'Timeout';
    }
    const code = error && (error.code || (error.cause && error.cause.code));
    const map = {
        ENOTFOUND: 'DNS tidak ditemukan (ENOTFOUND)',
        ECONNREFUSED: 'Koneksi ditolak (ECONNREFUSED)',
        ECONNRESET: 'Koneksi direset (ECONNRESET)',
        EHOSTUNREACH: 'Host tidak terjangkau (EHOSTUNREACH)',
        ENETUNREACH: 'Jaringan tidak terjangkau (ENETUNREACH)',
        ETIMEDOUT: 'Timeout koneksi',
        EAI_AGAIN: 'DNS sementara gagal (EAI_AGAIN)',
        CERT_HAS_EXPIRED: 'Sertifikat TLS kedaluwarsa',
    };
    if (code && map[code]) {
        return map[code];
    }
    return message.slice(0, 180);
}

/**
 * Permintaan HTTP tanpa mengikuti redirect, lalu redirect diikuti manual
 * supaya batas jumlah hop tetap dikendalikan.
 */
async function requestFollow(urlString, options) {
    const { method = 'GET', headers = {}, body = null, timeout = 15000, maxRedirects = 10 } = options;
    const started = Date.now();
    let current = urlString;
    for (let hop = 0; hop <= Math.max(0, Math.min(20, Number(maxRedirects) || 0)); hop += 1) {
        let response;
        try {
            response = await fetch(current, {
                method,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: '*/*',
                    ...headers,
                },
                body: body && method !== 'GET' && method !== 'HEAD' ? body : undefined,
                redirect: 'manual',
                signal: AbortSignal.timeout(timeout),
            });
        } catch (error) {
            return { error: friendlyError(error) };
        }
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
            try {
                current = new URL(location, current).toString();
                continue;
            } catch {
                return { error: 'Redirect tidak valid' };
            }
        }
        const payload = await readLimited(response);
        return {
            statusCode: response.status || 0,
            statusMessage: response.statusText || '',
            headers: response.headers,
            body: payload.text,
            truncated: payload.truncated,
            elapsed: Date.now() - started,
            finalUrl: current,
            redirects: hop,
        };
    }
    return { error: `Terlalu banyak redirect (>${maxRedirects})` };
}

async function checkHttp(monitor) {
    const url = normalizeUrl(monitor.url);
    if (!url) {
        return { status: STATUS.DOWN, msg: 'URL tidak valid', ping: null };
    }
    const accepted = parseAcceptedCodes(monitor.acceptedCodes);
    const method = String(monitor.method || 'GET').toUpperCase();
    const headers = buildHeaders(monitor);
    const body = monitor.body && method !== 'GET' && method !== 'HEAD' ? monitor.body : null;

    const response = await requestFollow(url, {
        method,
        headers,
        body,
        timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
        maxRedirects: monitor.maxRedirects,
    });

    if (response.error) {
        return { status: STATUS.DOWN, msg: response.error, ping: null };
    }

    const ping = Math.round(response.elapsed);
    const code = response.statusCode;
    const acceptedOk = statusFromAccepted(code, accepted);

    if (monitor.type === 'keyword') {
        const keyword = String(monitor.keyword || '');
        if (!acceptedOk) {
            return { status: statusFor(monitor, false), msg: `HTTP ${code}`, ping };
        }
        if (!keyword) {
            return { status: statusFor(monitor, false), msg: 'Kata kunci kosong', ping };
        }
        const found = response.body.includes(keyword);
        return {
            status: statusFor(monitor, found),
            msg: found ? `Kata kunci ditemukan (${ping} ms)` : 'Kata kunci tidak ditemukan',
            ping,
        };
    }

    if (monitor.type === 'json') {
        if (!acceptedOk) {
            return { status: statusFor(monitor, false), msg: `HTTP ${code}`, ping };
        }
        let payload;
        try {
            payload = JSON.parse(response.body);
        } catch {
            return { status: statusFor(monitor, false), msg: 'Respons bukan JSON valid', ping };
        }
        const result = queryJson(payload, monitor.jsonPath || '$');
        const expected = monitor.expectedValue;
        if (!result.found) {
            return {
                status: statusFor(monitor, false),
                msg: `Path ${monitor.jsonPath} tidak ditemukan`,
                ping,
            };
        }
        if (expected !== null && expected !== undefined && String(expected) !== '') {
            const actual = stringifyValue(result.value);
            const ok = actual === String(expected);
            return {
                status: statusFor(monitor, ok),
                msg: ok ? `Nilai cocok: ${actual}` : `Nilai ${actual} != ${expected}`,
                ping,
            };
        }
        return {
            status: statusFor(monitor, true),
            msg: `JSON OK: ${stringifyValue(result.value).slice(0, 80)}`,
            ping,
        };
    }

    return {
        status: statusFor(monitor, acceptedOk),
        msg: acceptedOk ? `HTTP ${code} - ${response.statusMessage || 'OK'} (${ping} ms)` : `HTTP ${code}`,
        ping,
        httpStatus: code,
    };
}

function stringifyValue(value) {
    if (value === null) {
        return 'null';
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

const DOH_RESOLVERS = {
    cloudflare: { url: 'https://cloudflare-dns.com/dns-query', host: 'cloudflare-dns.com' },
    google: { url: 'https://dns.google/resolve', host: 'dns.google' },
};

function resolverFor(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('8.8.8.8') || text.includes('google')) {
        return DOH_RESOLVERS.google;
    }
    return DOH_RESOLVERS.cloudflare;
}

async function checkDns(monitor) {
    const host = String(monitor.hostname || '').trim();
    if (!host) {
        return { status: STATUS.DOWN, msg: 'Hostname kosong', ping: null };
    }
    const type = String(monitor.dnsRecordType || 'A').toUpperCase();
    const resolver = resolverFor(monitor.dnsResolver);
    const started = Date.now();
    try {
        const response = await fetch(`${resolver.url}?name=${encodeURIComponent(host)}&type=${type}`, {
            headers: { accept: 'application/dns-json' },
            signal: AbortSignal.timeout(8000),
        });
        const payload = await response.json();
        const ping = Date.now() - started;
        const answers = Array.isArray(payload.Answer) ? payload.Answer : [];
        if (!answers.length) {
            return {
                status: statusFor(monitor, false),
                msg: `Tidak ada record ${type}`,
                ping,
                dns: [],
            };
        }
        const records = answers.map((answer) => String(answer.data));
        const expected = String(monitor.expectedValue || '').trim();
        if (expected) {
            const found = records.some((record) => record.includes(expected));
            return {
                status: statusFor(monitor, found),
                msg: found ? `${type} cocok: ${expected}` : `${type} tidak memuat ${expected}`,
                ping,
                dns: records.slice(0, 8),
            };
        }
        return {
            status: statusFor(monitor, true),
            msg: `${type}: ${records.slice(0, 3).join(', ')}`,
            ping,
            dns: records.slice(0, 8),
        };
    } catch (error) {
        return { status: statusFor(monitor, false), msg: friendlyError(error), ping: null, dns: [] };
    }
}

export async function lookupDomainExpiry(domain) {
    if (!domain) {
        return null;
    }
    const cached = DOMAIN_CACHE.get(domain);
    if (cached && Date.now() - cached.at < DOMAIN_TTL) {
        return cached.value;
    }
    try {
        const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
            headers: { Accept: 'application/rdap+json, application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            throw new Error(`RDAP ${response.status}`);
        }
        const payload = await response.json();
        const events = Array.isArray(payload.events) ? payload.events : [];
        const expiration = events.find((event) => event.eventAction === 'expiration');
        const registration = events.find((event) => event.eventAction === 'registration');
        const value = {
            domain,
            expiresAt: expiration && expiration.eventDate ? Date.parse(expiration.eventDate) : null,
            registeredAt: registration && registration.eventDate ? Date.parse(registration.eventDate) : null,
            registrar:
                (Array.isArray(payload.entities) &&
                    payload.entities.find((entity) => (entity.roles || []).includes('registrar'))?.vcardArray?.[1]?.find(
                        (field) => field[0] === 'fn'
                    )?.[3]) ||
                null,
            status: Array.isArray(payload.status) ? payload.status : [],
        };
        DOMAIN_CACHE.set(domain, { at: Date.now(), value });
        return value;
    } catch {
        const value = { domain, expiresAt: null, registeredAt: null, registrar: null, status: [], error: true };
        DOMAIN_CACHE.set(domain, { at: Date.now(), value });
        return value;
    }
}

async function checkRedis(monitor) {
    const options = monitorOptions(monitor);
    const host = String(monitor.hostname || '').trim();
    if (!host) {
        return { status: STATUS.DOWN, msg: 'Hostname wajib diisi', ping: null };
    }
    const result = await redisCommand({
        host,
        port: Number(monitor.port || 6379),
        password: String(options.password || ''),
        db: options.db === undefined || options.db === '' ? null : Number(options.db),
        command: String(options.command || 'PING'),
        expected: String(options.expected || ''),
        timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
    });
    return { status: statusFor(monitor, result.ok), msg: result.message, ping: result.ping };
}

async function checkMqtt(monitor) {
    const options = monitorOptions(monitor);
    const host = String(monitor.hostname || '').trim();
    const topic = String(options.topic || '').trim();
    if (!host) {
        return { status: STATUS.DOWN, msg: 'Hostname wajib diisi', ping: null };
    }
    if (!topic) {
        return { status: STATUS.DOWN, msg: 'Topik MQTT wajib diisi', ping: null };
    }
    const result = await mqttProbe({
        host,
        port: Number(monitor.port || 1883),
        topic,
        username: String(options.username || ''),
        password: String(options.password || ''),
        clientId: String(options.clientId || ''),
        expected: String(options.expected || ''),
        timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
    });
    return { status: statusFor(monitor, result.ok), msg: result.message, ping: result.ping };
}

async function checkPostgres(monitor) {
    const options = monitorOptions(monitor);
    const host = String(monitor.hostname || '').trim();
    if (!host) {
        return { status: STATUS.DOWN, msg: 'Hostname wajib diisi', ping: null };
    }
    const user = String(options.user || 'postgres');
    const result = await postgresQuery({
        host,
        port: Number(monitor.port || 5432),
        user,
        password: String(options.password || ''),
        database: String(options.database || user),
        query: String(options.query || 'SELECT 1'),
        timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
    });
    return { status: statusFor(monitor, result.ok), msg: result.message, ping: result.ping };
}

async function checkTcp(monitor) {
    const host = String(monitor.hostname || '').trim();
    const port = Number(monitor.port);
    if (!host || !port) {
        return { status: STATUS.DOWN, msg: 'Host atau port kosong', ping: null };
    }
    const result = await tcpProbe({
        host,
        port,
        timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
    });
    return { status: statusFor(monitor, result.ok), msg: result.message, ping: result.ping };
}

/**
 * Jalankan satu pemeriksaan. Mengembalikan { status, msg, ping, ... }.
 */
export async function runCheck(monitor) {
    const type = String(monitor.type || '').toLowerCase();
    let result;

    switch (type) {
        case 'http':
        case 'keyword':
        case 'json':
            result = await checkHttp(monitor);
            break;
        case 'dns':
            result = await checkDns(monitor);
            break;
        case 'redis':
            result = await checkRedis(monitor);
            break;
        case 'mqtt':
            result = await checkMqtt(monitor);
            break;
        case 'postgres':
            result = await checkPostgres(monitor);
            break;
        case 'tcp':
            result = await checkTcp(monitor);
            break;
        case 'ping':
            return {
                status: STATUS.PENDING,
                msg: 'ICMP ping tidak tersedia di Cloudflare Workers',
                ping: null,
                skipped: true,
            };
        case 'docker':
            return {
                status: STATUS.PENDING,
                msg: 'Monitor Docker tidak tersedia di Cloudflare Workers',
                ping: null,
                skipped: true,
            };
        case 'push':
            return { status: STATUS.UP, msg: 'Menunggu heartbeat push', ping: null, skipped: true };
        default:
            return { status: STATUS.PENDING, msg: `Tipe ${type} tidak didukung`, ping: null };
    }

    if (monitor.domainExpiryNotification) {
        const domain = domainOf(monitor.url || monitor.hostname || '');
        if (domain) {
            result.domain = await lookupDomainExpiry(domain);
        }
    }

    return result;
}
