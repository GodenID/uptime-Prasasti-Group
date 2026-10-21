'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

const OPCODE = {
    CONTINUATION: 0x0,
    TEXT: 0x1,
    BINARY: 0x2,
    CLOSE: 0x8,
    PING: 0x9,
    PONG: 0xa,
};

/**
 * Encode a server -> client frame (never masked).
 */
function encodeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    let header;
    if (data.length < 126) {
        header = Buffer.alloc(2);
        header[1] = data.length;
    } else if (data.length < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(data.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, data]);
}

class WebSocketConnection extends EventEmitter {
    constructor(socket, request) {
        super();
        this.socket = socket;
        this.request = request;
        this.alive = true;
        this.closed = false;
        this.buffer = Buffer.alloc(0);
        this.fragment = [];
        this.fragmentOpcode = null;
        this.lastSeen = Date.now();

        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.finish());
        socket.on('error', () => this.finish());
        socket.on('end', () => this.finish());

        this.pinger = setInterval(() => {
            if (!this.alive) {
                this.close(1001, 'timeout');
                return;
            }
            this.alive = false;
            this.raw(OPCODE.PING, Buffer.alloc(0));
        }, 30000);
        this.pinger.unref?.();
    }

    onData(chunk) {
        if (this.closed) {
            return;
        }
        this.lastSeen = Date.now();
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > MAX_MESSAGE * 2) {
            this.close(1009, 'message too big');
            return;
        }
        while (this.parseFrame()) {
            /* keep parsing frames until the buffer is exhausted */
        }
    }

    parseFrame() {
        const buffer = this.buffer;
        if (buffer.length < 2) {
            return false;
        }
        const first = buffer[0];
        const second = buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (length === 126) {
            if (buffer.length < 4) {
                return false;
            }
            length = buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (buffer.length < 10) {
                return false;
            }
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(MAX_MESSAGE)) {
                this.close(1009, 'message too big');
                return false;
            }
            length = Number(big);
            offset = 10;
        }

        if (length > MAX_MESSAGE) {
            this.close(1009, 'message too big');
            return false;
        }

        let maskKey = null;
        if (masked) {
            if (buffer.length < offset + 4) {
                return false;
            }
            maskKey = buffer.subarray(offset, offset + 4);
            offset += 4;
        }

        if (buffer.length < offset + length) {
            return false;
        }

        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (maskKey) {
            for (let i = 0; i < payload.length; i += 1) {
                payload[i] ^= maskKey[i % 4];
            }
        }
        this.buffer = buffer.subarray(offset + length);
        this.handleFrame(fin, opcode, payload);
        return this.buffer.length >= 2;
    }

    handleFrame(fin, opcode, payload) {
        if (opcode === OPCODE.PING) {
            this.raw(OPCODE.PONG, payload);
            return;
        }
        if (opcode === OPCODE.PONG) {
            this.alive = true;
            return;
        }
        if (opcode === OPCODE.CLOSE) {
            this.close(1000, 'bye');
            return;
        }
        if (opcode === OPCODE.CONTINUATION) {
            this.fragment.push(payload);
            if (fin) {
                const full = Buffer.concat(this.fragment);
                this.fragment = [];
                const type = this.fragmentOpcode;
                this.fragmentOpcode = null;
                if (type === OPCODE.TEXT) {
                    this.emit('message', full.toString('utf8'));
                }
            }
            return;
        }
        if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
            if (!fin) {
                this.fragment = [payload];
                this.fragmentOpcode = opcode;
                return;
            }
            if (opcode === OPCODE.TEXT) {
                this.emit('message', payload.toString('utf8'));
            } else {
                this.emit('binary', payload);
            }
        }
    }

    raw(opcode, payload) {
        if (this.closed || !this.socket.writable) {
            return;
        }
        try {
            this.socket.write(encodeFrame(opcode, payload));
        } catch {
            this.finish();
        }
    }

    send(payload) {
        if (this.closed) {
            return false;
        }
        this.alive = true;
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        this.raw(OPCODE.TEXT, Buffer.from(text, 'utf8'));
        return true;
    }

    close(code = 1000, reason = '') {
        if (this.closed) {
            return;
        }
        const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
        payload.writeUInt16BE(code, 0);
        payload.write(reason, 2);
        this.raw(OPCODE.CLOSE, payload);
        this.finish();
        try {
            this.socket.end();
        } catch {
            /* socket already gone */
        }
    }

    finish() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearInterval(this.pinger);
        this.emit('close');
    }
}

/**
 * Attach a WebSocket endpoint to a node:http server for one path.
 */
function createWebSocketServer(server, { path = '/ws', onConnection = null } = {}) {
    const clients = new Set();

    server.on('upgrade', (request, socket, head) => {
        let pathname = '/';
        try {
            pathname = new URL(request.url, 'http://localhost').pathname;
        } catch {
            pathname = request.url;
        }
        const key = request.headers['sec-websocket-key'];
        const upgrade = String(request.headers.upgrade || '').toLowerCase();
        if (pathname !== path || upgrade !== 'websocket' || !key) {
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket.setNoDelay(true);
        const connection = new WebSocketConnection(socket, request);
        if (head && head.length) {
            connection.onData(head);
        }
        clients.add(connection);
        connection.on('close', () => clients.delete(connection));
        if (onConnection) {
            onConnection(connection);
        }
    });

    return {
        clients,
        broadcast(payload, filter) {
            const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
            for (const client of clients) {
                if (filter && !filter(client)) {
                    continue;
                }
                client.send(text);
            }
        },
        closeAll() {
            for (const client of clients) {
                client.close(1001, 'server shutdown');
            }
            clients.clear();
        },
    };
}

module.exports = { createWebSocketServer, WebSocketConnection };
