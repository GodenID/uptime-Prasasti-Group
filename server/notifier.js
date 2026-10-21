'use strict';

const net = require('node:net');
const tls = require('node:tls');
const { StringDecoder } = require('node:string_decoder');
const { escapeHtml, now } = require('./util');

const COLORS = { up: 0x3fbf8f, down: 0xd2553f, warning: 0xd99b52, info: 0x6f8fbf };

async function postJson(url, body, headers = {}, timeout = 12000) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`.trim());
    }
    return text;
}

function statusLabel(status) {
    if (status === 'up') {
        return 'OPERASIONAL';
    }
    if (status === 'down') {
        return 'GANGGUAN';
    }
    if (status === 'maintenance') {
        return 'PEMELIHARAAN';
    }
    return 'PEMBERITAHUAN';
}

class SmtpClient {
    constructor(options) {
        this.options = options;
        this.socket = null;
        this.decoder = new StringDecoder('utf8');
        this.buffer = '';
        this.waiters = [];
        this.connected = false;
    }

    async connect() {
        const { host, port, secure, timeout = 15000 } = this.options;
        await new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            const socket = secure
                ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => resolve())
                : net.connect({ host, port }, () => resolve());
            socket.setTimeout(timeout);
            socket.once('error', onError);
            socket.once('timeout', () => reject(new Error('SMTP timeout')));
            socket.on('data', (chunk) => this.onData(chunk));
            this.socket = socket;
        });
        this.socket.removeAllListeners('error');
        this.socket.on('error', () => {
            this.flushWaiters(new Error('SMTP socket error'));
        });
        this.connected = true;
        await this.expect(220);
    }

    onData(chunk) {
        this.buffer += this.decoder.write(chunk);
        let index;
        while ((index = this.buffer.indexOf('\r\n')) !== -1) {
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + 2);
            const waiter = this.waiters[0];
            if (!waiter) {
                continue;
            }
            waiter.lines.push(line);
            if (/^\d{3} /.test(line)) {
                this.waiters.shift();
                const code = Number(line.slice(0, 3));
                waiter.resolve({ code, lines: waiter.lines });
            }
        }
    }

    flushWaiters(error) {
        while (this.waiters.length) {
            const waiter = this.waiters.shift();
            waiter.reject(error);
        }
    }

    read() {
        return new Promise((resolve, reject) => {
            this.waiters.push({ lines: [], resolve, reject });
        });
    }

    async expect(code) {
        const response = await this.read();
        if (response.code !== code) {
            throw new Error(`SMTP ${response.code}: ${response.lines.join(' ').slice(0, 160)}`);
        }
        return response;
    }

    async command(line, code) {
        this.socket.write(`${line}\r\n`);
        return this.expect(code);
    }

    async startTls() {
        const socket = await new Promise((resolve, reject) => {
            const secured = tls.connect(
                { socket: this.socket, servername: this.options.host, rejectUnauthorized: false },
                () => resolve(secured)
            );
            secured.once('error', reject);
        });
        this.socket = socket;
        this.decoder = new StringDecoder('utf8');
        this.buffer = '';
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', () => this.flushWaiters(new Error('SMTP TLS error')));
    }

    async send({ from, to, subject, text, html }) {
        await this.connect();
        const ehlo = await this.command('EHLO prasasti.local', 250);
        const capabilities = ehlo.lines.join('\n').toUpperCase();

        if (!this.options.secure && capabilities.includes('STARTTLS')) {
            await this.command('STARTTLS', 220);
            await this.startTls();
            await this.command('EHLO prasasti.local', 250);
        }

        if (this.options.user) {
            const authCapabilities = capabilities.includes('PLAIN') ? 'PLAIN' : 'LOGIN';
            if (authCapabilities === 'PLAIN') {
                const token = Buffer.from(`\0${this.options.user}\0${this.options.pass}`).toString('base64');
                await this.command(`AUTH PLAIN ${token}`, 235);
            } else {
                await this.command('AUTH LOGIN', 334);
                await this.command(Buffer.from(this.options.user).toString('base64'), 334);
                await this.command(Buffer.from(this.options.pass).toString('base64'), 235);
            }
        }

        await this.command(`MAIL FROM:<${from}>`, 250);
        const recipients = String(to)
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
        for (const recipient of recipients) {
            await this.command(`RCPT TO:<${recipient}>`, 250);
        }
        await this.command('DATA', 354);

        const boundary = `prasasti-${now()}`;
        const message = [
            `From: ${from}`,
            `To: ${recipients.join(', ')}`,
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

        this.socket.write(`${message}\r\n.\r\n`);
        await this.expect(250);
        await this.command('QUIT', 221).catch(() => null);
        this.socket.end();
    }
}

function encodeHeader(value) {
    const text = String(value || '');
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7E]*$/.test(text)) {
        return text;
    }
    return `=?UTF-8?B?${Buffer.from(text).toString('base64')}?=`;
}

function textBlock(payload) {
    const lines = [
        `${payload.title}`,
        '',
        `Status   : ${statusLabel(payload.status)}`,
        `Monitor  : ${payload.monitor ? payload.monitor.name : '-'}`,
        `Waktu    : ${new Date(payload.time || now()).toISOString()}`,
    ];
    if (payload.monitor && payload.monitor.url) {
        lines.push(`Target   : ${payload.monitor.url}`);
    }
    lines.push('', payload.message || '');
    return lines.join('\n');
}

function htmlBlock(payload) {
    const color = payload.status === 'down' ? '#d2553f' : payload.status === 'up' ? '#3fbf8f' : '#d99b52';
    return `<div style="font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;background:#12100e;padding:28px;color:#f2ece3">
  <div style="max-width:560px;margin:0 auto;border:1px solid #3a322a;border-radius:14px;overflow:hidden">
    <div style="background:${color};height:6px"></div>
    <div style="padding:24px">
      <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#a99b88">Uptime Prasasti Websites</div>
      <h2 style="margin:10px 0 4px;font-size:20px">${escapeHtml(payload.title)}</h2>
      <div style="color:${color};font-weight:600;font-size:13px;letter-spacing:.08em">${statusLabel(payload.status)}</div>
      <p style="color:#d8cfc3;line-height:1.6;margin:18px 0">${escapeHtml(payload.message || '')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#bfb3a4">
        <tr><td style="padding:6px 0">Monitor</td><td style="text-align:right">${escapeHtml(payload.monitor ? payload.monitor.name : '-')}</td></tr>
        <tr><td style="padding:6px 0">Target</td><td style="text-align:right">${escapeHtml((payload.monitor && payload.monitor.url) || '-')}</td></tr>
        <tr><td style="padding:6px 0">Waktu</td><td style="text-align:right">${new Date(payload.time || now()).toISOString()}</td></tr>
      </table>
    </div>
  </div>
</div>`;
}

async function dispatch(notification, payload) {
    const config = notification.config || {};
    const title = payload.title || 'Pemberitahuan Prasasti';
    const monitor = payload.monitor || {};
    const monitorUrl = payload.monitorUrl || '';

    switch (notification.type) {
        case 'webhook': {
            if (!config.url) {
                throw new Error('URL webhook belum diisi');
            }
            const headers = {};
            if (config.headerName && config.headerValue) {
                headers[config.headerName] = config.headerValue;
            }
            let body = {
                title,
                message: payload.message,
                status: payload.status,
                event: payload.event || 'heartbeat',
                monitor: { id: monitor.id, name: monitor.name, url: monitor.url, type: monitor.type },
                monitorUrl,
                time: new Date(payload.time || now()).toISOString(),
            };
            if (config.bodyTemplate) {
                try {
                    const rendered = String(config.bodyTemplate).replace(/\{\{(\w+)\}\}/g, (_, key) =>
                        key === 'monitor' ? JSON.stringify(monitor) : String(body[key] ?? '')
                    );
                    body = JSON.parse(rendered);
                } catch {
                    throw new Error('Template JSON webhook tidak valid');
                }
            }
            await postJson(config.url, body, headers);
            return 'Webhook terkirim';
        }

        case 'discord': {
            if (!config.webhookUrl) {
                throw new Error('Discord webhook URL belum diisi');
            }
            await postJson(config.webhookUrl, {
                username: config.username || 'Prasasti Uptime',
                embeds: [
                    {
                        title,
                        description: payload.message || '',
                        color: COLORS[payload.status] || COLORS.warning,
                        timestamp: new Date(payload.time || now()).toISOString(),
                        footer: { text: 'Uptime Prasasti Websites' },
                    },
                ],
            });
            return 'Discord terkirim';
        }

        case 'telegram': {
            if (!config.botToken || !config.chatId) {
                throw new Error('Bot token atau chat ID belum diisi');
            }
            const text = `<b>${escapeHtml(title)}</b>\n<code>${statusLabel(payload.status)}</code>\n\n${escapeHtml(
                payload.message || ''
            )}\n\n<b>Monitor:</b> ${escapeHtml(monitor.name || '-')}${
                monitor.url ? `\n<b>Target:</b> ${escapeHtml(monitor.url)}` : ''
            }`;
            const body = { chat_id: config.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
            if (config.messageThreadId) {
                body.message_thread_id = Number(config.messageThreadId);
            }
            const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12000),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.ok === false) {
                throw new Error(result.description || `Telegram HTTP ${response.status}`);
            }
            return 'Telegram terkirim';
        }

        case 'slack': {
            if (!config.webhookUrl) {
                throw new Error('Slack webhook URL belum diisi');
            }
            await postJson(config.webhookUrl, {
                text: `${title} :: ${statusLabel(payload.status)}`,
                attachments: [
                    {
                        color: payload.status === 'down' ? '#d2553f' : '#3fbf8f',
                        title: monitor.name || title,
                        text: payload.message || '',
                        footer: monitor.url || '',
                        ts: Math.floor((payload.time || now()) / 1000),
                    },
                ],
            });
            return 'Slack terkirim';
        }

        case 'ntfy': {
            const server = String(config.serverUrl || 'https://ntfy.sh').replace(/\/+$/, '');
            if (!config.topic) {
                throw new Error('Topik ntfy belum diisi');
            }
            const headers = {
                Title: encodeHeader(title),
                Priority: String(config.priority || 'default'),
                Tags: payload.status === 'down' ? 'warning,red_circle' : 'white_check_mark',
            };
            if (config.token) {
                headers.Authorization = `Bearer ${config.token}`;
            }
            if (config.clickUrl || monitorUrl) {
                headers.Click = config.clickUrl || monitorUrl;
            }
            const response = await fetch(`${server}/${encodeURIComponent(config.topic)}`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
                body: textBlock(payload),
                signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) {
                throw new Error(`ntfy HTTP ${response.status}`);
            }
            return 'ntfy terkirim';
        }

        case 'gotify': {
            const server = String(config.serverUrl || '').replace(/\/+$/, '');
            if (!server || !config.appToken) {
                throw new Error('Server atau token Gotify belum diisi');
            }
            await postJson(
                `${server}/message?token=${encodeURIComponent(config.appToken)}`,
                {
                    title,
                    message: textBlock(payload),
                    priority: Number(config.priority || 5),
                    extras: {
                        'client::display': { contentType: 'text/plain' },
                    },
                },
                {},
                12000
            );
            return 'Gotify terkirim';
        }

        case 'smtp': {
            if (!config.host || !config.from || !config.to) {
                throw new Error('Host, pengirim, atau penerima SMTP belum diisi');
            }
            const client = new SmtpClient({
                host: config.host,
                port: Number(config.port || (config.secure ? 465 : 25)),
                secure: Boolean(config.secure),
                user: config.user,
                pass: config.pass,
                timeout: 15000,
            });
            try {
                await client.send({
                    from: config.from,
                    to: config.to,
                    subject: `${config.subjectPrefix || '[Prasasti]'} ${title}`,
                    text: textBlock(payload),
                    html: htmlBlock(payload),
                });
            } finally {
                try {
                    client.socket?.destroy();
                } catch {
                    /* socket already closed */
                }
            }
            return 'Email terkirim';
        }

        case 'pushover': {
            if (!config.token || !config.user) {
                throw new Error('Token aplikasi atau kunci pengguna Pushover belum diisi');
            }
            const form = new URLSearchParams({
                token: config.token,
                user: config.user,
                title,
                message: payload.message || statusLabel(payload.status),
                priority: String(config.priority ?? 0),
                timestamp: String(Math.floor((payload.time || now()) / 1000)),
            });
            if (config.device) {
                form.set('device', config.device);
            }
            if (config.sound) {
                form.set('sound', config.sound);
            }
            if (config.url) {
                form.set('url', config.url);
            }
            const response = await fetch('https://api.pushover.net/1/messages.json', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
                signal: AbortSignal.timeout(12000),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.status !== 1) {
                throw new Error(
                    result.errors?.join(', ') || `Pushover HTTP ${response.status}`
                );
            }
            return 'Pushover terkirim';
        }

        case 'homeassistant': {
            if (!config.webhookUrl) {
                throw new Error('Webhook Home Assistant belum diisi');
            }
            const headers = { 'Content-Type': 'application/json' };
            if (config.accessToken) {
                headers.Authorization = `Bearer ${config.accessToken}`;
            }
            const response = await fetch(config.webhookUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    title,
                    message: payload.message || statusLabel(payload.status),
                    status: payload.status,
                    event: payload.event || 'status',
                    monitor: monitor.name || null,
                    monitor_url: monitorUrl || null,
                    time: new Date(payload.time || now()).toISOString(),
                }),
                signal: AbortSignal.timeout(12000),
            });
            if (!response.ok) {
                throw new Error(`Home Assistant HTTP ${response.status}`);
            }
            return 'Home Assistant terkirim';
        }

        case 'apprise': {
            const server = String(config.serverUrl || '').trim();
            if (!server) {
                throw new Error('Server Apprise belum diisi');
            }
            const type =
                payload.status === 'down' ? 'failure' : payload.status === 'up' ? 'success' : 'warning';
            const body = {
                title,
                body: textBlock(payload),
                type,
                format: 'text',
            };
            const headers = { 'Content-Type': 'application/json' };
            if (config.token) {
                headers.Authorization = `Bearer ${config.token}`;
            }
            const urls = String(config.urls || '')
                .split(/[\n,]/)
                .map((value) => value.trim())
                .filter(Boolean);
            // Apprise API: /notify/<token> memakai target yang tersimpan,
            // sedangkan /notify menerima daftar URL pada payload.
            const target = server.includes('/notify/') ? server : `${server.replace(/\/+$/, '')}/notify`;
            if (!server.includes('/notify/') && urls.length) {
                body.urls = urls.join(',');
            }
            const response = await fetch(target, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12000),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || result.error === true) {
                throw new Error(
                    result.error_message || result.message || `Apprise HTTP ${response.status}`
                );
            }
            return 'Apprise terkirim';
        }

        default:
            throw new Error(`Tipe notifikasi ${notification.type} tidak dikenal`);
    }
}

module.exports = { dispatch, statusLabel, SmtpClient };
