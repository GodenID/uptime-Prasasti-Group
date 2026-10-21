import { escapeHtml, fmtPercent, fmtPing, icon, statusMeta, typeLabel } from './ui.js';

const slug = decodeURIComponent(
    location.pathname.replace(/^\/status\//, '').replace(/\/+$/, '')
);

const root = document.getElementById('status-root');

const view = {
    payload: null,
    connected: false,
    error: '',
    socket: null,
    retry: 900,
    ping: null,
    polling: null,
    ticker: null,
    lastReceived: 0,
};

const OVERALL = {
    up: { label: 'Semua sistem beroperasi', cls: 'up' },
    down: { label: 'Gangguan layanan terdeteksi', cls: 'down' },
    pending: { label: 'Menunggu pemeriksaan pertama', cls: 'pending' },
    maintenance: { label: 'Pemeliharaan terjadwal', cls: 'maintenance' },
};

function overallMeta(status) {
    const meta = statusMeta(status);
    return OVERALL[meta.key] || { label: 'Status tidak diketahui', cls: 'pending' };
}

async function load() {
    try {
        const response = await fetch(`/api/status-page/${encodeURIComponent(slug)}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
        });
        if (response.status === 404) {
            showMissing();
            return false;
        }
        if (!response.ok) {
            throw new Error('Gagal memuat status layanan');
        }
        view.payload = await response.json();
        view.error = '';
        view.lastReceived = Date.now();
        render();
        return true;
    } catch (error) {
        view.error = error.message;
        if (view.payload) {
            renderNotice();
        } else {
            showError(error.message);
        }
        return false;
    }
}

function showMissing() {
    document.title = 'Status page tidak ditemukan · Prasasti';
    root.innerHTML = `
        <div class="missing">
            <div class="missing-mark">${icon('alert', 20)}</div>
            <h1>Halaman tidak ditemukan</h1>
            <p>Status page ini belum diterbitkan atau sudah dihapus. Hubungi penyedia layanan untuk tautan yang benar.</p>
            <a class="btn" href="/">Buka Prasasti</a>
        </div>
    `;
}

function showError(message) {
    root.innerHTML = `
        <div class="missing">
            <div class="missing-mark">${icon('alert', 20)}</div>
            <h1>Tidak dapat memuat status</h1>
            <p>${escapeHtml(message)}</p>
            <button class="btn" data-retry>Coba lagi</button>
        </div>
    `;
    root.querySelector('[data-retry]')?.addEventListener('click', () => {
        root.innerHTML = '<div class="loading" role="status">Memuat status layanan…</div>';
        load().then(() => connect());
    });
}

function renderNotice() {
    const existing = document.querySelector('.net-note');
    if (existing) existing.remove();
    if (view.connected || !view.payload) return;
    const note = document.createElement('div');
    note.className = 'net-note';
    note.innerHTML = 'Koneksi langsung terputus. Halaman menyegarkan diri setiap menit.';
    document.body.append(note);
}

function render() {
    const data = view.payload;
    if (!data) return;
    const page = data.page;
    document.title = `${page.title} · Status`;
    const description = page.description || `Kondisi terkini ${page.title}.`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', description);
    const iconLink = document.querySelector('link[rel="icon"]');
    if (iconLink && page.icon) iconLink.setAttribute('href', page.icon);

    const overall = overallMeta(data.overall.status);
    const down = data.overall.downMonitors;

    const totalMonitors = data.overall.totalMonitors;
    const subline =
        overall.cls === 'down'
            ? `${down} dari ${totalMonitors} layanan sedang terganggu.`
            : overall.cls === 'maintenance'
              ? 'Sebagian layanan sedang dalam pemeliharaan terjadwal.'
              : overall.cls === 'pending'
                ? 'Pemeriksaan pertama belum selesai untuk sebagian layanan.'
                : `${totalMonitors} layanan dipantau secara berkala.`;

    root.innerHTML = `
        <header class="hero">
            <div class="hero-bar">
                <div class="brand">
                    <span class="brand-mark">${icon('stele', 15)}</span>
                    <span class="brand-text">Uptime Prasasti</span>
                </div>
                <span class="live ${view.connected ? 'on' : 'off'}" title="${
                    view.connected ? 'Pembaruan langsung aktif' : 'Menyegarkan berkala'
                }">
                    <span class="live-dot"></span>${view.connected ? 'Pembaruan langsung' : 'Diperbarui berkala'}
                </span>
            </div>

            <h1 class="hero-title">${escapeHtml(page.title)}</h1>
            ${description ? `<p class="hero-lede">${escapeHtml(description)}</p>` : ''}

            <div class="overall ${overall.cls}">
                <div class="overall-status">
                    <span class="overall-dot"></span>
                    <div>
                        <b>${escapeHtml(overall.label)}</b>
                        <span>${escapeHtml(subline)}</span>
                    </div>
                </div>
                <div class="overall-figures">
                    <div class="figure">
                        <b>${data.overall.uptime24 === null ? '—' : fmtPercent(data.overall.uptime24)}</b>
                        <span>uptime 24 jam</span>
                    </div>
                    <div class="figure">
                        <b>${totalMonitors}</b>
                        <span>layanan</span>
                    </div>
                    <div class="figure">
                        <b data-freshness>${timeAgo(view.lastReceived)}</b>
                        <span>pembaruan</span>
                    </div>
                </div>
            </div>
        </header>

        <main id="main">
            ${maintenanceHtml(data.maintenance)}
            ${incidentsHtml(data.incidents)}
            ${groupsHtml(data)}
            ${historyHtml(data.history)}
        </main>

        <footer class="foot">
            <div class="foot-line">
                ${page.footerText ? `<span>${escapeHtml(page.footerText)}</span>` : ''}
                <span class="spacer"></span>
                <span>Diperbarui <span data-foot-time>${timeAgo(view.lastReceived)}</span></span>
            </div>
            ${
                page.showPoweredBy
                    ? `<div class="foot-credit">${icon('stele', 13)} Didukung <a href="/" rel="noopener">Uptime Prasasti</a></div>`
                    : ''
            }
        </footer>
    `;

    renderNotice();
}

function maintenanceHtml(maintenance) {
    const active = maintenance?.active || [];
    const upcoming = maintenance?.upcoming || [];
    if (!active.length && !upcoming.length) return '';

    const row = (item, isActive) => `
        <div class="notice maintenance">
            <span class="notice-mark">${icon('wrench', 15)}</span>
            <div class="notice-body">
                <b>${escapeHtml(item.title)}</b>
                ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}
                <span class="notice-meta">${isActive ? 'Sedang berlangsung · selesai' : 'Dijadwalkan · mulai'} ${fmtWhen(
                    isActive ? item.endAt : item.startAt
                )}</span>
            </div>
        </div>`;

    return `<section class="block">
        <h2 class="block-title">Pemeliharaan</h2>
        <div class="stack">
            ${active.map((item) => row(item, true)).join('')}
            ${upcoming.map((item) => row(item, false)).join('')}
        </div>
    </section>`;
}

function incidentsHtml(incidents) {
    if (!incidents?.length) return '';
    return `<section class="block">
        <h2 class="block-title">Insiden aktif</h2>
        <div class="stack">
            ${incidents.map(incidentHtml).join('')}
        </div>
    </section>`;
}

function incidentHtml(incident) {
    const style = ['warning', 'danger', 'info', 'success'].includes(incident.style) ? incident.style : 'warning';
    return `<article class="incident ${style}">
        <div class="incident-head">
            <b>${escapeHtml(incident.title)}</b>
            ${incident.pinned ? '<span class="pin">Disematkan</span>' : ''}
        </div>
        ${incident.content ? `<p>${escapeHtml(incident.content)}</p>` : ''}
        <div class="incident-meta">Mulai ${fmtWhen(incident.startedAt)}${
            incident.resolvedAt ? ` · selesai ${fmtWhen(incident.resolvedAt)}` : ' · masih berlangsung'
        }</div>
    </article>`;
}

function groupsHtml(data) {
    const sections = [];
    if (data.monitors?.length) {
        sections.push(`<section class="block">
            <h2 class="block-title">Layanan</h2>
            <div class="svc-list">${data.monitors.map(monitorHtml).join('')}</div>
        </section>`);
    }
    for (const group of data.groups || []) {
        sections.push(`<section class="block">
            <h2 class="block-title">${escapeHtml(group.name)}</h2>
            <div class="svc-list">${group.monitors.map(monitorHtml).join('')}</div>
        </section>`);
    }
    if (!sections.length) {
        sections.push(`<section class="block"><div class="blank">
            Belum ada layanan yang ditampilkan pada halaman ini.
        </div></section>`);
    }
    return sections.join('');
}

function monitorHtml(monitor) {
    const meta = statusMeta(monitor.status);
    const beats = (monitor.beats || []).slice(-30);
    const label = typeLabel(monitor.type);
    const uptime24 = monitor.uptime24 === null || monitor.uptime24 === undefined ? null : monitor.uptime24;
    const uptime30 = monitor.uptime30 === null || monitor.uptime30 === undefined ? null : monitor.uptime30;

    return `<article class="svc">
        <div class="svc-ident">
            <span class="dot ${meta.cls}" aria-label="${escapeHtml(meta.label)}"></span>
            <div class="svc-text">
                <div class="svc-name">
                    <b>${escapeHtml(monitor.name)}</b>
                    <span class="state ${meta.cls}">${escapeHtml(meta.label)}</span>
                </div>
                <div class="svc-sub">
                    <span>${escapeHtml(label)}</span>
                    ${monitor.url ? `<a class="svc-url" href="${escapeHtml(monitor.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                        monitor.url.replace(/^https?:\/\//, '').slice(0, 48)
                    )}</a>` : ''}
                    ${(monitor.tags || [])
                        .map((tag) => `<span class="chip">${escapeHtml(typeof tag === 'string' ? tag : tag.name)}</span>`)
                        .join('')}
                </div>
            </div>
        </div>

        <div class="svc-bars" aria-hidden="true">
            ${
                beats.length
                    ? beats
                          .map(
                              (beat) => `<span class="bar ${statusMeta(beat.status).cls}" title="${escapeHtml(
                                  statusMeta(beat.status).label
                              )} · ${fmtWhen(beat.time)}${beat.msg ? ` · ${escapeHtml(beat.msg)}` : ''}"></span>`
                          )
                          .join('')
                    : '<span class="bar empty"></span>'.repeat(12)
            }
        </div>

        <div class="svc-figures">
            <div class="figure sm">
                <b>${monitor.avgPing24 === null || monitor.avgPing24 === undefined ? '—' : fmtPing(monitor.avgPing24)}</b>
                <span>respons</span>
            </div>
            <div class="figure sm">
                <b>${uptime24 === null ? '—' : fmtPercent(uptime24)}</b>
                <span>24 jam</span>
            </div>
            <div class="figure sm">
                <b class="${uptime30 !== null && uptime30 < 99 ? 'low' : ''}">${
                    uptime30 === null ? '—' : fmtPercent(uptime30)
                }</b>
                <span>30 hari</span>
            </div>
        </div>
    </article>`;
}

function historyHtml(history) {
    if (!history?.length) return '';
    return `<section class="block">
        <details class="history">
            <summary>Riwayat insiden (${history.length})</summary>
            <div class="stack mt">
                ${history.map(incidentHtml).join('')}
            </div>
        </details>
    </section>`;
}

function fmtWhen(timestamp) {
    if (!timestamp) return '—';
    return new Date(Number(timestamp)).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function timeAgo(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
    if (seconds < 10) return 'baru saja';
    if (seconds < 60) return `${seconds} dtk lalu`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} mnt lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    return `${Math.floor(hours / 24)} hari lalu`;
}

// ---------- realtime ----------
function connect() {
    if (!view.payload) return;
    closeSocket();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    try {
        socket = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
        scheduleReconnect();
        return;
    }
    view.socket = socket;

    socket.addEventListener('open', () => {
        view.connected = true;
        view.retry = 900;
        socket.send(JSON.stringify({ type: 'subscribe', slug }));
        clearInterval(view.ping);
        view.ping = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 25000);
        render();
    });

    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.type === 'status:snapshot' && message.payload && message.slug === slug) {
            view.payload = message.payload;
            view.lastReceived = Date.now();
            render();
            return;
        }
        if (message.type === 'pong') {
            view.lastReceived = view.lastReceived || Date.now();
        }
    });

    socket.addEventListener('close', () => {
        view.connected = false;
        clearInterval(view.ping);
        render();
        scheduleReconnect();
    });

    socket.addEventListener('error', () => {
        try {
            socket.close();
        } catch {
            /* ignore */
        }
    });
}

function closeSocket() {
    clearInterval(view.ping);
    view.ping = null;
    if (view.socket) {
        try {
            view.socket.close();
        } catch {
            /* ignore */
        }
        view.socket = null;
    }
}

function scheduleReconnect() {
    setTimeout(connect, view.retry);
    view.retry = Math.min(15000, view.retry * 1.7);
}

async function poll() {
    if (view.connected) return;
    await load();
}

function startTicker() {
    clearInterval(view.ticker);
    view.ticker = setInterval(() => {
        document.querySelectorAll('[data-freshness]').forEach((node) => {
            node.textContent = timeAgo(view.lastReceived);
        });
        document.querySelectorAll('[data-foot-time]').forEach((node) => {
            node.textContent = timeAgo(view.lastReceived);
        });
    }, 20000);
}

// ---------- boot ----------
async function boot() {
    const ok = await load();
    if (!ok) return;
    connect();
    clearInterval(view.polling);
    view.polling = setInterval(poll, 60000);
    startTicker();
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            load();
            if (!view.socket || view.socket.readyState > WebSocket.OPEN) connect();
        }
    });
}

window.addEventListener('beforeunload', () => {
    closeSocket();
    clearInterval(view.polling);
    clearInterval(view.ticker);
});

boot();
