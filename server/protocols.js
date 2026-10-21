'use strict';

const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

/**
 * Klien protokol untuk pemeriksaan langsung: Redis (RESP), MQTT 3.1.1,
 * Docker Engine API, dan PostgreSQL (wire protocol v3).
 *
 * Semua fungsi mengembalikan { ok, message, value? } dan tidak melempar
 * exception, supaya lapisan pemeriksaan cukup memetakan hasilnya ke status.
 */

/* ------------------------------------------------------------------ Redis */

function encodeRespCommand(args) {
    const parts = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
    for (const arg of args) {
        const value = Buffer.from(String(arg), 'utf8');
        parts.push(Buffer.from(`$${value.length}\r\n`, 'utf8'), value, Buffer.from('\r\n', 'utf8'));
    }
    return Buffer.concat(parts);
}

/**
 * Parser RESP berbasis offset. Mengembalikan null saat data belum lengkap.
 */
function parseResp(buffer, offset = 0) {
    if (offset >= buffer.length) {
        return null;
    }
    const type = buffer[offset];
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) {
        return null;
    }
    const line = buffer.slice(offset + 1, lineEnd).toString('utf8');

    if (type === 0x2b) {
        return { value: { type: 'simple', value: line }, next: lineEnd + 2 };
    }
    if (type === 0x2d) {
        return { value: { type: 'error', value: line }, next: lineEnd + 2 };
    }
    if (type === 0x3a) {
        return { value: { type: 'integer', value: Number(line) }, next: lineEnd + 2 };
    }
    if (type === 0x24) {
        const length = Number(line);
        if (length === -1) {
            return { value: { type: 'bulk', value: null }, next: lineEnd + 2 };
        }
        const start = lineEnd + 2;
        if (buffer.length < start + length + 2) {
            return null;
        }
        return {
            value: { type: 'bulk', value: buffer.slice(start, start + length).toString('utf8') },
            next: start + length + 2,
        };
    }
    if (type === 0x2a) {
        const count = Number(line);
        if (count === -1) {
            return { value: { type: 'array', value: null }, next: lineEnd + 2 };
        }
        let cursor = lineEnd + 2;
        const items = [];
        for (let index = 0; index < count; index += 1) {
            const item = parseResp(buffer, cursor);
            if (!item) {
                return null;
            }
            items.push(item.value);
            cursor = item.next;
        }
        return { value: { type: 'array', value: items }, next: cursor };
    }
    return { value: { type: 'unknown', value: line }, next: lineEnd + 2 };
}

function respValue(reply) {
    if (!reply) {
        return null;
    }
    if (reply.type === 'array') {
        return (reply.value || []).map((item) => respValue(item)).join(' ');
    }
    return reply.value;
}

function redisCommand({ host, port, password, db, command, expected, timeout = 15000 }) {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = new net.Socket();
        let settled = false;
        let buffer = Buffer.alloc(0);
        const steps = [];
        if (password) {
            steps.push(['AUTH', password]);
        }
        if (db !== null && db !== undefined && db !== '' && Number(db) > 0) {
            steps.push(['SELECT', String(Number(db))]);
        }
        const commandArgs = String(command || 'PING').trim().split(/\s+/).filter(Boolean);
        steps.push(commandArgs.length ? commandArgs : ['PING']);

        let stepIndex = 0;

        const finish = (ok, message, value = null) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.destroy();
            } catch {
                /* socket sudah tertutup */
            }
            const ping = Math.round(performance.now() - started);
            resolve({ ok, message: ping ? `${message} (${ping} ms)` : message, value, ping });
        };

        socket.setTimeout(Math.max(1, timeout));
        socket.once('connect', () => {
            socket.write(encodeRespCommand(steps[0]));
        });
        socket.once('timeout', () => finish(false, 'Timeout'));
        socket.once('error', (error) => finish(false, error.message));
        socket.connect(port, host);

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const parsed = parseResp(buffer, 0);
                if (!parsed) {
                    return;
                }
                buffer = buffer.slice(parsed.next);
                if (parsed.value.type === 'error') {
                    finish(false, `Redis: ${parsed.value.value}`);
                    return;
                }
                stepIndex += 1;
                if (stepIndex >= steps.length) {
                    const value = respValue(parsed.value);
                    if (expected !== null && expected !== undefined && String(expected) !== '') {
                        const matches = String(value).includes(String(expected));
                        finish(
                            matches,
                            matches
                                ? `Redis: ${String(value).slice(0, 60)}`
                                : `Redis: ${String(value).slice(0, 60)} != ${expected}`,
                            value
                        );
                        return;
                    }
                    finish(true, `Redis: ${String(value).slice(0, 60)}`, value);
                    return;
                }
                socket.write(encodeRespCommand(steps[stepIndex]));
            }
        });
    });
}

/* ------------------------------------------------------------------- MQTT */

function encodeRemainingLength(length) {
    const bytes = [];
    let value = length;
    do {
        let digit = value % 128;
        value = Math.floor(value / 128);
        if (value > 0) {
            digit |= 0x80;
        }
        bytes.push(digit);
    } while (value > 0);
    return Buffer.from(bytes);
}

function mqttString(value) {
    const buffer = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(buffer.length, 0);
    return Buffer.concat([length, buffer]);
}

function mqttConnect(clientId, { username, password, keepalive = 60 }) {
    let flags = 0x02; // clean session
    if (username) {
        flags |= 0x80;
    }
    if (password) {
        flags |= 0x40;
    }
    const variable = Buffer.concat([
        mqttString('MQTT'),
        Buffer.from([0x04, flags]),
        (() => {
            const buffer = Buffer.alloc(2);
            buffer.writeUInt16BE(keepalive, 0);
            return buffer;
        })(),
    ]);
    const payload = Buffer.concat([
        mqttString(clientId),
        username ? mqttString(username) : Buffer.alloc(0),
        password ? mqttString(password) : Buffer.alloc(0),
    ]);
    const body = Buffer.concat([variable, payload]);
    return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body]);
}

function mqttSubscribe(packetId, topic, qos = 0) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(packetId, 0);
    const body = Buffer.concat([id, mqttString(topic), Buffer.from([qos & 0x03])]);
    return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]);
}

/**
 * Baca satu paket MQTT dari buffer. Mengembalikan null bila belum lengkap.
 */
function parseMqttPacket(buffer) {
    if (buffer.length < 2) {
        return null;
    }
    let multiplier = 1;
    let length = 0;
    let index = 1;
    for (;;) {
        if (index >= buffer.length) {
            return null;
        }
        const digit = buffer[index];
        length += (digit & 0x7f) * multiplier;
        index += 1;
        if ((digit & 0x80) === 0) {
            break;
        }
        multiplier *= 128;
        if (multiplier > 128 * 128 * 128) {
            return null;
        }
    }
    if (buffer.length < index + length) {
        return null;
    }
    return {
        type: (buffer[0] >> 4) & 0x0f,
        flags: buffer[0] & 0x0f,
        payload: buffer.slice(index, index + length),
        next: index + length,
    };
}

function topicMatches(pattern, topic) {
    if (pattern === topic) {
        return true;
    }
    if (!pattern.includes('#') && !pattern.includes('+')) {
        return false;
    }
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');
    for (let index = 0; index < patternParts.length; index += 1) {
        const part = patternParts[index];
        if (part === '#') {
            return true;
        }
        if (index >= topicParts.length) {
            return false;
        }
        if (part !== '+' && part !== topicParts[index]) {
            return false;
        }
    }
    return patternParts.length === topicParts.length;
}

function mqttProbe({ host, port, topic, username, password, clientId, expected, timeout = 15000 }) {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = new net.Socket();
        let settled = false;
        let buffer = Buffer.alloc(0);
        let subscribed = false;

        const finish = (ok, message, value = null) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.destroy();
            } catch {
                /* socket sudah tertutup */
            }
            const ping = Math.round(performance.now() - started);
            resolve({ ok, message: ping ? `${message} (${ping} ms)` : message, value, ping });
        };

        socket.setTimeout(Math.max(1, timeout));
        socket.once('connect', () => {
            socket.write(mqttConnect(clientId || `prasasti-${Date.now()}`, { username, password }));
        });
        socket.once('timeout', () => finish(false, 'Timeout'));
        socket.once('error', (error) => finish(false, error.message));
        socket.connect(port, host);

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const packet = parseMqttPacket(buffer);
                if (!packet) {
                    return;
                }
                buffer = buffer.slice(packet.next);

                if (packet.type === 2) {
                    // CONNACK
                    const code = packet.payload[1];
                    if (code !== 0) {
                        finish(false, `MQTT: broker menolak koneksi (kode ${code})`);
                        return;
                    }
                    socket.write(mqttSubscribe(1, topic));
                    continue;
                }
                if (packet.type === 9) {
                    // SUBACK
                    const code = packet.payload[packet.payload.length - 1];
                    if (code === 0x80) {
                        finish(false, 'MQTT: langganan ditolak broker');
                        return;
                    }
                    subscribed = true;
                    continue;
                }
                if (packet.type === 3) {
                    // PUBLISH
                    const topicLength = packet.payload.readUInt16BE(0);
                    const messageTopic = packet.payload.slice(2, 2 + topicLength).toString('utf8');
                    const qos = (packet.flags >> 1) & 0x03;
                    let offset = 2 + topicLength;
                    if (qos > 0) {
                        offset += 2;
                    }
                    const body = packet.payload.slice(offset).toString('utf8');
                    if (!subscribed || !topicMatches(topic, messageTopic)) {
                        continue;
                    }
                    if (expected !== null && expected !== undefined && String(expected) !== '') {
                        const matches = body.includes(String(expected));
                        finish(
                            matches,
                            matches
                                ? `MQTT: pesan pada ${messageTopic} cocok`
                                : `MQTT: pesan pada ${messageTopic} tidak memuat "${expected}"`,
                            body
                        );
                        return;
                    }
                    finish(true, `MQTT: pesan pada ${messageTopic}`, body);
                    return;
                }
                if (packet.type === 13) {
                    finish(false, 'MQTT: broker memutus koneksi');
                    return;
                }
            }
        });
    });
}

/* ----------------------------------------------------------------- Docker */

function defaultDockerSocket() {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\docker_engine';
    }
    return '/var/run/docker.sock';
}

function dockerInspect({ socket, container, timeout = 10000 }) {
    return new Promise((resolve) => {
        const started = performance.now();
        const socketPath = socket || defaultDockerSocket();
        const request = http.request(
            {
                socketPath,
                path: `/v1.41/containers/${encodeURIComponent(container)}/json`,
                method: 'GET',
                timeout,
                headers: { Host: 'docker', Accept: 'application/json' },
            },
            (response) => {
                let body = '';
                response.on('data', (chunk) => {
                    body += chunk;
                });
                response.on('end', () => {
                    const ping = Math.round(performance.now() - started);
                    if (response.statusCode === 404) {
                        resolve({ ok: false, message: `Docker: container ${container} tidak ditemukan`, ping });
                        return;
                    }
                    if (response.statusCode !== 200) {
                        resolve({
                            ok: false,
                            message: `Docker: HTTP ${response.statusCode} ${body.slice(0, 120)}`,
                            ping,
                        });
                        return;
                    }
                    let payload;
                    try {
                        payload = JSON.parse(body);
                    } catch {
                        resolve({ ok: false, message: 'Docker: respons bukan JSON valid', ping });
                        return;
                    }
                    const state = payload.State || {};
                    const health = state.Health ? state.Health.Status : null;
                    if (state.Running !== true) {
                        resolve({
                            ok: false,
                            message: `Docker: container ${container} berhenti (${state.Status || 'tidak diketahui'})`,
                            ping,
                            value: { status: state.Status, health },
                        });
                        return;
                    }
                    if (health && health !== 'healthy' && health !== 'starting') {
                        resolve({
                            ok: false,
                            message: `Docker: health container ${container} = ${health}`,
                            ping,
                            value: { status: state.Status, health },
                        });
                        return;
                    }
                    resolve({
                        ok: true,
                        message: `Docker: ${container} berjalan${health ? ` (${health})` : ''}`,
                        ping,
                        value: { status: state.Status, health },
                    });
                });
            }
        );
        request.on('timeout', () => {
            request.destroy();
            resolve({ ok: false, message: 'Docker: timeout', ping: null });
        });
        request.on('error', (error) => {
            resolve({ ok: false, message: `Docker: ${error.message}`, ping: null });
        });
        request.end();
    });
}

/* -------------------------------------------------------------- PostgreSQL */

function pgScramEscape(value) {
    return String(value).replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function pgScramClient(password, clientNonce) {
    const clientFirstBare = `n=,r=${clientNonce}`;
    const clientFirst = `n,,${clientFirstBare}`;
    return { clientFirst, clientFirstBare };
}

function pgScramFinal(password, clientNonce, serverFirst) {
    const attributes = {};
    for (const part of serverFirst.split(',')) {
        const index = part.indexOf('=');
        if (index > 0) {
            attributes[part.slice(0, index)] = part.slice(index + 1);
        }
    }
    const salt = Buffer.from(attributes.s || '', 'base64');
    const iterations = Number(attributes.i || 4096);
    const serverNonce = attributes.r || '';
    if (!serverNonce.startsWith(clientNonce)) {
        throw new Error('nonce broker tidak cocok');
    }
    const saltedPassword = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
    const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const clientSignature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.alloc(clientKey.length);
    for (let index = 0; index < clientKey.length; index += 1) {
        proof[index] = clientKey[index] ^ clientSignature[index];
    }
    return `c=biws,r=${serverNonce},p=${proof.toString('base64')}`;
}

function pgMessage(type, payload) {
    const length = Buffer.alloc(4);
    length.writeInt32BE(payload.length + 4, 0);
    return Buffer.concat([Buffer.from(type, 'utf8'), length, payload]);
}

function pgParse(buffer) {
    // Kembalikan daftar pesan { type, payload } yang lengkap.
    const messages = [];
    let offset = 0;
    while (offset < buffer.length) {
        if (buffer.length < offset + 5) {
            break;
        }
        const type = String.fromCharCode(buffer[offset]);
        const length = buffer.readInt32BE(offset + 1);
        if (buffer.length < offset + 1 + length) {
            break;
        }
        messages.push({ type, payload: buffer.slice(offset + 5, offset + 1 + length) });
        offset += 1 + length;
    }
    return { messages, rest: buffer.slice(offset) };
}

function pgErrorText(payload) {
    const fields = payload.toString('utf8').split('\0');
    const map = {};
    for (const field of fields) {
        if (!field) {
            continue;
        }
        const index = field.indexOf('=');
        if (index > 0) {
            map[field.slice(0, index)] = field.slice(index + 1);
        }
    }
    return map.M || 'galat PostgreSQL';
}

function postgresQuery({ host, port, user, password, database, query, timeout = 15000 }) {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = new net.Socket();
        let settled = false;
        let buffer = Buffer.alloc(0);
        let authenticated = false;
        let queried = false;
        let scramState = null;
        let rowSeen = false;
        let errorSeen = null;

        const finish = (ok, message, value = null) => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                socket.destroy();
            } catch {
                /* socket sudah tertutup */
            }
            const ping = Math.round(performance.now() - started);
            resolve({ ok, message: ping ? `${message} (${ping} ms)` : message, value, ping });
        };

        const sendStartup = () => {
            const params = [`user${String.fromCharCode(0)}${user}`, `database${String.fromCharCode(0)}${database}`];
            const body = Buffer.concat([
                Buffer.from([0x00, 0x03, 0x00, 0x00]), // versi protokol 3.0
                Buffer.from(params.join(String.fromCharCode(0)), 'utf8'),
                Buffer.from([0x00]),
            ]);
            const length = Buffer.alloc(4);
            length.writeInt32BE(body.length + 4, 0);
            socket.write(Buffer.concat([length, body]));
        };

        socket.setTimeout(Math.max(1, timeout));
        socket.once('connect', sendStartup);
        socket.once('timeout', () => finish(false, 'Timeout'));
        socket.once('error', (error) => finish(false, error.message));
        socket.connect(port, host);

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            const parsed = pgParse(buffer);
            buffer = parsed.rest;

            for (const message of parsed.messages) {
                if (message.type === 'E') {
                    errorSeen = pgErrorText(message.payload);
                    finish(false, `PostgreSQL: ${errorSeen}`);
                    return;
                }
                if (message.type === 'R') {
                    const method = message.payload.readInt32BE(0);
                    if (method === 0) {
                        authenticated = true;
                        continue;
                    }
                    if (method === 3) {
                        socket.write(pgMessage('p', Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])])));
                        continue;
                    }
                    if (method === 5) {
                        const salt = message.payload.slice(4, 8);
                        const inner = crypto
                            .createHash('md5')
                            .update(String(password) + user, 'utf8')
                            .digest('hex');
                        const outer = crypto
                            .createHash('md5')
                            .update(Buffer.concat([Buffer.from(inner, 'utf8'), salt]))
                            .digest('hex');
                        socket.write(pgMessage('p', Buffer.concat([Buffer.from(`md5${outer}`, 'utf8'), Buffer.from([0])])));
                        continue;
                    }
                    if (method === 10) {
                        const mechanisms = message.payload.slice(4).toString('utf8').split('\0');
                        if (!mechanisms.includes('SCRAM-SHA-256')) {
                            finish(false, `PostgreSQL: metode autentikasi tidak didukung (${mechanisms.join(', ')})`);
                            return;
                        }
                        const clientNonce = crypto.randomBytes(18).toString('base64');
                        const { clientFirst } = pgScramClient(password, clientNonce);
                        scramState = { clientNonce, clientFirst };
                        const mechanism = Buffer.from('SCRAM-SHA-256', 'utf8');
                        const response = Buffer.from(clientFirst, 'utf8');
                        const mechanismLength = Buffer.alloc(2);
                        mechanismLength.writeInt16BE(mechanism.length, 0);
                        const responseLength = Buffer.alloc(4);
                        responseLength.writeInt32BE(response.length, 0);
                        socket.write(
                            pgMessage(
                                'p',
                                Buffer.concat([mechanismLength, mechanism, responseLength, response])
                            )
                        );
                        continue;
                    }
                    if (method === 11) {
                        const serverFirst = message.payload.slice(4).toString('utf8');
                        try {
                            const clientFinal = pgScramFinal(password, scramState.clientNonce, serverFirst);
                            socket.write(pgMessage('p', Buffer.from(clientFinal, 'utf8')));
                        } catch (error) {
                            finish(false, `PostgreSQL: ${error.message}`);
                            return;
                        }
                        continue;
                    }
                    if (method === 12) {
                        authenticated = true;
                        continue;
                    }
                    finish(false, `PostgreSQL: metode autentikasi ${method} tidak didukung`);
                    return;
                }
                if (message.type === 'Z') {
                    if (authenticated && !queried) {
                        queried = true;
                        const statement = `${query || 'SELECT 1'}\0`;
                        socket.write(pgMessage('Q', Buffer.from(statement, 'utf8')));
                    }
                    continue;
                }
                if (message.type === 'D') {
                    rowSeen = true;
                    continue;
                }
                if (message.type === 'T') {
                    rowSeen = true;
                    continue;
                }
                if (message.type === 'C') {
                    finish(
                        true,
                        `PostgreSQL: ${message.payload.toString('utf8').replace(/\0/g, '').trim() || 'query ok'}`
                    );
                    return;
                }
            }

            if (queried && !rowSeen && !errorSeen) {
                finish(true, 'PostgreSQL: query selesai tanpa baris');
            }
        });
    });
}

module.exports = {
    encodeRespCommand,
    parseResp,
    respValue,
    redisCommand,
    mqttProbe,
    dockerInspect,
    defaultDockerSocket,
    postgresQuery,
    pgScramFinal,
};
