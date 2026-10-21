import { api, endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    fmtDate,
    timeAgo,
    openModal,
    closeModal,
    confirmDialog,
    toast,
} from '../ui.js';

const PROVIDERS = [
    { id: 'webhook', label: 'Webhook', glyph: '{}' },
    { id: 'discord', label: 'Discord', glyph: 'D' },
    { id: 'telegram', label: 'Telegram', glyph: 'T' },
    { id: 'slack', label: 'Slack', glyph: 'S' },
    { id: 'ntfy', label: 'ntfy', glyph: 'n' },
    { id: 'gotify', label: 'Gotify', glyph: 'G' },
    { id: 'smtp', label: 'Email SMTP', glyph: '@' },
    { id: 'pushover', label: 'Pushover', glyph: 'P' },
    { id: 'homeassistant', label: 'Home Assistant', glyph: 'H' },
    { id: 'apprise', label: 'Apprise', glyph: 'A' },
];

const EVENTS = [
    { id: 'down', label: 'Gangguan', color: '#b8452f' },
    { id: 'up', label: 'Pemulihan', color: '#2f9e74' },
    { id: 'certificate', label: 'Sertifikat', color: '#a9793f' },
    { id: 'domain', label: 'Domain', color: '#8a7a5c' },
];

export async function render(root, ctx) {
    const { state } = ctx;
    const notifications = state.notifications || [];
    let logs = [];
    try {
        const data = await endpoints.notificationLogs();
        logs = data.logs || [];
    } catch {
        logs = [];
    }

    root.innerHTML = `
        <div class="page-head">
            <div class="grow">
                <h1 class="page-title">Notifikasi</h1>
                <div class="page-sub">Kirim pemberitahuan saat monitor berubah status, sertifikat mendekati kedaluwarsa, atau domain akan habis masa berlakunya.</div>
            </div>
            <div class="head-actions">
                <button class="btn primary" data-action="add">${icon('plus', 15)}<span>Kanal baru</span></button>
            </div>
        </div>
        ${
            notifications.length
                ? `<div class="list-grid ledger-list">${notifications.map((notification) => rowHtml(notification)).join('')}</div>`
                : `<div class="empty">
                    <div class="empty-icon">${icon('bell', 20)}</div>
                    <h3>Belum ada kanal notifikasi</h3>
                    <p>Hubungkan webhook, Discord, Telegram, Slack, ntfy, Gotify, atau SMTP untuk menerima kabar saat layanan bermasalah.</p>
                    <button class="btn primary" data-action="add">${icon('plus', 15)} Tambah kanal</button>
                </div>`
        }

        <div class="section">
            <div class="section-head">
                <h2 class="section-title">Riwayat pengiriman</h2>
                <span class="spacer"></span>
                <span class="page-note">60 pengiriman terakhir</span>
            </div>
            <div class="panel">
                <div class="table-wrap">
                    <table class="table">
                        <thead><tr><th>Waktu</th><th>Kanal</th><th>Monitor</th><th>Peristiwa</th><th>Hasil</th></tr></thead>
                        <tbody>
                            ${
                                logs.length
                                    ? logs
                                          .map(
                                              (log) => `<tr>
                                                <td class="mono tiny" title="${escapeHtml(fmtDate(log.created_at))}">${timeAgo(
                                                  log.created_at
                                              )}</td>
                                                <td>${escapeHtml(log.notification_name || '—')}</td>
                                                <td>${escapeHtml(log.monitor_name || '—')}</td>
                                                <td><span class="tag">${escapeHtml(log.event)}</span></td>
                                                <td>${
                                                    log.ok
                                                        ? `<span class="pill up">Terkirim</span>`
                                                        : `<span class="pill down" title="${escapeHtml(
                                                              log.error || ''
                                                          )}">Gagal</span> <span class="tiny muted">${escapeHtml(
                                                              (log.error || '').slice(0, 60)
                                                          )}</span>`
                                                }</td>
                                            </tr>`
                                          )
                                          .join('')
                                    : '<tr><td colspan="5" class="muted">Belum ada pengiriman notifikasi.</td></tr>'
                            }
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;

    root.querySelectorAll('[data-action="add"]').forEach((button) =>
        button.addEventListener('click', () => openForm(null, ctx))
    );

    root.querySelectorAll('[data-edit]').forEach((button) =>
        button.addEventListener('click', () => {
            const notification = notifications.find((item) => item.id === Number(button.dataset.edit));
            if (notification) openForm(notification, ctx);
        })
    );

    root.querySelectorAll('[data-test]').forEach((button) =>
        button.addEventListener('click', async () => {
            const notification = notifications.find((item) => item.id === Number(button.dataset.test));
            if (!notification) return;
            button.disabled = true;
            const original = button.innerHTML;
            button.innerHTML = 'Mengirim…';
            try {
                const result = await endpoints.testNotification(notification.id);
                toast('Uji berhasil', result.message || notification.name, 'ok');
            } catch (error) {
                toast('Uji gagal', error.message, 'err', 6000);
            }
            button.disabled = false;
            button.innerHTML = original;
        })
    );

    root.querySelectorAll('[data-delete]').forEach((button) =>
        button.addEventListener('click', async () => {
            const notification = notifications.find((item) => item.id === Number(button.dataset.delete));
            if (!notification) return;
            const ok = await confirmDialog({
                title: 'Hapus kanal',
                message: `Kanal “${notification.name}” akan dihapus dan berhenti menerima pemberitahuan.`,
                confirmLabel: 'Hapus kanal',
            });
            if (!ok) return;
            try {
                await endpoints.deleteNotification(notification.id);
                toast('Kanal dihapus', notification.name, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );
}

function rowHtml(notification) {
    const provider = PROVIDERS.find((item) => item.id === notification.type);
    const description = describe(notification);
    const eventLabels = (notification.events || []).map(
        (event) => EVENTS.find((item) => item.id === event)?.label || event
    );
    const extras = [];
    if (eventLabels.length) {
        extras.push(`peristiwa: ${eventLabels.join(', ')}`);
    }
    if (notification.resendInterval) {
        extras.push(`ulang tiap ${notification.resendInterval} mnt`);
    }
    return `<div class="row-card">
        <div class="provider" style="width:44px;height:44px;padding:0;cursor:default">
            <span class="glyph">${escapeHtml(provider?.glyph || '?')}</span>
        </div>
        <div class="grow">
            <div class="inline" style="gap:8px">
                <h3>${escapeHtml(notification.name)}</h3>
                <span class="pill ${notification.active ? 'up' : 'paused'}">${
        notification.active ? 'Aktif' : 'Nonaktif'
    }</span>
                ${notification.isDefault ? '<span class="tag">Default</span>' : ''}
            </div>
            <div class="meta">${escapeHtml(provider?.label || notification.type)} · ${escapeHtml(description)}${
        extras.length ? ` · ${escapeHtml(extras.join(' · '))}` : ''
    }</div>
        </div>
        <div class="actions">
            <button class="btn sm ghost" data-test="${notification.id}">${icon('bell', 13)} Uji</button>
            <button class="btn sm ghost" data-edit="${notification.id}">${icon('edit', 13)} Ubah</button>
            <button class="btn sm danger" data-delete="${notification.id}" aria-label="Hapus">${icon('trash', 13)}</button>
        </div>
    </div>`;
}

function describe(notification) {
    const config = notification.config || {};
    switch (notification.type) {
        case 'webhook':
            return config.url || 'URL belum diisi';
        case 'discord':
        case 'slack':
            return config.webhookUrl ? 'Webhook terpasang' : 'Webhook belum diisi';
        case 'telegram':
            return config.chatId ? `Chat ${config.chatId}` : 'Chat ID belum diisi';
        case 'ntfy':
            return `${config.serverUrl || 'https://ntfy.sh'}/${config.topic || '—'}`;
        case 'gotify':
            return config.serverUrl || 'Server belum diisi';
        case 'smtp':
            return config.to ? `Ke ${config.to}` : 'Penerima belum diisi';
        case 'pushover':
            return config.user ? `Pengguna ${config.user}` : 'Pengguna belum diisi';
        case 'homeassistant':
            return config.webhookUrl ? 'Webhook terpasang' : 'Webhook belum diisi';
        case 'apprise':
            return config.serverUrl || 'Server belum diisi';
        default:
            return '';
    }
}

function field(label, inner, hint = '', full = false) {
    return `<div class="field ${full ? 'full' : ''}">
        <label>${escapeHtml(label)}</label>
        ${inner}
        ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

function input(name, value, placeholder = '', type = 'text') {
    return `<input class="input" name="${name}" type="${type}" value="${escapeHtml(
        value === undefined || value === null ? '' : value
    )}" placeholder="${escapeHtml(placeholder)}" />`;
}

function openForm(notification, ctx) {
    const editing = Boolean(notification);
    const config = notification?.config || {};
    const type = notification?.type || 'webhook';

    const modal = openModal({
        title: editing ? 'Ubah kanal notifikasi' : 'Kanal notifikasi baru',
        subtitle: 'Kanal default menerima semua peristiwa, termasuk monitor tanpa penugasan khusus.',
        wide: true,
        body: `
            <form id="notification-form" autocomplete="off">
                <div class="provider-grid">
                    ${PROVIDERS.map(
                        (provider) => `<button type="button" class="provider ${
                            provider.id === type ? 'active' : ''
                        }" data-provider="${provider.id}"><span class="glyph">${escapeHtml(
                            provider.glyph
                        )}</span>${escapeHtml(provider.label)}</button>`
                    ).join('')}
                </div>
                <input type="hidden" name="type" value="${type}" />

                <div class="form-grid mt-16">
                    ${field(
                        'Nama kanal',
                        input('name', notification?.name, 'Tim Infrastruktur'),
                        '',
                        true
                    )}

                    <div data-fields="webhook" class="field full">
                        <label>URL webhook</label>
                        ${input('webhookUrl', config.url, 'https://contoh.id/hooks/prasasti')}
                        <span class="hint">Menerima POST JSON berisi title, message, status, monitor, dan waktu.</span>
                    </div>
                    <div data-fields="webhook" class="field">
                        <label>Nama header (opsional)</label>
                        ${input('webhookHeaderName', config.headerName, 'Authorization')}
                    </div>
                    <div data-fields="webhook" class="field">
                        <label>Nilai header</label>
                        ${input('webhookHeaderValue', config.headerValue, 'Bearer …')}
                    </div>

                    <div data-fields="discord" class="field full">
                        <label>Discord webhook URL</label>
                        ${input('discordUrl', config.webhookUrl, 'https://discord.com/api/webhooks/…')}
                    </div>
                    <div data-fields="discord" class="field">
                        <label>Nama pengirim</label>
                        ${input('discordUsername', config.username, 'Prasasti Uptime')}
                    </div>

                    <div data-fields="telegram" class="field">
                        <label>Bot token</label>
                        ${input('telegramToken', config.botToken, '123456:ABC…')}
                    </div>
                    <div data-fields="telegram" class="field">
                        <label>Chat ID</label>
                        ${input('telegramChat', config.chatId, '-1001234567890')}
                    </div>
                    <div data-fields="telegram" class="field full">
                        <label>Message thread ID (opsional)</label>
                        ${input('telegramThread', config.messageThreadId, '')}
                    </div>

                    <div data-fields="slack" class="field full">
                        <label>Slack webhook URL</label>
                        ${input('slackUrl', config.webhookUrl, 'https://hooks.slack.com/services/…')}
                    </div>

                    <div data-fields="ntfy" class="field">
                        <label>Server</label>
                        ${input('ntfyServer', config.serverUrl || 'https://ntfy.sh', 'https://ntfy.sh')}
                    </div>
                    <div data-fields="ntfy" class="field">
                        <label>Topik</label>
                        ${input('ntfyTopic', config.topic, 'prasasti-alerts')}
                    </div>
                    <div data-fields="ntfy" class="field">
                        <label>Prioritas</label>
                        <select class="select" name="ntfyPriority">
                            ${['min', 'low', 'default', 'high', 'urgent']
                                .map(
                                    (priority) =>
                                        `<option ${config.priority === priority ? 'selected' : ''}>${priority}</option>`
                                )
                                .join('')}
                        </select>
                    </div>
                    <div data-fields="ntfy" class="field">
                        <label>Token akses (opsional)</label>
                        ${input('ntfyToken', config.token, 'tk_…')}
                    </div>

                    <div data-fields="gotify" class="field">
                        <label>Server Gotify</label>
                        ${input('gotifyServer', config.serverUrl, 'https://gotify.contoh.id')}
                    </div>
                    <div data-fields="gotify" class="field">
                        <label>Application token</label>
                        ${input('gotifyToken', config.appToken, 'A.…')}
                    </div>
                    <div data-fields="gotify" class="field full">
                        <label>Prioritas</label>
                        <input class="input" name="gotifyPriority" type="number" min="0" max="10" value="${escapeHtml(
                            config.priority ?? 5
                        )}" />
                    </div>

                    <div data-fields="smtp" class="field">
                        <label>Host SMTP</label>
                        ${input('smtpHost', config.host, 'smtp.contoh.id')}
                    </div>
                    <div data-fields="smtp" class="field">
                        <label>Port</label>
                        <input class="input" name="smtpPort" type="number" min="1" max="65535" value="${escapeHtml(
                            config.port ?? 587
                        )}" />
                    </div>
                    <div data-fields="smtp" class="field">
                        <label>Pengirim</label>
                        ${input('smtpFrom', config.from, 'prasasti@contoh.id')}
                    </div>
                    <div data-fields="smtp" class="field">
                        <label>Penerima</label>
                        ${input('smtpTo', config.to, 'ops@contoh.id, tim@contoh.id')}
                    </div>
                    <div data-fields="smtp" class="field">
                        <label>Username</label>
                        ${input('smtpUser', config.user, '')}
                    </div>
                    <div data-fields="smtp" class="field">
                        <label>Kata sandi</label>
                        ${input('smtpPass', config.pass, '', 'password')}
                    </div>
                    <div data-fields="smtp" class="field full">
                        <label>Awalan subjek</label>
                        ${input('smtpSubject', config.subjectPrefix || '[Prasasti]', '[Prasasti]')}
                    </div>
                    <div data-fields="smtp" class="field full">
                        <div class="switch-row" style="border:none;padding:0">
                            <button type="button" class="switch ${config.secure ? 'on' : ''}" name="smtpSecure"></button>
                            <div class="switch-text"><b>Koneksi TLS langsung (SMTPS)</b><span>Aktifkan untuk port 465.</span></div>
                        </div>
                    </div>

                    <div data-fields="pushover" class="field">
                        <label>Token aplikasi</label>
                        ${input('pushoverToken', config.token, 'aBcDeFgHiJkLmNoPq')}
                    </div>
                    <div data-fields="pushover" class="field">
                        <label>Kunci pengguna atau grup</label>
                        ${input('pushoverUser', config.user, 'uQi1234567890')}
                    </div>
                    <div data-fields="pushover" class="field">
                        <label>Prioritas</label>
                        <select class="select" name="pushoverPriority">
                            ${[-2, -1, 0, 1, 2]
                                .map(
                                    (priority) =>
                                        `<option value="${priority}" ${
                                            Number(config.priority ?? 0) === priority ? 'selected' : ''
                                        }>${priority}</option>`
                                )
                                .join('')}
                        </select>
                    </div>
                    <div data-fields="pushover" class="field">
                        <label>Perangkat (opsional)</label>
                        ${input('pushoverDevice', config.device, '')}
                    </div>
                    <div data-fields="pushover" class="field">
                        <label>Suara (opsional)</label>
                        ${input('pushoverSound', config.sound, '')}
                    </div>
                    <div data-fields="pushover" class="field full">
                        <label>Tautan (opsional)</label>
                        ${input('pushoverUrl', config.url, 'https://status.contoh.id')}
                    </div>

                    <div data-fields="homeassistant" class="field full">
                        <label>URL webhook Home Assistant</label>
                        ${input('haWebhookUrl', config.webhookUrl, 'https://ha.contoh.id/api/webhook/xxxxxxxx')}
                        <span class="hint">Buat webhook lewat integrasi “Webhook” di Home Assistant.</span>
                    </div>
                    <div data-fields="homeassistant" class="field full">
                        <label>Token akses (opsional)</label>
                        ${input('haToken', config.accessToken, '', 'password')}
                    </div>

                    <div data-fields="apprise" class="field full">
                        <label>Server Apprise API</label>
                        ${input('appriseServer', config.serverUrl, 'http://apprise:8000')}
                        <span class="hint">Boleh berisi token target, contoh: http://apprise:8000/notify/token-saya.</span>
                    </div>
                    <div data-fields="apprise" class="field full">
                        <label>Daftar URL target (opsional)</label>
                        <textarea class="textarea" name="appriseUrls" placeholder="mailto://contoh@domain.id&#10;discord://webhook_id/token">${escapeHtml(
                            config.urls || ''
                        )}</textarea>
                        <span class="hint">Satu URL Apprise per baris. Kosongkan bila memakai token target.</span>
                    </div>
                    <div data-fields="apprise" class="field full">
                        <label>Token akses (opsional)</label>
                        ${input('appriseToken', config.token, '', 'password')}
                    </div>
                </div>

                <div class="divider"></div>
                ${switchRow('active', 'Kanal aktif', 'Nonaktifkan untuk menghentikan pengiriman tanpa menghapus konfigurasi.', notification?.active ?? true)}
                ${switchRow('isDefault', 'Kanal default', 'Terima semua peristiwa, termasuk monitor tanpa penugasan.', notification?.isDefault ?? false)}

                <div class="divider"></div>
                <div class="eyebrow" style="margin-bottom:6px">Peristiwa yang dikirim</div>
                <div class="chip-picker" id="event-picker">
                    ${EVENTS.map(
                        (event) => `<button type="button" class="chip ${
                            (notification?.events || []).includes(event.id) ? 'on' : ''
                        }" data-event="${event.id}"><span class="dot" style="background:${event.color}"></span>${
                            escapeHtml(event.label)
                        }</button>`
                    ).join('')}
                </div>
                <span class="hint">Tanpa pilihan, kanal menerima semua peristiwa.</span>

                <div class="form-grid mt-16">
                    ${field(
                        'Ulangi notifikasi tiap (menit)',
                        `<input class="input" name="resendInterval" type="number" min="0" max="1440" value="${escapeHtml(
                            notification?.resendInterval ?? 0
                        )}" />`,
                        '0 berarti kirim sekali saat gangguan terjadi.'
                    )}
                </div>
                <div id="notification-error"></div>
            </form>
        `,
        footer: `
            <button class="btn ghost" data-close>Batal</button>
            <button class="btn primary" type="submit" form="notification-form" id="save-notification">${
                editing ? 'Simpan perubahan' : 'Buat kanal'
            }</button>
        `,
    });

    const form = modal.querySelector('#notification-form');
    const typeInput = form.querySelector('input[name="type"]');

    const applyType = (value) => {
        form.querySelectorAll('[data-fields]').forEach((group) => {
            group.classList.toggle('hidden', group.dataset.fields !== value);
        });
    };
    applyType(typeInput.value);

    form.querySelectorAll('[data-provider]').forEach((button) => {
        button.addEventListener('click', () => {
            form.querySelectorAll('[data-provider]').forEach((item) => item.classList.remove('active'));
            button.classList.add('active');
            typeInput.value = button.dataset.provider;
            applyType(button.dataset.provider);
        });
    });

    form.querySelectorAll('.switch').forEach((button) =>
        button.addEventListener('click', () => button.classList.toggle('on'))
    );

    form.querySelectorAll('[data-event]').forEach((button) =>
        button.addEventListener('click', () => button.classList.toggle('on'))
    );

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = form.querySelector('#notification-error');
        errorBox.innerHTML = '';
        const button = modal.querySelector('#save-notification');
        button.disabled = true;
        button.textContent = 'Menyimpan…';

        const selected = typeInput.value;
        let providerConfig = {};
        if (selected === 'webhook') {
            providerConfig = {
                url: form.webhookUrl.value.trim(),
                headerName: form.webhookHeaderName.value.trim(),
                headerValue: form.webhookHeaderValue.value,
            };
        } else if (selected === 'discord') {
            providerConfig = { webhookUrl: form.discordUrl.value.trim(), username: form.discordUsername.value.trim() };
        } else if (selected === 'telegram') {
            providerConfig = {
                botToken: form.telegramToken.value.trim(),
                chatId: form.telegramChat.value.trim(),
                messageThreadId: form.telegramThread.value.trim(),
            };
        } else if (selected === 'slack') {
            providerConfig = { webhookUrl: form.slackUrl.value.trim() };
        } else if (selected === 'ntfy') {
            providerConfig = {
                serverUrl: form.ntfyServer.value.trim(),
                topic: form.ntfyTopic.value.trim(),
                priority: form.ntfyPriority.value,
                token: form.ntfyToken.value.trim(),
            };
        } else if (selected === 'gotify') {
            providerConfig = {
                serverUrl: form.gotifyServer.value.trim(),
                appToken: form.gotifyToken.value.trim(),
                priority: Number(form.gotifyPriority.value || 5),
            };
        } else if (selected === 'smtp') {
            providerConfig = {
                host: form.smtpHost.value.trim(),
                port: Number(form.smtpPort.value || 587),
                from: form.smtpFrom.value.trim(),
                to: form.smtpTo.value.trim(),
                user: form.smtpUser.value.trim(),
                pass: form.smtpPass.value,
                subjectPrefix: form.smtpSubject.value,
                secure: form.smtpSecure.classList.contains('on'),
            };
        } else if (selected === 'pushover') {
            providerConfig = {
                token: form.pushoverToken.value.trim(),
                user: form.pushoverUser.value.trim(),
                priority: Number(form.pushoverPriority.value || 0),
                device: form.pushoverDevice.value.trim(),
                sound: form.pushoverSound.value.trim(),
                url: form.pushoverUrl.value.trim(),
            };
        } else if (selected === 'homeassistant') {
            providerConfig = {
                webhookUrl: form.haWebhookUrl.value.trim(),
                accessToken: form.haToken.value,
            };
        } else if (selected === 'apprise') {
            providerConfig = {
                serverUrl: form.appriseServer.value.trim(),
                urls: form.appriseUrls.value.trim(),
                token: form.appriseToken.value,
            };
        }

        const payload = {
            name: form.name.value.trim(),
            type: selected,
            config: providerConfig,
            active: form.active.classList.contains('on'),
            isDefault: form.isDefault.classList.contains('on'),
            events: [...form.querySelectorAll('[data-event].on')].map((item) => item.dataset.event),
            resendInterval: Number(form.resendInterval.value || 0),
        };

        try {
            if (editing) await endpoints.updateNotification(notification.id, payload);
            else await endpoints.notification(payload);
            closeModal();
            toast(editing ? 'Kanal diperbarui' : 'Kanal dibuat', payload.name, 'ok');
            await ctx.reload();
        } catch (error) {
            button.disabled = false;
            button.textContent = editing ? 'Simpan perubahan' : 'Buat kanal';
            errorBox.innerHTML = `<div class="alert" style="margin-top:14px">${escapeHtml(error.message)}</div>`;
        }
    });
}

function switchRow(name, title, description, on) {
    return `<div class="switch-row">
        <button type="button" class="switch ${on ? 'on' : ''}" name="${name}" aria-pressed="${on ? 'true' : 'false'}"></button>
        <div class="switch-text"><b>${escapeHtml(title)}</b><span>${escapeHtml(description)}</span></div>
    </div>`;
}
