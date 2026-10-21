export const STATUS = { down: 0, up: 1, pending: 2, maintenance: 3 };

const STATUS_META = {
    0: { key: 'down', label: 'Gangguan', cls: 'down' },
    1: { key: 'up', label: 'Operasional', cls: 'up' },
    2: { key: 'pending', label: 'Menunggu', cls: 'pending' },
    3: { key: 'maintenance', label: 'Pemeliharaan', cls: 'maintenance' },
};

export function statusMeta(status) {
    return STATUS_META[status] || { key: 'unknown', label: 'Tidak diketahui', cls: 'paused' };
}

const ICONS = {
    dashboard:
        '<path d="M3 13h7V3H3zM14 21h7v-10h-7zM3 21h7v-5H3zM14 8h7V3h-7z"/>',
    pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
    stele: '<path d="M6 20.5V9a6 6 0 0 1 12 0v11.5"/><path d="M4 20.5h16"/><path d="M9.5 10.5h5M9.5 13.75h5M9.5 17h3"/>',
    layout:
        '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    wrench:
        '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 17 4"/>',
    bell:
        '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    settings:
        '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh:
        '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    trash:
        '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
    edit:
        '<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5 17.5 10.5"/>',
    pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    play: '<path d="M8 5l11 7-11 7z"/>',
    chevron: '<path d="m14 6-6 6 6 6"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    dots: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    globe:
        '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 4 5.7 4 9s-1.4 6.4-4 9c-2.6-2.6-4-5.7-4-9s1.4-6.4 4-9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 21h16"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 21h16"/>',
    shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 1 0-5.7-5.7L11 7.3"/><path d="M14 10a4 4 0 0 0-5.7 0L6 12.3a4 4 0 1 0 5.7 5.7L13 16.7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
    alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17.5h.01"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
};

export function icon(name, size = 17, extra = '') {
    const body = ICONS[name] || ICONS.pulse;
    return `<svg class="i ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
    }
    for (const child of Array.isArray(children) ? children : [children]) {
        if (child === null || child === undefined) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export function fmtNumber(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    return Number(value).toLocaleString('id-ID', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtPercent(value, digits = 2) {
    if (value === null || value === undefined) return '—';
    return `${Number(value).toLocaleString('id-ID', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })}%`;
}

export function fmtPing(value) {
    if (value === null || value === undefined) return '—';
    if (Number(value) < 1) return '<1 ms';
    return `${Math.round(Number(value))} ms`;
}

export function fmtDate(timestamp, withTime = true) {
    if (!timestamp) return '—';
    const date = new Date(Number(timestamp));
    const options = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) {
        options.hour = '2-digit';
        options.minute = '2-digit';
    }
    return date.toLocaleString('id-ID', options);
}

export function fmtTime(timestamp) {
    if (!timestamp) return '—';
    return new Date(Number(timestamp)).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(timestamp) {
    if (!timestamp) return '—';
    const diff = Date.now() - Number(timestamp);
    if (diff < 0) return 'sebentar lagi';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'baru saja';
    if (minutes < 60) return `${minutes} mnt lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} hari lalu`;
    return fmtDate(timestamp, false);
}

export function fmtDuration(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
    let seconds = Math.floor(Number(ms) / 1000);
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    if (days) return `${days} hari ${hours} jam`;
    if (hours) return `${hours} jam ${minutes} mnt`;
    if (minutes) return `${minutes} mnt ${seconds} dtk`;
    return `${seconds} dtk`;
}

export function beatStrip(beats, count = 60, { large = false } = {}) {
    const list = Array.isArray(beats) ? beats.slice(-count) : [];
    const padding = Math.max(0, count - list.length);
    let html = '';
    for (let index = 0; index < padding; index += 1) {
        html += '<span class="beat blank" title="Belum ada data"></span>';
    }
    for (const beat of list) {
        const meta = statusMeta(beat.status);
        const title = `${fmtDate(beat.time)} · ${meta.label}${beat.ping ? ` · ${fmtPing(beat.ping)}` : ''}${
            beat.msg ? ` · ${beat.msg}` : ''
        }`;
        html += `<span class="beat ${meta.cls}" title="${escapeHtml(title)}"></span>`;
    }
    return `<div class="beats${large ? ' large' : ''}" role="img" aria-label="Riwayat heartbeat">${html}</div>`;
}

let toastId = 0;
export function toast(title, message = '', type = 'info', timeout = 4200) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const node = el('div', { class: `toast ${type}` });
    node.innerHTML = `<b>${escapeHtml(title)}</b>${message ? `<span>${escapeHtml(message)}</span>` : ''}`;
    node.dataset.id = String((toastId += 1));
    root.append(node);
    setTimeout(() => {
        node.style.transition = 'opacity .2s, transform .2s';
        node.style.opacity = '0';
        node.style.transform = 'translateX(10px)';
        setTimeout(() => node.remove(), 220);
    }, timeout);
}

let activeModal = null;

export function closeModal() {
    if (!activeModal) return;
    const { backdrop, onClose } = activeModal;
    activeModal = null;
    backdrop.remove();
    document.removeEventListener('keydown', onClose);
    document.body.style.overflow = '';
}

export function openModal({ title, subtitle = '', body = '', footer = '', wide = false, onMount = null, bare = false }) {
    closeModal();
    const backdrop = el('div', { class: 'modal-backdrop' });
    const modal = el('div', { class: `modal${wide ? ' wide' : ''}` });
    modal.innerHTML = `
        <div class="modal-head">
            <div>
                <h2>${escapeHtml(title)}</h2>
                ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ''}
            </div>
            <div class="spacer"></div>
            <button class="icon-btn" data-close aria-label="Tutup">${icon('close', 17)}</button>
        </div>
        ${bare ? '' : `<div class="modal-body">${body}</div>`}
        ${bare ? body : ''}
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    `;
    backdrop.append(modal);
    document.getElementById('modal-root').append(backdrop);
    document.body.style.overflow = 'hidden';

    const onClose = (event) => {
        if (event.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onClose);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) closeModal();
    });
    modal.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => closeModal());
    });
    activeModal = { backdrop, modal, onClose };
    if (onMount) onMount(modal);
    return modal;
}

export function confirmDialog({ title, message, confirmLabel = 'Hapus', danger = true }) {
    return new Promise((resolve) => {
        const modal = openModal({
            title,
            body: `<p class="muted" style="margin:0;font-size:13px;line-height:1.6">${escapeHtml(message)}</p>`,
            footer: `<button class="btn ghost" data-cancel>Batal</button>
                     <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmLabel)}</button>`,
            onMount(node) {
                node.querySelector('[data-confirm]').addEventListener('click', () => {
                    closeModal();
                    resolve(true);
                });
                node.querySelector('[data-cancel]').addEventListener('click', () => {
                    closeModal();
                    resolve(false);
                });
            },
        });
        modal.addEventListener('click', (event) => {
            if (event.target.closest('[data-close]')) resolve(false);
        });
    });
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast('Disalin', 'Teks disalin ke papan klip', 'ok', 2000);
    } catch {
        toast('Gagal menyalin', 'Papan klip tidak tersedia', 'err');
    }
}

export function debounce(fn, wait = 180) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

export function uptimeClass(value) {
    if (value === null || value === undefined) return '';
    if (value < 90) return 'low';
    return '';
}

export function typeLabel(type) {
    return (
        {
            http: 'HTTP(s)',
            keyword: 'Kata kunci',
            json: 'JSON query',
            tcp: 'Port TCP',
            ping: 'Ping',
            dns: 'DNS',
            push: 'Push',
            group: 'Grup',
        }[type] || type
    );
}

export function typeGlyph(type) {
    return (
        {
            http: 'HTTP',
            keyword: 'KEY',
            json: 'JSON',
            tcp: 'TCP',
            ping: 'ICMP',
            dns: 'DNS',
            push: 'PUSH',
            group: 'GRP',
        }[type] || '?'
    );
}

export function targetOf(monitor) {
    if (monitor.type === 'http' || monitor.type === 'keyword' || monitor.type === 'json') {
        return monitor.url || '—';
    }
    if (monitor.type === 'tcp') return `${monitor.hostname}:${monitor.port}`;
    if (monitor.type === 'push') return 'Heartbeat push';
    if (monitor.type === 'group') return `${monitor.childrenCount || 0} monitor`;
    return monitor.hostname || '—';
}
