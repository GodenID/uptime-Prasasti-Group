import { api, ApiError, endpoints } from './api.js';
import { escapeHtml, icon, el, toast, closeModal, beatStrip } from './ui.js';
import * as dashboard from './views/dashboard.js';
import * as detail from './views/detail.js';
import * as statusPages from './views/status-pages.js';
import * as maintenance from './views/maintenance.js';
import * as notifications from './views/notifications.js';
import * as settings from './views/settings.js';

export const state = {
    user: null,
    settings: {},
    monitors: [],
    tags: [],
    notifications: [],
    statusPages: [],
    maintenances: [],
    incidents: [],
    stats: {},
    version: '',
    search: '',
    connected: false,
    loading: true,
};

let currentView = null;
let currentRoute = { name: 'dashboard', params: {} };
let socket = null;
let reconnectDelay = 800;
let refreshTimer = null;

const ROUTES = {
    dashboard: { title: 'Dasbor', crumbs: ['Dasbor'], nav: 'dashboard' },
    monitor: { title: 'Monitor', crumbs: ['Dasbor', 'Monitor'], nav: 'dashboard' },
    'status-pages': { title: 'Status Page', crumbs: ['Status Page'], nav: 'status-pages' },
    maintenance: { title: 'Pemeliharaan', crumbs: ['Pemeliharaan'], nav: 'maintenance' },
    notifications: { title: 'Notifikasi', crumbs: ['Notifikasi'], nav: 'notifications' },
    settings: { title: 'Pengaturan', crumbs: ['Pengaturan'], nav: 'settings' },
};

const NAV = [
    { id: 'dashboard', label: 'Dasbor', icon: 'dashboard', href: '#/' },
    { id: 'status-pages', label: 'Status Page', icon: 'layout', href: '#/status-pages' },
    { id: 'maintenance', label: 'Pemeliharaan', icon: 'wrench', href: '#/maintenance' },
    { id: 'notifications', label: 'Notifikasi', icon: 'bell', href: '#/notifications' },
    { id: 'settings', label: 'Pengaturan', icon: 'settings', href: '#/settings' },
];

export const ctx = {
    state,
    navigate(hash) {
        if (location.hash === hash) {
            renderRoute();
            return;
        }
        location.hash = hash;
    },
    async reload({ keepScroll = true } = {}) {
        const scroll = window.scrollY;
        await loadBootstrap();
        renderShell();
        await renderRoute();
        if (keepScroll) window.scrollTo(0, scroll);
    },
    async reloadMonitors() {
        const data = await api('/api/monitors');
        state.monitors = data.monitors;
        state.stats = data.stats;
        renderSidebar();
        if (currentRoute.name === 'dashboard') {
            await renderRoute();
        } else if (currentRoute.name === 'monitor') {
            await renderRoute();
        } else {
            renderTopbar();
        }
    },
    notifyError(error) {
        if (error instanceof ApiError && error.status === 401) {
            state.user = null;
            showAuth();
            return;
        }
        toast('Terjadi kesalahan', error.message || String(error), 'err');
    },
    toast,
};

export function currentPageTitle() {
    if (currentRoute.name === 'monitor') {
        const monitor = state.monitors.find((item) => item.id === Number(currentRoute.params.id));
        return monitor ? monitor.name : 'Monitor';
    }
    return (ROUTES[currentRoute.name] || ROUTES.dashboard).title;
}

// ---------- auth ----------
function sampleStrip() {
    // Ilustrasi statis bahasa visual denyut; bukan data instance.
    const beats = [];
    const start = Date.now() - 48 * 30 * 60000;
    for (let index = 0; index < 48; index += 1) {
        let status = 1;
        if (index === 30 || index === 31) status = 0;
        if (index === 32) status = 2;
        beats.push({ status, time: start + index * 30 * 60000 });
    }
    return beatStrip(beats, 48);
}

function authShell(inner) {
    const auth = document.getElementById('auth');
    auth.innerHTML = `
        <div class="auth-aside">
            <div class="auth-brand">
                <span class="brand-mark">${icon('stele', 17)}</span>
                <span>Uptime Prasasti</span>
            </div>
            <div>
                <h1 class="auth-claim">Setiap denyut <em>direkam</em>, setiap gangguan tercatat.</h1>
                <p class="auth-lede">Pemantauan uptime milik sendiri untuk HTTP, kata kunci, JSON, port TCP, ping, DNS, dan heartbeat push, lengkap dengan status page publik.</p>
                <div class="auth-strip" aria-hidden="true">
                    ${sampleStrip()}
                    <div class="auth-strip-meta"><span>Satu kotak, satu pemeriksaan</span><span>sekarang</span></div>
                </div>
            </div>
            <div class="auth-meta">
                <span>Self-hosted</span>
                <span>SQLite lokal</span>
                <span>Tanpa layanan pihak ketiga</span>
            </div>
        </div>
        <div class="auth-main">${inner}</div>
    `;
    auth.classList.remove('hidden');
    document.getElementById('boot').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
}

function showAuth(errorMessage = '') {
    disconnectSocket();
    authShell(`
        <form class="auth-card" id="auth-form">
            <div class="eyebrow">Masuk</div>
            <h2>Selamat datang kembali</h2>
            <p class="sub">Masuk untuk mengelola monitor dan status page.</p>
            ${errorMessage ? `<div class="alert" role="alert">${escapeHtml(errorMessage)}</div>` : ''}
            <div class="field">
                <label for="username">Username</label>
                <input class="input" id="username" name="username" autocomplete="username" required autofocus />
            </div>
            <div class="field">
                <label for="password">Kata sandi</label>
                <input class="input" id="password" name="password" type="password" autocomplete="current-password" required />
            </div>
            <label class="auth-check">
                <input type="checkbox" name="remember" /> Ingat saya selama 30 hari
            </label>
            <button class="btn primary block" type="submit">Masuk</button>
            <div class="auth-foot">Uptime Prasasti Websites · versi ${escapeHtml(state.version || '1.0.0')}</div>
        </form>
    `);
    const form = document.getElementById('auth-form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button');
        button.disabled = true;
        button.textContent = 'Memeriksa…';
        try {
            await endpoints.login(
                form.username.value.trim(),
                form.password.value,
                form.remember.checked
            );
            await startApp();
        } catch (error) {
            button.disabled = false;
            button.textContent = 'Masuk';
            showAuth(error.message);
        }
    });
}

function showSetup() {
    authShell(`
        <form class="auth-card" id="setup-form">
            <div class="eyebrow">Instalasi pertama</div>
            <h2>Buat akun administrator</h2>
            <p class="sub">Prasasti belum memiliki akun. Akun pertama menjadi pemilik penuh instance ini.</p>
            <div class="field">
                <label for="username">Username</label>
                <input class="input" id="username" name="username" minlength="3" required autofocus />
            </div>
            <div class="field">
                <label for="password">Kata sandi</label>
                <input class="input" id="password" name="password" type="password" minlength="8" required />
                <span class="hint">Minimal 8 karakter. Gunakan frasa yang panjang dan mudah Anda ingat.</span>
            </div>
            <div class="field" style="margin-bottom:20px">
                <label for="confirm">Ulangi kata sandi</label>
                <input class="input" id="confirm" name="confirm" type="password" minlength="8" required />
            </div>
            <div id="setup-error"></div>
            <button class="btn primary block" type="submit">Buat instance</button>
            <div class="auth-foot">Data disimpan lokal dalam SQLite.</div>
        </form>
    `);
    const form = document.getElementById('setup-form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = document.getElementById('setup-error');
        errorBox.innerHTML = '';
        if (form.password.value !== form.confirm.value) {
            errorBox.innerHTML = '<div class="alert">Konfirmasi kata sandi tidak sama.</div>';
            return;
        }
        const button = form.querySelector('button');
        button.disabled = true;
        button.textContent = 'Menyiapkan…';
        try {
            await endpoints.setup(form.username.value.trim(), form.password.value);
            await startApp();
        } catch (error) {
            button.disabled = false;
            button.textContent = 'Buat instance';
            errorBox.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`;
        }
    });
}

// ---------- shell ----------
function renderSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const counts = {
        'status-pages': state.statusPages.length,
        notifications: state.notifications.length,
        maintenance: state.maintenances.filter((item) => item.active).length,
    };
    const activeNav = (ROUTES[currentRoute.name] || ROUTES.dashboard).nav;
    const initial = (state.user?.username || '?').slice(0, 1).toUpperCase();

    sidebar.innerHTML = `
        <div class="brand">
            <div class="brand-mark">${icon('stele', 17)}</div>
            <div class="brand-text">
                <div class="brand-name">Prasasti</div>
                <div class="brand-sub">Uptime monitor</div>
            </div>
        </div>
        <nav class="nav" aria-label="Navigasi utama">
            ${NAV.map(
                (item) => `
                <a class="nav-item ${activeNav === item.id ? 'active' : ''}" href="${item.href}"${
                    activeNav === item.id ? ' aria-current="page"' : ''
                }>
                    ${icon(item.icon, 17, 'nav-icon')}
                    <span>${item.label}</span>
                    ${counts[item.id] ? `<span class="nav-count">${counts[item.id]}</span>` : ''}
                </a>`
            ).join('')}
        </nav>
        <div class="sidebar-foot">
            <div class="side-status">
                <span class="conn-dot ${state.connected ? 'online' : 'offline'}"></span>
                <span>${state.connected ? 'Realtime aktif' : 'Terputus'}</span>
                <span class="spacer"></span>
                <span>${state.stats.total || 0} monitor</span>
            </div>
            <div class="user-row">
                <div class="avatar">${escapeHtml(initial)}</div>
                <div style="min-width:0;flex:1">
                    <div class="user-name">${escapeHtml(state.user?.username || '')}</div>
                    <div class="tiny muted">Administrator</div>
                </div>
                <button class="icon-btn" data-action="logout" title="Keluar" aria-label="Keluar">
                    ${icon('logout', 16)}
                </button>
            </div>
        </div>
    `;
    sidebar.querySelector('[data-action="logout"]').addEventListener('click', logout);
}

function renderTopbar() {
    const topbar = document.getElementById('topbar');
    if (!topbar) return;
    const crumbs = [...(ROUTES[currentRoute.name] || ROUTES.dashboard).crumbs];
    if (currentRoute.name === 'monitor') crumbs[crumbs.length - 1] = currentPageTitle();
    const showSearch = ['dashboard'].includes(currentRoute.name);
    const crumbHtml = crumbs
        .map((crumb, index) =>
            index === crumbs.length - 1 ? `<b>${escapeHtml(crumb)}</b>` : `<span>${escapeHtml(crumb)}</span>`
        )
        .join('<span class="sep">/</span>');
    topbar.innerHTML = `
        <div class="crumb">${crumbHtml}</div>
        <div class="spacer"></div>
        ${
            showSearch
                ? `<div class="search">${icon('search', 15)}<input id="global-search" placeholder="Cari monitor, host, tag" value="${escapeHtml(
                      state.search
                  )}" aria-label="Cari monitor" /><kbd>/</kbd></div>`
                : ''
        }
        <button class="icon-btn" data-action="reload" title="Muat ulang" aria-label="Muat ulang">${icon('refresh', 16)}</button>
    `;
    const search = topbar.querySelector('#global-search');
    if (search) {
        search.addEventListener('input', () => {
            state.search = search.value;
            if (currentView && typeof currentView.onSearch === 'function') {
                currentView.onSearch(state.search);
            }
        });
    }
    topbar.querySelector('[data-action="reload"]').addEventListener('click', async () => {
        const button = topbar.querySelector('[data-action="reload"]');
        button.style.transform = 'rotate(180deg)';
        button.style.transition = 'transform .4s';
        await ctx.reload();
    });
}

function renderShell() {
    document.getElementById('auth').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('boot').classList.add('hidden');
    renderSidebar();
    renderTopbar();
}

async function logout() {
    try {
        await endpoints.logout();
    } catch {
        /* session may already be gone */
    }
    state.user = null;
    showAuth();
}

// ---------- routing ----------
function parseRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (!hash) return { name: 'dashboard', params: {} };
    const [name, param] = hash.split('/');
    if (name === 'monitor' && param) {
        return { name: 'monitor', params: { id: Number(param) } };
    }
    if (ROUTES[name]) {
        return { name, params: {} };
    }
    return { name: 'dashboard', params: {} };
}

async function renderRoute() {
    currentRoute = parseRoute();
    renderSidebar();
    renderTopbar();
    const view = document.getElementById('view');
    if (!view) return;
    closeModal();
    view.innerHTML = '';
    const module =
        currentRoute.name === 'monitor'
            ? detail
            : currentRoute.name === 'status-pages'
              ? statusPages
              : currentRoute.name === 'maintenance'
                ? maintenance
                : currentRoute.name === 'notifications'
                  ? notifications
                  : currentRoute.name === 'settings'
                    ? settings
                    : dashboard;

    currentView = module;
    try {
        await module.render(view, {
            ...ctx,
            params: currentRoute.params,
        });
    } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
            state.user = null;
            showAuth();
            return;
        }
        view.innerHTML = `<div class="empty"><h3>Gagal memuat halaman</h3><p>${escapeHtml(
            error.message
        )}</p><button class="btn ghost" data-retry>Coba lagi</button></div>`;
        view.querySelector('[data-retry]')?.addEventListener('click', renderRoute);
    }
}

// ---------- data ----------
async function loadBootstrap() {
    const data = await endpoints.bootstrap();
    state.user = data.user;
    state.settings = data.settings;
    state.monitors = data.monitors;
    state.tags = data.tags;
    state.notifications = data.notifications;
    state.statusPages = data.statusPages;
    state.maintenances = data.maintenances;
    state.incidents = data.incidents;
    state.stats = data.stats;
    state.version = data.version;
    document.title = `${data.settings.title || 'Uptime Prasasti'} · Prasasti`;
}

async function startApp() {
    state.loading = true;
    await loadBootstrap();
    state.loading = false;
    renderShell();
    await renderRoute();
    connectSocket();
}

// ---------- realtime ----------
function connectSocket() {
    disconnectSocket();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
        socket = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
        scheduleReconnect();
        return;
    }

    socket.addEventListener('open', () => {
        state.connected = true;
        reconnectDelay = 800;
        renderSidebar();
    });

    socket.addEventListener('close', () => {
        state.connected = false;
        renderSidebar();
        scheduleReconnect();
    });

    socket.addEventListener('error', () => {
        try {
            socket.close();
        } catch {
            /* ignore */
        }
    });

    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        if (message.type === 'beat') {
            const index = state.monitors.findIndex((monitor) => monitor.id === message.monitorId);
            if (index !== -1) {
                state.monitors[index] = message.summary;
            }
            if (currentView && typeof currentView.onBeat === 'function') {
                currentView.onBeat(message);
            }
            return;
        }
        if (message.type === 'refresh') {
            scheduleRefresh();
            return;
        }
        if (message.type === 'settings' && message.settings) {
            state.settings = message.settings;
            renderSidebar();
        }
    });
}

function scheduleReconnect() {
    setTimeout(() => {
        if (state.user) connectSocket();
    }, reconnectDelay);
    reconnectDelay = Math.min(10000, reconnectDelay * 1.6);
}

function disconnectSocket() {
    if (socket) {
        try {
            socket.close();
        } catch {
            /* ignore */
        }
        socket = null;
    }
    state.connected = false;
}

function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        try {
            await loadBootstrap();
            renderSidebar();
            if (currentRoute.name === 'dashboard') {
                await renderRoute();
            } else if (currentView && typeof currentView.onRefresh === 'function') {
                await currentView.onRefresh();
            }
        } catch {
            /* keep current view on transient failure */
        }
    }, 700);
}

// ---------- boot ----------
async function boot() {
    try {
        const session = await endpoints.session();
        state.version = '1.0.0';
        if (session.needSetup) {
            showSetup();
            return;
        }
        if (!session.user) {
            state.user = null;
            showAuth();
            return;
        }
        state.user = session.user;
        await startApp();
    } catch (error) {
        showAuth(error.message || 'Tidak dapat menghubungi server');
    }
}

window.addEventListener('hashchange', () => {
    if (state.user) renderRoute();
});

document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        const search = document.getElementById('global-search');
        if (search) {
            event.preventDefault();
            search.focus();
        }
    }
});

export { renderRoute, renderShell, showAuth };

boot();
