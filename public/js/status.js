import { escapeHtml, fmtPercent, fmtPing, icon, statusMeta } from './ui.js';
import { setLang, t, typeLabel, statusText, currentLocale } from './i18n.js';

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
    up: { key: 'overallAllUp', cls: 'up' },
    down: { key: 'overallDown', cls: 'down' },
    pending: { key: 'overallPending', cls: 'pending' },
    maintenance: { key: 'overallMaintenance', cls: 'maintenance' },
};

function overallMeta(status) {
    const meta = statusMeta(status);
    return OVERALL[meta.key] || { key: 'overallUnknown', cls: 'pending' };
}

/**
 * Bahasa halaman mengikuti pengaturan status page: 'id', 'en', atau 'auto'.
 */
function resolveLang(page) {
    const setting = page?.lang || 'id';
    if (setting === 'auto') {
        const browser = String(navigator.language || 'id-ID').toLowerCase();
        return setLang(browser.startsWith('en') ? 'en' : 'id');
    }
    return setLang(setting);
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
            throw new Error(t('cannotLoad'));
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
    document.title = `${t('notFoundTitle')} · Prasasti`;
    root.innerHTML = `
        <div class="missing">
            <div class="missing-mark">${icon('alert', 20)}</div>
            <h1>${escapeHtml(t('notFoundTitle'))}</h1>
            <p>${escapeHtml(t('notFoundText'))}</p>
            <a class="btn" href="/">${escapeHtml(t('openPrasasti'))}</a>
        </div>
    `;
}

function showError(message) {
    root.innerHTML = `
        <div class="missing">
            <div class="missing-mark">${icon('alert', 20)}</div>
            <h1>${escapeHtml(t('cannotLoad'))}</h1>
            <p>${escapeHtml(message)}</p>
            <button class="btn" data-retry>${escapeHtml(t('retry'))}</button>
        </div>
    `;
    root.querySelector('[data-retry]')?.addEventListener('click', () => {
        root.innerHTML = `<div class="loading" role="status">${escapeHtml(t('loading'))}</div>`;
        load().then(() => connect());
    });
}

function renderNotice() {
    const existing = document.querySelector('.net-note');
    if (existing) existing.remove();
    if (view.connected || !view.payload) return;
    const note = document.createElement('div');
    note.className = 'net-note';
    note.innerHTML = escapeHtml(t('netNote'));
    document.body.append(note);
}

function render() {
    const data = view.payload;
    if (!data) return;
    const page = data.page;
    resolveLang(page);
    document.title = `${page.title} · Status`;
    const description = page.description || `Kondisi terkini ${page.title}.`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute('content', description);
    const iconLink = document.querySelector('link[rel="icon"]');
    if (iconLink && page.icon) iconLink.setAttribute('href', page.icon);
    const skip = document.querySelector('.skip');
    if (skip) skip.textContent = t('skipToContent');

    const overall = overallMeta(data.overall.status);
    const down = data.overall.downMonitors;

    const totalMonitors = data.overall.totalMonitors;
    const subline =
        overall.cls === 'down'
            ? t('subDown', { down, total: totalMonitors })
            : overall.cls === 'maintenance'
              ? t('subMaintenance')
              : overall.cls === 'pending'
                ? t('subPending')
                : t('subDefault', { total: totalMonitors });

    const feedUrl = slug ? `/status/${slug}/feed.xml` : '/feed.xml';

    root.innerHTML = `
        <header class="hero">
            <div class="hero-bar">
                <div class="brand">
                    <span class="brand-mark">${icon('stele', 15)}</span>
                    <span class="brand-text">Uptime Prasasti</span>
                </div>
                <span class="live ${view.connected ? 'on' : 'off'}" title="${
                    view.connected ? t('liveTitleOn') : t('liveTitleOff')
                }">
                    <span class="live-dot"></span>${view.connected ? t('liveOn') : t('liveOff')}
                </span>
            </div>

            <h1 class="hero-title">${escapeHtml(page.title)}</h1>
            ${description ? `<p class="hero-lede">${escapeHtml(description)}</p>` : ''}
            ${page.announcement ? announcementHtml(page.announcement) : ''}

            <div class="overall ${overall.cls}">
                <div class="overall-status">
                    <span class="overall-dot"></span>
                    <div>
                        <b>${escapeHtml(t(overall.key))}</b>
                        <span>${escapeHtml(subline)}</span>
                    </div>
                </div>
                <div class="overall-figures">
                    <div class="figure">
                        <b>${data.overall.uptime24 === null ? '—' : fmtPercent(data.overall.uptime24)}</b>
                        <span>${escapeHtml(t('uptime24'))}</span>
                    </div>
                    <div class="figure">
                        <b>${totalMonitors}</b>
                        <span>${escapeHtml(t('services'))}</span>
                    </div>
                    <div class="figure">
                        <b data-freshness>${timeAgo(view.lastReceived)}</b>
                        <span>${escapeHtml(t('updated'))}</span>
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
                <a class="foot-feed" href="${escapeHtml(feedUrl)}">${escapeHtml(t('feedLink'))}</a>
                <span class="spacer"></span>
                <span>${escapeHtml(t('updatedFooter'))} <span data-foot-time>${timeAgo(view.lastReceived)}</span></span>
            </div>
            ${
                page.showPoweredBy
                    ? `<div class="foot-credit">${icon('stele', 13)} ${escapeHtml(
                          t('poweredBy')
                      )} <a href="/" rel="noopener">Uptime Prasasti</a></div>`
                    : ''
            }
        </footer>
    `;

    renderNotice();
}

function announcementHtml(text) {
    return `<div class="announcement" role="note">
        <b>${escapeHtml(t('announcementTitle'))}</b>
        <p>${escapeHtml(text)}</p>
    </div>`;
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
                <span class="notice-meta">${isActive ? t('noticeActive') : t('noticeScheduled')} ${fmtWhen(
                    isActive ? item.endAt : item.startAt
                )}</span>
            </div>
        </div>`;

    return `<section class="block">
        <h2 class="block-title">${escapeHtml(t('maintenanceTitle'))}</h2>
        <div class="stack">
            ${active.map((item) => row(item, true)).join('')}
            ${upcoming.map((item) => row(item, false)).join('')}
        </div>
    </section>`;
}

function incidentsHtml(incidents) {
    if (!incidents?.length) return '';
    return `<section class="block">
        <h2 class="block-title">${escapeHtml(t('incidentsTitle'))}</h2>
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
            ${incident.pinned ? `<span class="pin">${escapeHtml(t('pinned'))}</span>` : ''}
        </div>
        ${incident.content ? `<p>${escapeHtml(incident.content)}</p>` : ''}
        <div class="incident-meta">${escapeHtml(t('started'))} ${fmtWhen(incident.startedAt)}${
            incident.resolvedAt ? ` · ${escapeHtml(t('finished'))} ${fmtWhen(incident.resolvedAt)}` : ` · ${escapeHtml(t('ongoing'))}`
        }</div>
    </article>`;
}

function groupsHtml(data) {
    const sections = [];
    if (data.monitors?.length) {
        sections.push(`<section class="block">
            <h2 class="block-title">${escapeHtml(t('servicesTitle'))}</h2>
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
        sections.push(`<section class="block"><div class="blank">${escapeHtml(t('noServices'))}</div></section>`);
    }
    return sections.join('');
}

function monitorHtml(monitor) {
    const meta = statusMeta(monitor.status);
    const stateLabel = statusText(monitor.status);
    const beats = (monitor.beats || []).slice(-30);
    const label = typeLabel(monitor.type);
    const uptime24 = monitor.uptime24 === null || monitor.uptime24 === undefined ? null : monitor.uptime24;
    const uptime30 = monitor.uptime30 === null || monitor.uptime30 === undefined ? null : monitor.uptime30;

    return `<article class="svc">
        <div class="svc-ident">
            <span class="dot ${meta.cls}" aria-label="${escapeHtml(stateLabel)}"></span>
            <div class="svc-text">
                <div class="svc-name">
                    <b>${escapeHtml(monitor.name)}</b>
                    <span class="state ${meta.cls}">${escapeHtml(stateLabel)}</span>
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
                                  statusText(beat.status)
                              )} · ${fmtWhen(beat.time)}${beat.msg ? ` · ${escapeHtml(beat.msg)}` : ''}"></span>`
                          )
                          .join('')
                    : '<span class="bar empty"></span>'.repeat(12)
            }
        </div>

        <div class="svc-figures">
            <div class="figure sm">
                <b>${monitor.avgPing24 === null || monitor.avgPing24 === undefined ? '—' : fmtPing(monitor.avgPing24)}</b>
                <span>${escapeHtml(t('response'))}</span>
            </div>
            <div class="figure sm">
                <b>${uptime24 === null ? '—' : fmtPercent(uptime24)}</b>
                <span>${escapeHtml(t('last24'))}</span>
            </div>
            <div class="figure sm">
                <b class="${uptime30 !== null && uptime30 < 99 ? 'low' : ''}">${
                    uptime30 === null ? '—' : fmtPercent(uptime30)
                }</b>
                <span>${escapeHtml(t('last30'))}</span>
            </div>
        </div>
    </article>`;
}

function historyHtml(history) {
    if (!history?.length) return '';
    return `<section class="block">
        <details class="history">
            <summary>${escapeHtml(t('historyTitle'))} (${history.length})</summary>
            <div class="stack mt">
                ${history.map(incidentHtml).join('')}
            </div>
        </details>
    </section>`;
}

function fmtWhen(timestamp) {
    if (!timestamp) return '—';
    return new Date(Number(timestamp)).toLocaleString(currentLocale(), {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function timeAgo(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
    if (seconds < 10) return t('justNow');
    if (seconds < 60) return t('secAgo', { n: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('minAgo', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('hourAgo', { n: hours });
    return t('dayAgo', { n: Math.floor(hours / 24) });
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
