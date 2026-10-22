/**
 * Klien protokol berbasis TCP untuk Workers.
 *
 * Semua koneksi keluar memakai Sockets API (`cloudflare:sockets`), yang hanya
 * tersedia di Workers Paid. Bila tidak tersedia, pemeriksaan melaporkan
 * kewajiban paket berbayar, bukan gagal diam-diam.
 */

import nodeCrypto from 'node:crypto';
import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function socketsUnavailable(error) {
    const message = String((error && error.message) || error || '');
    if (/paid|plan|not enabled|unavailable|TCP sockets/i.test(message)) {
        return 'Pemeriksaan TCP butuh Workers Paid (Sockets API)';
    }
    return message.slice(0, 160);
}

/**
 * Pembaca byte di atas ReadableStream dari Sockets API.
 */
class ByteStream {
    constructor(socket) {
        this.reader = socket.readable.getReader();
        this.buf = new Uint8Array(0);
        this.pos = 0;
        this.closed = false;
    }

    get available() {
        return this.buf.length - this.pos;
    }

    async ensure(min) {
        while (this.available < min) {
            const { value, done } = await this.reader.read();
            if (done) {
                this.closed = true;
                return false;
            }
            const next = new Uint8Array(this.available + value.byteLength);
            next.set(this.buf.subarray(this.pos), 0);
            next.set(value, this.available);
            this.buf = next;
            this.pos = 0;
        }
        return true;
    }

    async readExactly(count) {
        if (!(await this.ensure(count))) {
            throw new Error('Koneksi ditutup');
        }
        const out = this.buf.slice(this.pos, this.pos + count);
        this.pos += count;
        return out;
    }

    async readUntilByte(marker) {
        for (;;) {
            const index = this.buf.subarray(this.pos).indexOf(marker);
            if (index !== -1) {
                const end = this.pos + index;
                const line = this.buf.slice(this.pos, end);
                this.pos = end + 1;
                return line;
            }
            if (!(await this.ensure(this.available + 1))) {
                throw new Error('Koneksi ditutup');
            }
        }
    }

    async readLine() {
        const bytes = await this.readUntilByte(0x0a);
        return decoder.decode(bytes).replace(/\r$/, '');
    }

    async readByte() {
        const bytes = await this.readExactly(1);
        return bytes[0];
    }
}

class SocketWriter {
    constructor(socket) {
        this.writer = socket.writable.getWriter();
    }

    async write(data) {
        await this.writer.write(typeof data === 'string' ? encoder.encode(data) : data);
    }

    async close() {
        try {
            await this.writer.close();
        } catch {
            /* socket sudah tertutup */
        }
    }
}

async function openSocket({ host, port, secureTransport = 'off', timeout = 15000 }) {
    const socket = connect({ hostname: host, port: Number(port) }, { secureTransport });
    const opened = await Promise.race([
        socket.opened,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout)),
    ]);
    return { socket, opened, stream: new ByteStream(socket), writer: new SocketWriter(socket) };
}

async function withTimeout(promise, timeout, label) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Timeout')), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/* ------------------------------------------------------------------- TCP */

export async function tcpProbe({ host, port, timeout = 15000 }) {
    const started = Date.now();
    let handle = null;
    try {
        handle = await openSocket({ host, port, timeout });
        const ping = Date.now() - started;
        await handle.socket.close().catch(() => {});
        return { ok: true, message: `${host}:${port} terbuka (${ping} ms)`, ping };
    } catch (error) {
        const ping = Date.now() - started;
        if (handle?.socket) {
            await handle.socket.close().catch(() => {});
        }
        return { ok: false, message: socketsUnavailable(error), ping: null };
    }
}

/* ----------------------------------------------------------------- Redis */

function encodeRespCommand(args) {
    const parts = [];
    const header = `*${args.length}\r\n`;
    parts.push(encoder.encode(header));
    for (const arg of args) {
        const value = encoder.encode(String(arg));
        parts.push(encoder.encode(`$${value.length}\r\n`));
        parts.push(value);
        parts.push(encoder.encode('\r\n'));
    }
    return parts;
}

async function readRespReply(stream) {
    const type = await stream.readByte();
    if (type === 0x2b || type === 0x2d || type === 0x3a) {
        const line = await stream.readLine();
        if (type === 0x2d) {
            return { type: 'error', value: line };
        }
        if (type === 0x3a) {
            return { type: 'integer', value: Number(line) };
        }
        return { type: 'simple', value: line };
    }
    if (type === 0x24) {
        const length = Number(await stream.readLine());
        if (length === -1) {
            return { type: 'bulk', value: null };
        }
        const bytes = await stream.readExactly(length);
        await stream.readExactly(2);
        return { type: 'bulk', value: decoder.decode(bytes) };
    }
    if (type === 0x2a) {
        const count = Number(await stream.readLine());
        if (count === -1) {
            return { type: 'array', value: null };
        }
        const items = [];
        for (let index = 0; index < count; index += 1) {
            items.push(await readRespReply(stream));
        }
        return { type: 'array', value: items };
    }
    throw new Error('Balasan Redis tidak dikenal');
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

export async function redisCommand({ host, port, password, db, command, expected, timeout = 15000 }) {
    const started = Date.now();
    let handle = null;
    try {
        handle = await openSocket({ host, port, timeout });
        const steps = [];
        if (password) {
            steps.push(['AUTH', password]);
        }
        if (db !== null && db !== undefined && db !== '' && Number(db) > 0) {
            steps.push(['SELECT', String(Number(db))]);
        }
        const args = String(command || 'PING').trim().split(/\s+/).filter(Boolean);
        steps.push(args.length ? args : ['PING']);

        for (let index = 0; index < steps.length; index += 1) {
            for (const part of encodeRespCommand(steps[index])) {
                await handle.writer.write(part);
            }
            const reply = await withTimeout(readRespReply(handle.stream), timeout, 'Redis');
            if (reply.type === 'error') {
                await handle.socket.close().catch(() => {});
                return { ok: false, message: `Redis: ${reply.value}`, ping: null };
            }
            if (index === steps.length - 1) {
                const value = respValue(reply);
                const ping = Date.now() - started;
                await handle.socket.close().catch(() => {});
                if (expected !== null && expected !== undefined && String(expected) !== '') {
                    const matches = String(value).includes(String(expected));
                    return {
                        ok: matches,
                        message: matches
                            ? `Redis: ${String(value).slice(0, 60)}`
                            : `Redis: ${String(value).slice(0, 60)} != ${expected}`,
                        ping,
                    };
                }
                return { ok: true, message: `Redis: ${String(value).slice(0, 60)}`, ping };
            }
        }
        await handle.socket.close().catch(() => {});
        return { ok: true, message: 'Redis: OK', ping: Date.now() - started };
    } catch (error) {
        if (handle?.socket) {
            await handle.socket.close().catch(() => {});
        }
        return { ok: false, message: socketsUnavailable(error), ping: null };
    }
}

/* ------------------------------------------------------------------ MQTT */

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
    return bytes;
}

function mqttString(value) {
    const buffer = encoder.encode(String(value));
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, buffer.length, false);
    return [length, buffer];
}

function mqttConnect(clientId, { username, password, keepalive = 60 }) {
    let flags = 0x02;
    if (username) {
        flags |= 0x80;
    }
    if (password) {
        flags |= 0x40;
    }
    const keepaliveBytes = new Uint8Array(2);
    new DataView(keepaliveBytes.buffer).setUint16(0, keepalive, false);
    const body = [
        ...mqttString('MQTT'),
        new Uint8Array([0x04, flags]),
        keepaliveBytes,
        ...mqttString(clientId),
        ...(username ? mqttString(username) : []),
        ...(password ? mqttString(password) : []),
    ];
    const payload = concat(body);
    return concat([new Uint8Array([0x10]), new Uint8Array(encodeRemainingLength(payload.length)), payload]);
}

function mqttSubscribe(packetId, topic, qos = 0) {
    const id = new Uint8Array(2);
    new DataView(id.buffer).setUint16(0, packetId, false);
    const body = concat([id, ...mqttString(topic), new Uint8Array([qos & 0x03])]);
    return concat([new Uint8Array([0x82]), new Uint8Array(encodeRemainingLength(body.length)), body]);
}

function concat(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

async function readMqttPacket(stream) {
    const header = await stream.readByte();
    let multiplier = 1;
    let length = 0;
    for (;;) {
        const digit = await stream.readByte();
        length += (digit & 0x7f) * multiplier;
        multiplier *= 128;
        if ((digit & 0x80) === 0) {
            break;
        }
        if (multiplier > 128 * 128 * 128) {
            throw new Error('Paket MQTT tidak valid');
        }
    }
    const payload = length ? await stream.readExactly(length) : new Uint8Array(0);
    return { type: (header >> 4) & 0x0f, flags: header & 0x0f, payload };
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

export async function mqttProbe({ host, port, topic, username, password, clientId, expected, timeout = 15000 }) {
    const started = Date.now();
    let handle = null;
    try {
        handle = await openSocket({ host, port, timeout });
        await handle.writer.write(
            mqttConnect(clientId || `prasasti-${Date.now()}`, { username, password })
        );

        let subscribed = false;
        for (;;) {
            const packet = await withTimeout(readMqttPacket(handle.stream), timeout, 'MQTT');
            if (packet.type === 2) {
                const code = packet.payload[1];
                if (code !== 0) {
                    await handle.socket.close().catch(() => {});
                    return { ok: false, message: `MQTT: broker menolak koneksi (kode ${code})`, ping: null };
                }
                await handle.writer.write(mqttSubscribe(1, topic));
                continue;
            }
            if (packet.type === 9) {
                const code = packet.payload[packet.payload.length - 1];
                if (code === 0x80) {
                    await handle.socket.close().catch(() => {});
                    return { ok: false, message: 'MQTT: langganan ditolak broker', ping: null };
                }
                subscribed = true;
                continue;
            }
            if (packet.type === 3) {
                const view = new DataView(packet.payload.buffer, packet.payload.byteOffset, packet.payload.byteLength);
                const topicLength = view.getUint16(0, false);
                const messageTopic = decoder.decode(packet.payload.slice(2, 2 + topicLength));
                const qos = (packet.flags >> 1) & 0x03;
                let offset = 2 + topicLength;
                if (qos > 0) {
                    offset += 2;
                }
                const body = decoder.decode(packet.payload.slice(offset));
                if (!subscribed || !topicMatches(topic, messageTopic)) {
                    continue;
                }
                const ping = Date.now() - started;
                await handle.socket.close().catch(() => {});
                if (expected !== null && expected !== undefined && String(expected) !== '') {
                    const matches = body.includes(String(expected));
                    return {
                        ok: matches,
                        message: matches
                            ? `MQTT: pesan pada ${messageTopic} cocok`
                            : `MQTT: pesan pada ${messageTopic} tidak memuat "${expected}"`,
                        ping,
                    };
                }
                return { ok: true, message: `MQTT: pesan pada ${messageTopic}`, ping };
            }
            if (packet.type === 13) {
                await handle.socket.close().catch(() => {});
                return { ok: false, message: 'MQTT: broker memutus koneksi', ping: null };
            }
        }
    } catch (error) {
        if (handle?.socket) {
            await handle.socket.close().catch(() => {});
        }
        return { ok: false, message: socketsUnavailable(error), ping: null };
    }
}

/* ------------------------------------------------------------------ SMTP */

function encodeHeader(value) {
    const text = String(value || '');
    if (/^[\x20-\x7E]*$/.test(text)) {
        return text;
    }
    return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

async function readSmtpResponse(handle) {
    const lines = [];
    for (;;) {
        const line = await handle.stream.readLine();
        lines.push(line);
        if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) {
            break;
        }
    }
    const code = Number((lines[lines.length - 1] || '0').slice(0, 3));
    return { code, lines };
}

/**
 * Klien SMTP minimal: AUTH PLAIN/LOGIN, opsional STARTTLS.
 */
export async function smtpSend({
    host,
    port,
    secure,
    user,
    pass,
    from,
    to,
    subject,
    text,
    html,
    timeout = 15000,
}) {
    let handle = null;
    try {
        handle = await openSocket({
            host,
            port,
            secureTransport: secure ? 'on' : 'starttls',
            timeout,
        });
        const expect = async (code) => {
            const response = await readSmtpResponse(handle);
            if (response.code !== code) {
                throw new Error(`SMTP ${response.code}: ${response.lines.join(' ').slice(0, 160)}`);
            }
            return response;
        };

        await expect(220);
        await handle.writer.write('EHLO prasasti.local\r\n');
        const capabilities = (await readSmtpResponse(handle)).lines.join('\n').toUpperCase();

        if (!secure && capabilities.includes('STARTTLS')) {
            await handle.writer.write('STARTTLS\r\n');
            await expect(220);
            const secured = handle.socket.startTls();
            handle.socket = secured;
            handle.stream = new ByteStream(secured);
            handle.writer = new SocketWriter(secured);
            await handle.writer.write('EHLO prasasti.local\r\n');
            await readSmtpResponse(handle);
        }

        if (user) {
            if (capabilities.includes('PLAIN')) {
                const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
                await handle.writer.write(`AUTH PLAIN ${token}\r\n`);
                await expect(235);
            } else {
                await handle.writer.write('AUTH LOGIN\r\n');
                await expect(334);
                await handle.writer.write(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`);
                await expect(334);
                await handle.writer.write(`${Buffer.from(pass, 'utf8').toString('base64')}\r\n`);
                await expect(235);
            }
        }

        await handle.writer.write(`MAIL FROM:<${from}>\r\n`);
        await expect(250);
        for (const recipient of String(to)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)) {
            await handle.writer.write(`RCPT TO:<${recipient}>\r\n`);
            await expect(250);
        }
        await handle.writer.write('DATA\r\n');
        await expect(354);

        const boundary = `prasasti-${Date.now()}`;
        const message = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${encodeHeader(subject)}`,
            `Date: ${new Date().toUTCString()}`,
            'MIME-Version: 1.0',
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            '',
            `--${boundary}`,
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            text,
            '',
            `--${boundary}`,
            'Content-Type: text/html; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            html,
            '',
            `--${boundary}--`,
            '',
        ]
            .join('\r\n')
            .replace(/\n\./g, '\n..');

        await handle.writer.write(`${message}\r\n.\r\n`);
        await expect(250);
        await handle.writer.write('QUIT\r\n').catch(() => null);
        await handle.socket.close().catch(() => {});
        return { ok: true };
    } catch (error) {
        if (handle?.socket) {
            await handle.socket.close().catch(() => {});
        }
        return { ok: false, message: socketsUnavailable(error) };
    }
}

/* ------------------------------------------------------------- PostgreSQL */

function pgScramEscape(value) {
    return String(value).replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function pgScramFinal(user, password, clientNonce, serverFirst) {
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
    const saltedPassword = nodeCrypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
    const clientKey = hmac(saltedPassword, encoder.encode('Client Key'));
    const storedKey = nodeCrypto.createHash('sha256').update(clientKey).digest();
    const clientFirstBare = `n=${pgScramEscape(user)},r=${clientNonce}`;
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
    const clientSignature = hmac(storedKey, encoder.encode(authMessage));
    const proof = Buffer.alloc(clientKey.length);
    for (let index = 0; index < clientKey.length; index += 1) {
        proof[index] = clientKey[index] ^ clientSignature[index];
    }
    return `c=biws,r=${serverNonce},p=${proof.toString('base64')}`;
}

function hmac(key, data) {
    return nodeCrypto.createHmac('sha256', key).update(data).digest();
}

function md5Hex(value) {
    return nodeCrypto.createHash('md5').update(value).digest('hex');
}

function pgMessage(type, payload) {
    const length = new Uint8Array(4);
    new DataView(length.buffer).setInt32(0, payload.length + 4, false);
    return concat([encoder.encode(type), length, payload]);
}

function pgErrorText(payload) {
    const fields = decoder.decode(payload).split('\0');
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

export async function postgresQuery({ host, port, user, password, database, query, timeout = 15000 }) {
    const started = Date.now();
    let handle = null;
    try {
        handle = await openSocket({ host, port, timeout });
        const params = [`user\0${user}`, `database\0${database}`];
        const body = concat([
            new Uint8Array([0x00, 0x03, 0x00, 0x00]),
            encoder.encode(params.join('\0')),
            new Uint8Array([0x00]),
        ]);
        const length = new Uint8Array(4);
        new DataView(length.buffer).setInt32(0, body.length + 4, false);
        await handle.writer.write(concat([length, body]));

        let authenticated = false;
        let queried = false;
        let clientNonce = null;

        for (;;) {
            const type = decoder.decode(new Uint8Array([await handle.stream.readByte()]));
            const lengthBytes = await handle.stream.readExactly(4);
            const payloadLength = new DataView(
                lengthBytes.buffer,
                lengthBytes.byteOffset,
                lengthBytes.byteLength
            ).getInt32(0, false);
            const payload = payloadLength ? await handle.stream.readExactly(payloadLength - 4) : new Uint8Array(0);

            if (type === 'E') {
                await handle.socket.close().catch(() => {});
                return { ok: false, message: `PostgreSQL: ${pgErrorText(payload)}`, ping: null };
            }
            if (type === 'R') {
                const method = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, false);
                if (method === 0) {
                    authenticated = true;
                    continue;
                }
                if (method === 3) {
                    await handle.writer.write(pgMessage('p', concat([encoder.encode(password), new Uint8Array([0])])));
                    continue;
                }
                if (method === 5) {
                    const salt = payload.slice(4, 8);
                    const inner = md5Hex(Buffer.from(`${password}${user}`, 'utf8'));
                    const outer = md5Hex(Buffer.concat([Buffer.from(inner, 'utf8'), Buffer.from(salt)]));
                    await handle.writer.write(pgMessage('p', concat([encoder.encode(`md5${outer}`), new Uint8Array([0])])));
                    continue;
                }
                if (method === 10) {
                    const mechanisms = decoder.decode(payload.slice(4)).split('\0');
                    if (!mechanisms.includes('SCRAM-SHA-256')) {
                        await handle.socket.close().catch(() => {});
                        return {
                            ok: false,
                            message: `PostgreSQL: metode autentikasi tidak didukung (${mechanisms.join(', ')})`,
                            ping: null,
                        };
                    }
                    const nonceBytes = new Uint8Array(18);
                    crypto.getRandomValues(nonceBytes);
                    clientNonce = Buffer.from(nonceBytes).toString('base64');
                    const clientFirstBare = `n=${pgScramEscape(user)},r=${clientNonce}`;
                    const clientFirst = `n,,${clientFirstBare}`;
                    const mechanism = encoder.encode('SCRAM-SHA-256');
                    const mechanismLength = new Uint8Array(2);
                    new DataView(mechanismLength.buffer).setUint16(0, mechanism.length, false);
                    const responseLength = new Uint8Array(4);
                    new DataView(responseLength.buffer).setInt32(0, encoder.encode(clientFirst).length, false);
                    await handle.writer.write(
                        pgMessage(
                            'p',
                            concat([
                                mechanismLength,
                                mechanism,
                                responseLength,
                                encoder.encode(clientFirst),
                            ])
                        )
                    );
                    continue;
                }
                if (method === 11) {
                    const serverFirst = decoder.decode(payload.slice(4));
                    const clientFinal = pgScramFinal(user, password, clientNonce, serverFirst);
                    await handle.writer.write(pgMessage('p', encoder.encode(clientFinal)));
                    continue;
                }
                if (method === 12) {
                    authenticated = true;
                    continue;
                }
                await handle.socket.close().catch(() => {});
                return { ok: false, message: `PostgreSQL: metode autentikasi ${method} tidak didukung`, ping: null };
            }
            if (type === 'Z') {
                if (authenticated && !queried) {
                    queried = true;
                    await handle.writer.write(pgMessage('Q', concat([encoder.encode(`${query || 'SELECT 1'}`), new Uint8Array([0])])));
                }
                continue;
            }
            if (type === 'C') {
                const ping = Date.now() - started;
                await handle.socket.close().catch(() => {});
                return {
                    ok: true,
                    message: `PostgreSQL: ${decoder.decode(payload).replace(/\0/g, '').trim() || 'query ok'}`,
                    ping,
                };
            }
        }
    } catch (error) {
        if (handle?.socket) {
            await handle.socket.close().catch(() => {});
        }
        return { ok: false, message: socketsUnavailable(error), ping: null };
    }
}
