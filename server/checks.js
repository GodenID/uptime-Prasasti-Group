'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const {
    STATUS,
    normalizeUrl,
    parseJson,
    parseAcceptedCodes,
    statusFromAccepted,
    queryJson,
    domainOf,
} = require('./util');

const MAX_BODY = 2 * 1024 * 1024;
const USER_AGENT =
    'Mozilla/5.0 (compatible; UptimePrasasti/1.0; +https://github.com/prasasti/uptime)';

/**
 * Monitor dapat masuk sebagai baris basis data (snake_case) atau sebagai bentuk API
 * (camelCase). Pemeriksaan hanya membaca snake_case, jadi samakan lebih dulu.
 */
const FIELD_ALIASES = [
    ['acceptedCodes', 'accepted_codes'],
    ['maxRedirects', 'max_redirects'],
    ['ignoreTls', 'ignore_tls'],
    ['upsideDown', 'upside_down'],
    ['jsonPath', 'json_path'],
    ['expectedValue', 'expected_value'],
    ['dnsRecordType', 'dns_record_type'],
    ['dnsResolver', 'dns_resolver'],
    ['certExpiryNotification', 'cert_expiry_notification'],
    ['domainExpiryNotification', 'domain_expiry_notification'],
    ['retryInterval', 'retry_interval'],
];

function normalizeMonitor(monitor) {
    if (!monitor || typeof monitor !== 'object') {
        return monitor;
    }
    const normalized = { ...monitor };
    for (const [camel, snake] of FIELD_ALIASES) {
        if (normalized[snake] === undefined && normalized[camel] !== undefined) {
            normalized[snake] = normalized[camel];
        }
    }
    return normalized;
}

function decodeBody(buffer, encoding) {
    const value = String(encoding || '').toLowerCase();
    try {
        if (value.includes('br')) {
            return zlib.brotliDecompressSync(buffer);
        }
        if (value.includes('gzip')) {
            return zlib.gunzipSync(buffer);
        }
        if (value.includes('deflate')) {
            try {
                return zlib.inflateSync(buffer);
            } catch {
                return zlib.inflateRawSync(buffer);
            }
        }
    } catch {
        return buffer;
    }
    return buffer;
}

/**
 * Perform a single HTTP request without following redirects.
 */
function requestOnce(urlString, options) {
    const {
        method = 'GET',
        headers = {},
        body = null,
        timeout = 15000,
        ignoreTls = false,
    } = options;

    return new Promise((resolve, reject) => {
        let url;
        try {
            url = new URL(urlString);
        } catch {
            reject(new Error('Invalid URL'));
            return;
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            reject(new Error(`Unsupported protocol ${url.protocol}`));
            return;
        }
        const isHttps = url.protocol === 'https:';
        const transport = isHttps ? https : http;
        const started = performance.now();
        let settled = false;

        const request = transport.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method,
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    ...headers,
                },
                rejectUnauthorized: !ignoreTls,
                servername: isHttps ? url.hostname : undefined,
                timeout,
            },
            (response) => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size <= MAX_BODY) {
                        chunks.push(chunk);
                    }
                });
                response.on('end', () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    const elapsed = performance.now() - started;
                    let certificate = null;
                    try {
                        const socket = response.socket;
                        if (socket && typeof socket.getPeerCertificate === 'function') {
                            certificate = socket.getPeerCertificate();
                        }
                    } catch {
                        certificate = null;
                    }
                    const raw = Buffer.concat(chunks);
                    resolve({
                        statusCode: response.statusCode || 0,
                        statusMessage: response.statusMessage || '',
                        headers: response.headers,
                        body: decodeBody(raw, response.headers['content-encoding']).toString('utf8'),
                        truncated: size > MAX_BODY,
                        elapsed,
                        certificate,
                        finalUrl: url.toString(),
                    });
                });
            }
        );

        request.on('timeout', () => {
            if (settled) {
                return;
            }
            settled = true;
            request.destroy(new Error('Timeout'));
        });

        request.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            reject(error);
        });

        if (body) {
            request.write(body);
        }
        request.end();
    });
}

async function requestFollow(urlString, options) {
    const maxRedirects = Math.max(0, Math.min(20, Number(options.maxRedirects ?? 10)));
    let current = urlString;
    let response = null;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        response = await requestOnce(current, options);
        const location = response.headers.location;
        if (response.statusCode >= 300 && response.statusCode < 400 && location) {
            const next = new URL(location, current).toString();
            if (new URL(next).protocol !== new URL(current).protocol && hop === 0) {
                // allow protocol switches, but keep TLS settings consistent
            }
            current = next;
            continue;
        }
        response.finalUrl = current;
        response.redirects = hop;
        return response;
    }
    throw new Error(`Too many redirects (>${maxRedirects})`);
}

function certificateInfo(certificate) {
    if (!certificate || !certificate.valid_to) {
        return null;
    }
    const validTo = new Date(certificate.valid_to);
    const validFrom = new Date(certificate.valid_from);
    const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / 86400000);
    const issuer = certificate.issuer || {};
    const subject = certificate.subject || {};
    return {
        subject: subject.CN || certificate.subjectaltname || '',
        issuer: issuer.O || issuer.CN || '',
        validFrom: Number.isNaN(validFrom.getTime()) ? null : validFrom.toISOString(),
        validTo: Number.isNaN(validTo.getTime()) ? null : validTo.toISOString(),
        daysRemaining: Number.isFinite(daysRemaining) ? daysRemaining : null,
        serialNumber: certificate.serialNumber || '',
        fingerprint: certificate.fingerprint256 || certificate.fingerprint || '',
        altNames: certificate.subjectaltname || '',
    };
}

const domainCache = new Map();

async function lookupDomainExpiry(domain) {
    if (!domain) {
        return null;
    }
    const cached = domainCache.get(domain);
    if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
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
        domainCache.set(domain, { at: Date.now(), value });
        return value;
    } catch {
        const value = { domain, expiresAt: null, registeredAt: null, registrar: null, status: [], error: true };
        domainCache.set(domain, { at: Date.now(), value });
        return value;
    }
}

function buildHeaders(monitor) {
    const headers = { ...(parseJson(monitor.headers, {}) || {}) };
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
        if (/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) {
            normalized[key] = String(value);
        }
    }
    return normalized;
}

async function checkHttp(monitor) {
    const url = normalizeUrl(monitor.url);
    if (!url) {
        return { status: STATUS.DOWN, msg: 'URL tidak valid', ping: null };
    }
    const accepted = parseAcceptedCodes(monitor.accepted_codes);
    const method = (monitor.method || 'GET').toUpperCase();
    const headers = buildHeaders(monitor);
    const body = monitor.body && method !== 'GET' && method !== 'HEAD' ? monitor.body : null;

    let response;
    try {
        response = await requestFollow(url, {
            method,
            headers,
            body,
            timeout: Math.max(1, Number(monitor.timeout) || 15) * 1000,
            maxRedirects: monitor.max_redirects,
            ignoreTls: Boolean(monitor.ignore_tls),
        });
    } catch (error) {
        return {
            status: STATUS.DOWN,
            msg: friendlyError(error),
            ping: null,
            cert: null,
        };
    }

    const ping = Math.round(response.elapsed);
    const cert = certificateInfo(response.certificate);
    const code = response.statusCode;
    const acceptedOk = statusFromAccepted(code, accepted);

    if (monitor.type === 'keyword') {
        const keyword = String(monitor.keyword || '');
        if (!acceptedOk) {
            return { status: statusFor(monitor, false), msg: `HTTP ${code}`, ping, cert };
        }
        if (!keyword) {
            return { status: statusFor(monitor, false), msg: 'Kata kunci kosong', ping, cert };
        }
        const found = response.body.includes(keyword);
        return {
            status: statusFor(monitor, found),
            msg: found ? `Kata kunci ditemukan (${ping} ms)` : 'Kata kunci tidak ditemukan',
            ping,
            cert,
        };
    }

    if (monitor.type === 'json') {
        if (!acceptedOk) {
            return { status: statusFor(monitor, false), msg: `HTTP ${code}`, ping, cert };
        }
        let payload;
        try {
            payload = JSON.parse(response.body);
        } catch {
            return { status: statusFor(monitor, false), msg: 'Respons bukan JSON valid', ping, cert };
        }
        const result = queryJson(payload, monitor.json_path || '$');
        const expected = monitor.expected_value;
        if (!result.found) {
            return { status: statusFor(monitor, false), msg: `Path ${monitor.json_path} tidak ditemukan`, ping, cert };
        }
        if (expected !== null && expected !== undefined && String(expected) !== '') {
            const actual = stringifyValue(result.value);
            const ok = actual === String(expected);
            return {
                status: statusFor(monitor, ok),
                msg: ok ? `Nilai cocok: ${actual}` : `Nilai ${actual} != ${expected}`,
                ping,
                cert,
            };
        }
        return {
            status: statusFor(monitor, true),
            msg: `JSON OK: ${stringifyValue(result.value).slice(0, 80)}`,
            ping,
            cert,
        };
    }

    return {
        status: statusFor(monitor, acceptedOk),
        msg: acceptedOk ? `HTTP ${code} - ${response.statusMessage || 'OK'} (${ping} ms)` : `HTTP ${code}`,
        ping,
        cert,
        httpStatus: code,
    };
}

function statusFor(monitor, ok) {
    const inverted = Boolean(monitor.upside_down);
    const effective = inverted ? !ok : ok;
    return effective ? STATUS.UP : STATUS.DOWN;
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

function friendlyError(error) {
    const message = String((error && error.message) || error || 'Unknown error');
    if (message === 'Timeout' || /timeout/i.test(message)) {
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
        DEPTH_ZERO_SELF_SIGNED_CERT: 'Sertifikat TLS self-signed',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Sertifikat TLS tidak terverifikasi',
        ERR_TLS_CERT_ALTNAME_INVALID: 'Nama host tidak cocok dengan sertifikat',
    };
    if (code && map[code]) {
        return map[code];
    }
    return message.slice(0, 180);
}

function checkTcp(monitor) {
    const host = String(monitor.hostname || '').trim();
    const port = Number(monitor.port);
    if (!host || !port) {
        return Promise.resolve({ status: STATUS.DOWN, msg: 'Host atau port kosong', ping: null });
    }
    return new Promise((resolve) => {
        const started = performance.now();
        let settled = false;
        const socket = new net.Socket();
        const timeout = Math.max(1, Number(monitor.timeout) || 15) * 1000;

        const done = (ok, msg) => {
            if (settled) {
                return;
            }
            settled = true;
            const ping = Math.round(performance.now() - started);
            socket.destroy();
            resolve({
                status: statusFor(monitor, ok),
                msg: ok ? `${host}:${port} terbuka (${ping} ms)` : msg,
                ping: ok ? ping : null,
            });
        };

        socket.setTimeout(timeout);
        socket.once('connect', () => done(true, 'OK'));
        socket.once('timeout', () => done(false, 'Timeout'));
        socket.once('error', (error) => done(false, friendlyError(error)));
        socket.connect(port, host);
    });
}

function checkPing(monitor) {
    const host = String(monitor.hostname || monitor.url || '').trim().replace(/^https?:\/\//, '').split('/')[0];
    if (!host) {
        return Promise.resolve({ status: STATUS.DOWN, msg: 'Host kosong', ping: null });
    }
    const timeoutSeconds = Math.max(1, Math.min(30, Math.round(Number(monitor.timeout) || 10)));
    const platform = process.platform;
    let args;
    if (platform === 'win32') {
        args = ['-n', '1', '-w', String(timeoutSeconds * 1000), host];
    } else if (platform === 'darwin') {
        args = ['-c', '1', '-W', String(timeoutSeconds * 1000), host];
    } else {
        args = ['-c', '1', '-W', String(timeoutSeconds), host];
    }

    return new Promise((resolve) => {
        const started = performance.now();
        let settled = false;
        let stdout = '';
        let stderr = '';
        let child;
        try {
            child = spawn(platform === 'win32' ? 'ping' : 'ping', args, { windowsHide: true });
        } catch (error) {
            resolve({ status: statusFor(monitor, false), msg: friendlyError(error), ping: null });
            return;
        }
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* already gone */
            }
            finish(false, 'Timeout');
        }, timeoutSeconds * 1000 + 3000);

        const finish = (ok, msg) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const ping = Math.round(performance.now() - started);
            resolve({
                status: statusFor(monitor, ok),
                msg: ok ? `${host} merespons (${ping} ms)` : msg,
                ping: ok ? ping : null,
            });
        };

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => finish(false, friendlyError(error)));
        child.on('close', (code) => {
            const output = `${stdout}\n${stderr}`;
            const match = output.match(/[=<]\s*([\d.]+)\s*ms/i);
            const lost = /(100%\s*(packet\s*)?loss|Destination host unreachable|Request timed out|100% packet loss)/i.test(
                output
            );
            if (code === 0 && !lost) {
                finish(true, match ? `${host} merespons (${Math.round(Number(match[1]))} ms)` : `${host} merespons`);
                return;
            }
            let msg = 'Host tidak merespons';
            if (/could not find host|unknown host|name or service not known/i.test(output)) {
                msg = 'Host tidak ditemukan';
            } else if (lost) {
                msg = 'Paket hilang 100%';
            } else if (/unreachable/i.test(output)) {
                msg = 'Host tidak terjangkau';
            }
            finish(false, msg);
        });
    });
}

async function checkDns(monitor) {
    const host = String(monitor.hostname || '').trim();
    if (!host) {
        return { status: STATUS.DOWN, msg: 'Hostname kosong', ping: null };
    }
    const type = String(monitor.dns_record_type || 'A').toUpperCase();
    const configured = String(monitor.dns_resolver || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    const attempt = async (servers) => {
        const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
        if (servers && servers.length) {
            resolver.setServers(servers);
        }
        const started = performance.now();
        const records = type === 'PTR' ? await resolver.reverse(host) : await resolver.resolve(host, type);
        return { records, ping: Math.round(performance.now() - started) };
    };

    const plans = configured.length ? [configured] : [[], ['1.1.1.1'], ['8.8.8.8']];
    let lastError = null;
    for (const plan of plans) {
        try {
            const { records, ping } = await attempt(plan);
            const flattened = (Array.isArray(records) ? records : [records]).map((record) =>
                typeof record === 'object' ? JSON.stringify(record) : String(record)
            );
            if (!flattened.length) {
                return { status: statusFor(monitor, false), msg: `Tidak ada record ${type}`, ping, dns: [] };
            }
            const expected = String(monitor.expected_value || '').trim();
            if (expected) {
                const found = flattened.some((record) => record.includes(expected));
                return {
                    status: statusFor(monitor, found),
                    msg: found ? `${type} cocok: ${expected}` : `${type} tidak memuat ${expected}`,
                    ping,
                    dns: flattened.slice(0, 8),
                };
            }
            return {
                status: statusFor(monitor, true),
                msg: `${type}: ${flattened.slice(0, 3).join(', ')}`,
                ping,
                dns: flattened.slice(0, 8),
            };
        } catch (error) {
            lastError = error;
            if (!['ECONNREFUSED', 'ETIMEOUT', 'ECONNRESET', 'EAI_AGAIN', 'SERVFAIL'].includes(error.code)) {
                break;
            }
        }
    }
    return { status: statusFor(monitor, false), msg: friendlyError(lastError), ping: null, dns: [] };
}

async function runCheck(monitor) {
    monitor = normalizeMonitor(monitor);
    let result;
    switch (monitor.type) {
        case 'http':
        case 'keyword':
        case 'json':
            result = await checkHttp(monitor);
            break;
        case 'tcp':
            result = await checkTcp(monitor);
            break;
        case 'ping':
            result = await checkPing(monitor);
            break;
        case 'dns':
            result = await checkDns(monitor);
            break;
        case 'push':
            return { status: STATUS.UP, msg: 'Menunggu heartbeat push', ping: null, skipped: true };
        default:
            return { status: STATUS.PENDING, msg: `Tipe ${monitor.type} tidak didukung`, ping: null };
    }

    if (monitor.cert_expiry_notification && result.cert) {
        const days = result.cert.daysRemaining;
        if (typeof days === 'number' && days < 0) {
            result.status = statusFor(monitor, false);
            result.msg = `Sertifikat TLS kedaluwarsa (${Math.abs(days)} hari lalu)`;
        }
    }

    if (monitor.domain_expiry_notification) {
        const domain = domainOf(monitor.url || monitor.hostname || '');
        if (domain) {
            result.domain = await lookupDomainExpiry(domain);
        }
    }

    return result;
}

async function checkCertificateOnly(monitor) {
    monitor = normalizeMonitor(monitor);
    const url = normalizeUrl(monitor.url);
    if (!url || !url.startsWith('https:')) {
        return null;
    }
    try {
        const parsed = new URL(url);
        const certificate = await new Promise((resolve, reject) => {
            const socket = tls.connect(
                {
                    host: parsed.hostname,
                    port: Number(parsed.port) || 443,
                    servername: parsed.hostname,
                    rejectUnauthorized: false,
                    timeout: 8000,
                },
                () => {
                    const cert = socket.getPeerCertificate();
                    socket.end();
                    resolve(cert);
                }
            );
            socket.on('timeout', () => {
                socket.destroy();
                reject(new Error('Timeout TLS'));
            });
            socket.on('error', reject);
        });
        return certificateInfo(certificate);
    } catch {
        return null;
    }
}

module.exports = {
    runCheck,
    checkCertificateOnly,
    lookupDomainExpiry,
    certificateInfo,
    friendlyError,
    requestFollow,
};
