import { api, endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    beatStrip,
    statusMeta,
    fmtPercent,
    fmtPing,
    timeAgo,
    targetOf,
    typeLabel,
    typeGlyph,
    openModal,
    closeModal,
    confirmDialog,
    toast,
    copyText,
} from '../ui.js';

const TYPES = [
    { id: 'http', label: 'HTTP(s)', desc: 'Status kode & waktu respons' },
    { id: 'keyword', label: 'Kata kunci', desc: 'Cari teks pada halaman' },
    { id: 'json', label: 'JSON query', desc: 'Periksa nilai JSON' },
    { id: 'tcp', label: 'Port TCP', desc: 'Konektivitas port' },
    { id: 'ping', label: 'Ping', desc: 'ICMP echo ke host' },
    { id: 'dns', label: 'DNS', desc: 'Record A, MX, TXT, dll' },
    { id: 'redis', label: 'Redis', desc: 'Perintah pada server Redis' },
    { id: 'mqtt', label: 'MQTT', desc: 'Pesan pada topik MQTT' },
    { id: 'docker', label: 'Docker', desc: 'Status container Docker' },
    { id: 'postgres', label: 'PostgreSQL', desc: 'Kueri ke database PostgreSQL' },
    { id: 'push', label: 'Push', desc: 'Heartbeat dari aplikasi Anda' },
    { id: 'group', label: 'Grup', desc: 'Kelompokkan monitor' },
];

const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'PTR', 'SOA', 'CAA', 'SRV', 'NAPTR'];

const PORT_PLACEHOLDER = { redis: '6379', mqtt: '1883', postgres: '5432' };

export async function render(root, ctx) {
    draw(root, ctx);

    return {
        onSearch(query) {
            const grid = root.querySelector('#monitor-sections');
            if (grid) grid.innerHTML = sectionsHtml(ctx.state, query);
            bindGrid(root, ctx);
        },
        onBeat() {
            const grid = root.querySelector('#monitor-sections');
            if (grid) {
                const openMenu = root.querySelector('.menu');
                const openFor = openMenu ? openMenu.closest('[data-card]')?.dataset.card : null;
                grid.innerHTML = sectionsHtml(ctx.state, ctx.state.search);
                bindGrid(root, ctx);
                if (openFor) {
                    const card = root.querySelector(`[data-card="${openFor}"]`);
                    card?.querySelector('[data-action="menu"]')?.click();
                }
            }
            const stats = root.querySelector('#stat-grid');
            if (stats) stats.outerHTML = statsHtml(ctx.state);
        },
        onRefresh() {
            draw(root, ctx);
        },
    };
}

function draw(root, ctx) {
    const { state } = ctx;
    root.innerHTML = `
        <div class="page-head">
            <div class="grow">
                <h1 class="page-title">Dasbor</h1>
                <div class="page-sub">${escapeHtml(
                    state.settings.description || 'Ringkasan ketersediaan seluruh monitor Anda.'
                )}</div>
            </div>
            <div class="head-actions">
                <button class="btn ghost" data-action="refresh">${icon('refresh', 15)}<span>Segarkan</span></button>
                <button class="btn primary" data-action="add">${icon('plus', 15)}<span>Tambah monitor</span></button>
            </div>
        </div>
        ${statsHtml(state)}
        <div id="monitor-sections">${sectionsHtml(state, state.search)}</div>
    `;

    root.querySelector('[data-action="add"]').addEventListener('click', () => openMonitorForm(null, ctx));
    root.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
        await ctx.reloadMonitors();
        toast('Data disegarkan', 'Ringkasan monitor diperbarui', 'ok', 1800);
    });
    bindGrid(root, ctx);
}

function statsHtml(state) {
    const stats = state.stats || {};
    const total = stats.total || 0;
    const up = stats.up || 0;
    const down = stats.down || 0;
    const pending = stats.pending || 0;
    const maintenance = stats.maintenance || 0;
    const checks = Number(stats.checks24h || 0).toLocaleString('id-ID');
    const last = stats.lastBeat ? `pemeriksaan terakhir ${timeAgo(stats.lastBeat)}` : 'belum ada pemeriksaan';

    let lead;
    if (!total) {
        lead = { cls: 'pending', title: 'Belum ada monitor', sub: 'Tambahkan monitor pertama untuk mulai merekam denyut.' };
    } else if (down) {
        lead = {
            cls: 'down',
            title: `${down} monitor terganggu`,
            sub: `Dari ${total} monitor · ${last}.`,
        };
    } else if (maintenance) {
        lead = { cls: 'maintenance', title: 'Sebagian dalam pemeliharaan', sub: `${maintenance} monitor dirawat · ${last}.` };
    } else if (pending && !up) {
        lead = { cls: 'pending', title: 'Menunggu pemeriksaan pertama', sub: `${total} monitor terdaftar · ${last}.` };
    } else {
        lead = { cls: 'up', title: 'Semua monitor operasional', sub: `${checks} pemeriksaan dalam 24 jam · ${last}.` };
    }

    const fig = (label, value, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;

    return `
        <section class="summary" id="stat-grid" aria-label="Ringkasan monitor">
            <div class="summary-lead ${lead.cls}">
                <span class="summary-mark" aria-hidden="true"></span>
                <div><b>${escapeHtml(lead.title)}</b><span>${escapeHtml(lead.sub)}</span></div>
            </div>
            <dl class="summary-figs">
                ${fig('Operasional', up, up ? '' : 'zero')}
                ${fig('Gangguan', down, down ? 'down' : 'zero')}
                ${fig('Menunggu', pending + maintenance, pending + maintenance ? '' : 'zero')}
                ${fig('Respons 24 jam', stats.avgPing === null || stats.avgPing === undefined
                    ? '—'
                    : `${Math.round(stats.avgPing)}<small>ms</small>`)}
            </dl>
        </section>
    `;
}

function matches(monitor, query) {
    if (!query) return true;
    const haystack = [
        monitor.name,
        monitor.url,
        monitor.hostname,
        monitor.description,
        ...(monitor.tags || []).map((tag) => tag.name),
    ]
        .join(' ')
        .toLowerCase();
    return haystack.includes(query.toLowerCase());
}

function sectionsHtml(state, query) {
    const monitors = state.monitors || [];
    if (!monitors.length) {
        return `<div class="empty">
            <div class="empty-icon">${icon('pulse', 20)}</div>
            <h3>Belum ada monitor</h3>
            <p>Tambahkan situs pertama Anda. Prasasti akan memeriksa secara berkala dan merekam setiap denyutnya.</p>
            <button class="btn primary" data-action="add">${icon('plus', 15)} Tambah monitor</button>
        </div>`;
    }

    const groups = monitors.filter((monitor) => monitor.type === 'group');
    const ungrouped = monitors.filter((monitor) => monitor.type !== 'group' && !monitor.parentId);
    const filtered = (list) => list.filter((monitor) => matches(monitor, query));

    let body = '';
    for (const group of groups) {
        const children = monitors.filter((monitor) => monitor.parentId === group.id);
        const visibleChildren = filtered(children);
        const groupMatches = matches(group, query);
        if (query && !groupMatches && !visibleChildren.length) continue;
        const groupMeta = statusMeta(group.status);
        body += `
            <div class="ledger-group">
                <span class="status-dot ${group.active ? groupMeta.cls : 'paused'}"></span>
                <span>${escapeHtml(group.name)}</span>
                <span class="count">${children.length} monitor</span>
                ${group.status === 0 ? `<span class="state down">${groupMeta.label}</span>` : ''}
                <button class="btn sm ghost" data-group-edit="${group.id}">${icon('edit', 13)} Kelola</button>
            </div>
            ${
                visibleChildren.length
                    ? visibleChildren.map((monitor) => cardHtml(monitor, true)).join('')
                    : '<div class="ledger-note">Belum ada monitor di grup ini.</div>'
            }
        `;
    }

    const visibleUngrouped = filtered(ungrouped);
    if (visibleUngrouped.length) {
        if (groups.length) {
            body += `<div class="ledger-group"><span>Tanpa grup</span><span class="count">${ungrouped.length} monitor</span></div>`;
        }
        body += visibleUngrouped.map((monitor) => cardHtml(monitor)).join('');
    }

    if (query && !body.trim()) {
        return `<div class="empty"><h3>Tidak ada hasil</h3><p>Tidak ada monitor yang cocok dengan “${escapeHtml(
            query
        )}”.</p></div>`;
    }

    let html = `
        <div class="ledger" aria-label="Daftar monitor">
            <div class="ledger-head" aria-hidden="true">
                <span></span>
                <span>Monitor</span>
                <span>60 pemeriksaan terakhir</span>
                <span class="num">Uptime 24 j</span>
                <span class="num">Respons</span>
                <span></span>
            </div>
            ${body}
        </div>
    `;

    if (!query && state.settings.showPoweredBy !== '0') {
        html += `<div class="ledger-foot">Uptime Prasasti Websites · ${new Date().toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        })}</div>`;
    }
    return html;
}

function cardHtml(monitor, child = false) {
    const meta = statusMeta(monitor.status);
    const paused = !monitor.active;
    const cls = paused ? 'paused' : meta.cls;
    const target = targetOf(monitor);
    const tags = (monitor.tags || []).slice(0, 2);
    const showState = paused || meta.key !== 'up';
    const uptime = monitor.uptime24;
    return `
        <article class="row${meta.key === 'down' && !paused ? ' is-down' : ''}${child ? ' is-child' : ''}" data-card="${
            monitor.id
        }" tabindex="0">
            <span class="row-mark ${cls}" aria-hidden="true"></span>
            <div class="row-ident">
                <div class="row-name">
                    <span>${escapeHtml(monitor.name)}</span>
                    ${showState ? `<span class="state ${cls}">${paused ? 'Dijeda' : meta.label}</span>` : ''}
                </div>
                <div class="row-sub">
                    <span class="host">${escapeHtml(target)}</span>
                    <span class="sep">·</span>
                    <span>${escapeHtml(typeGlyph(monitor.type))}</span>
                    ${tags
                        .map(
                            (tag) =>
                                `<span class="tag"><span class="dot" style="background:${escapeHtml(
                                    tag.color
                                )}"></span>${escapeHtml(tag.name)}</span>`
                        )
                        .join('')}
                </div>
            </div>
            <div class="row-beats">${beatStrip(monitor.beats, 60)}</div>
            <div class="row-num row-up">
                <b class="${uptime !== null && uptime !== undefined && uptime < 99 ? 'low' : ''}">${fmtPercent(uptime, 2)}</b>
                <span>24 jam</span>
            </div>
            <div class="row-num row-ping">
                <b>${fmtPing(monitor.avgPing24)}</b>
                <span>rerata</span>
            </div>
            <div class="card-menu">
                <button class="icon-btn" data-action="menu" aria-label="Menu ${escapeHtml(monitor.name)}">${icon('dots', 16)}</button>
            </div>
        </article>
    `;
}

function bindGrid(root, ctx) {
    root.querySelectorAll('[data-card]').forEach((card) => {
        const id = Number(card.dataset.card);
        const open = () => ctx.navigate(`#/monitor/${id}`);
        card.addEventListener('click', (event) => {
            if (event.target.closest('[data-action="menu"]') || event.target.closest('.menu')) return;
            open();
        });
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') open();
        });
    });

    root.querySelectorAll('[data-action="menu"]').forEach((button) => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const card = button.closest('[data-card]');
            const existing = card.querySelector('.menu');
            root.querySelectorAll('.menu').forEach((menu) => menu.remove());
            if (existing) return;
            const monitor = ctx.state.monitors.find((item) => item.id === Number(card.dataset.card));
            if (!monitor) return;
            const menu = document.createElement('div');
            menu.className = 'menu';
            menu.innerHTML = `
                <button data-menu-action="check">${icon('refresh', 14)} Periksa sekarang</button>
                <button data-menu-action="edit">${icon('edit', 14)} Ubah monitor</button>
                <button data-menu-action="toggle">${icon(monitor.active ? 'pause' : 'play', 14)} ${
                    monitor.active ? 'Jeda monitor' : 'Lanjutkan'
                }</button>
                ${
                    monitor.type === 'push'
                        ? `<button data-menu-action="copy">${icon('copy', 14)} Salin URL push</button>`
                        : ''
                }
                <hr />
                <button class="danger" data-menu-action="delete">${icon('trash', 14)} Hapus</button>
            `;
            card.append(menu);
            menu.addEventListener('click', async (menuEvent) => {
                menuEvent.stopPropagation();
                const action = menuEvent.target.closest('[data-menu-action]')?.dataset.menuAction;
                if (!action) return;
                menu.remove();
                if (action === 'edit') {
                    openMonitorForm(monitor, ctx);
                    return;
                }
                if (action === 'delete') {
                    const ok = await confirmDialog({
                        title: 'Hapus monitor',
                        message: `Monitor “${monitor.name}” beserta riwayat heartbeat-nya akan dihapus permanen.`,
                        confirmLabel: 'Hapus monitor',
                    });
                    if (!ok) return;
                    try {
                        await endpoints.deleteMonitor(monitor.id);
                        toast('Monitor dihapus', monitor.name, 'ok');
                        await ctx.reload();
                    } catch (error) {
                        ctx.notifyError(error);
                    }
                    return;
                }
                if (action === 'toggle') {
                    try {
                        if (monitor.active) await endpoints.pauseMonitor(monitor.id);
                        else await endpoints.resumeMonitor(monitor.id);
                        toast(monitor.active ? 'Monitor dijeda' : 'Monitor dilanjutkan', monitor.name, 'ok');
                        await ctx.reloadMonitors();
                    } catch (error) {
                        ctx.notifyError(error);
                    }
                    return;
                }
                if (action === 'check') {
                    toast('Memeriksa…', monitor.name, 'info', 1600);
                    try {
                        const result = await endpoints.checkMonitor(monitor.id);
                        const meta = statusMeta(result.beat.status);
                        toast(
                            meta.label,
                            result.beat.msg || `${meta.label} setelah pemeriksaan manual`,
                            meta.key === 'up' ? 'ok' : 'err'
                        );
                        await ctx.reloadMonitors();
                    } catch (error) {
                        ctx.notifyError(error);
                    }
                    return;
                }
                if (action === 'copy') {
                    copyText(`${location.origin}/api/push/${monitor.pushToken}`);
                }
            });
        });
    });

    root.querySelectorAll('[data-group-edit]').forEach((button) => {
        button.addEventListener('click', () => {
            const monitor = ctx.state.monitors.find((item) => item.id === Number(button.dataset.groupEdit));
            if (monitor) openMonitorForm(monitor, ctx);
        });
    });

    root.querySelectorAll('[data-action="add"]').forEach((button) => {
        if (!button.dataset.bound) {
            button.dataset.bound = '1';
            button.addEventListener('click', () => openMonitorForm(null, ctx));
        }
    });

    document.addEventListener(
        'click',
        () => {
            root.querySelectorAll('.menu').forEach((menu) => menu.remove());
        },
        { once: true }
    );
}

function field(label, inner, hint = '', full = false) {
    return `<div class="field ${full ? 'full' : ''}">
        <label>${escapeHtml(label)}</label>
        ${inner}
        ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

export function openMonitorForm(monitor, ctx) {
    const editing = Boolean(monitor);
    const value = (key, fallback = '') => {
        if (!monitor) return fallback;
        const current = monitor[key];
        return current === null || current === undefined ? fallback : current;
    };
    const selectedType = monitor?.type || 'http';
    const monitorOptions = monitor?.options || {};

    const modal = openModal({
        title: editing ? 'Ubah monitor' : 'Monitor baru',
        subtitle: editing ? monitor.name : 'Pilih tipe pemeriksaan lalu isi targetnya.',
        wide: true,
        body: `
            <form id="monitor-form" autocomplete="off">
                <div class="type-grid" id="type-grid">
                    ${TYPES.map(
                        (type) => `<button type="button" class="type-option ${
                            type.id === selectedType ? 'active' : ''
                        }" data-type="${type.id}"><b>${type.label}</b><span>${type.desc}</span></button>`
                    ).join('')}
                </div>
                <input type="hidden" name="type" value="${selectedType}" />

                <div class="form-grid mt-16">
                    ${field('Nama monitor', `<input class="input" name="name" required maxlength="150" value="${escapeHtml(
                        value('name')
                    )}" placeholder="Situs utama" />`, '', true)}

                    <div class="field full" id="row-url">
                        <label>URL</label>
                        <input class="input" name="url" placeholder="https://contoh.id" value="${escapeHtml(
                            value('url')
                        )}" />
                    </div>

                    <div class="field" id="row-method">
                        <label>Metode</label>
                        <select class="select" name="method">
                            ${['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
                                .map(
                                    (method) =>
                                        `<option ${value('method', 'GET') === method ? 'selected' : ''}>${method}</option>`
                                )
                                .join('')}
                        </select>
                    </div>

                    ${field(
                        'Kode status diterima',
                        `<input class="input" name="acceptedCodes" placeholder="200-299" value="${escapeHtml(
                            value('acceptedCodes')
                        )}" />`,
                        'Pisahkan dengan koma, contoh: 200-299, 301, 403'
                    )}

                    <div class="field" id="row-host">
                        <label>Hostname / IP</label>
                        <input class="input" name="hostname" placeholder="contoh.id atau 1.1.1.1" value="${escapeHtml(
                            value('hostname')
                        )}" />
                    </div>

                    <div class="field" id="row-port">
                        <label>Port</label>
                        <input class="input" name="port" type="number" min="1" max="65535" value="${escapeHtml(
                            value('port', '')
                        )}" />
                    </div>

                    <div class="field" id="row-keyword">
                        <label>Kata kunci</label>
                        <input class="input" name="keyword" value="${escapeHtml(
                            value('keyword')
                        )}" placeholder="Teks yang harus ada" />
                    </div>

                    <div class="field" id="row-jsonpath">
                        <label>JSON path</label>
                        <input class="input" name="jsonPath" value="${escapeHtml(
                            value('jsonPath')
                        )}" placeholder="$.status.healthy" />
                    </div>

                    <div class="field" id="row-expected">
                        <label>Nilai yang diharapkan</label>
                        <input class="input" name="expectedValue" value="${escapeHtml(
                            value('expectedValue')
                        )}" placeholder="true" />
                        <span class="hint">Kosongkan untuk sekadar memastikan path/record ada.</span>
                    </div>

                    <div class="field" id="row-dnstype">
                        <label>Tipe record DNS</label>
                        <select class="select" name="dnsRecordType">
                            ${DNS_TYPES.map(
                                (type) =>
                                    `<option ${value('dnsRecordType', 'A') === type ? 'selected' : ''}>${type}</option>`
                            ).join('')}
                        </select>
                    </div>

                    <div class="field" id="row-dnsresolver">
                        <label>Resolver DNS (opsional)</label>
                        <input class="input" name="dnsResolver" value="${escapeHtml(
                            value('dnsResolver')
                        )}" placeholder="1.1.1.1" />
                    </div>

                    <div class="field" data-only="redis" id="row-redis-password">
                        <label>Kata sandi Redis</label>
                        <input class="input" name="redisPassword" type="password" value="${escapeHtml(
                            monitorOptions.password || ''
                        )}" />
                    </div>
                    <div class="field" data-only="redis" id="row-redis-db">
                        <label>Database (nomor)</label>
                        <input class="input" name="redisDb" type="number" min="0" max="1024" value="${escapeHtml(
                            monitorOptions.db ?? 0
                        )}" />
                    </div>
                    <div class="field" data-only="redis" id="row-redis-command">
                        <label>Perintah</label>
                        <input class="input" name="redisCommand" value="${escapeHtml(
                            monitorOptions.command || 'PING'
                        )}" />
                        <span class="hint">Contoh: PING, GET kunci, INFO.</span>
                    </div>
                    <div class="field" data-only="redis" id="row-redis-expected">
                        <label>Balasan yang diharapkan</label>
                        <input class="input" name="redisExpected" value="${escapeHtml(
                            monitorOptions.expected || ''
                        )}" />
                        <span class="hint">Kosongkan untuk menganggap balasan apa pun sehat.</span>
                    </div>

                    <div class="field" data-only="mqtt" id="row-mqtt-topic">
                        <label>Topik</label>
                        <input class="input" name="mqttTopic" value="${escapeHtml(
                            monitorOptions.topic || ''
                        )}" placeholder="sensor/temperatur" />
                    </div>
                    <div class="field" data-only="mqtt" id="row-mqtt-user">
                        <label>Username (opsional)</label>
                        <input class="input" name="mqttUser" value="${escapeHtml(
                            monitorOptions.username || ''
                        )}" />
                    </div>
                    <div class="field" data-only="mqtt" id="row-mqtt-password">
                        <label>Kata sandi (opsional)</label>
                        <input class="input" name="mqttPassword" type="password" value="${escapeHtml(
                            monitorOptions.password || ''
                        )}" />
                    </div>
                    <div class="field" data-only="mqtt" id="row-mqtt-client">
                        <label>Client ID</label>
                        <input class="input" name="mqttClientId" value="${escapeHtml(
                            monitorOptions.clientId || ''
                        )}" placeholder="prasasti-1" />
                    </div>
                    <div class="field" data-only="mqtt" id="row-mqtt-expected">
                        <label>Isi pesan yang diharapkan</label>
                        <input class="input" name="mqttExpected" value="${escapeHtml(
                            monitorOptions.expected || ''
                        )}" />
                        <span class="hint">Kosongkan untuk menganggap pesan apa pun sehat.</span>
                    </div>

                    <div class="field" data-only="docker" id="row-docker-container">
                        <label>Nama atau ID container</label>
                        <input class="input" name="dockerContainer" value="${escapeHtml(
                            monitorOptions.container || ''
                        )}" placeholder="prasasti-api" />
                    </div>
                    <div class="field" data-only="docker" id="row-docker-socket">
                        <label>Socket Docker (opsional)</label>
                        <input class="input" name="dockerSocket" value="${escapeHtml(
                            monitorOptions.socket || ''
                        )}" placeholder="/var/run/docker.sock" />
                        <span class="hint">Kosongkan untuk memakai socket bawaan sistem.</span>
                    </div>

                    <div class="field" data-only="postgres" id="row-pg-user">
                        <label>Pengguna</label>
                        <input class="input" name="pgUser" value="${escapeHtml(
                            monitorOptions.user || 'postgres'
                        )}" />
                    </div>
                    <div class="field" data-only="postgres" id="row-pg-password">
                        <label>Kata sandi</label>
                        <input class="input" name="pgPassword" type="password" value="${escapeHtml(
                            monitorOptions.password || ''
                        )}" />
                    </div>
                    <div class="field" data-only="postgres" id="row-pg-database">
                        <label>Database</label>
                        <input class="input" name="pgDatabase" value="${escapeHtml(
                            monitorOptions.database || ''
                        )}" placeholder="postgres" />
                    </div>
                    <div class="field" data-only="postgres" id="row-pg-query">
                        <label>Kueri</label>
                        <input class="input" name="pgQuery" value="${escapeHtml(
                            monitorOptions.query || 'SELECT 1'
                        )}" />
                    </div>

                    ${field(
                        'Grup induk',
                        `<select class="select" name="parentId">
                            <option value="">Tanpa grup</option>
                            ${(ctx.state.monitors || [])
                                .filter((item) => item.type === 'group' && item.id !== monitor?.id)
                                .map(
                                    (group) =>
                                        `<option value="${group.id}" ${
                                            Number(value('parentId')) === group.id ? 'selected' : ''
                                        }>${escapeHtml(group.name)}</option>`
                                )
                                .join('')}
                        </select>`
                    )}

                    ${field(
                        'Interval (detik)',
                        `<input class="input" name="interval" type="number" min="20" max="86400" value="${escapeHtml(
                            value('interval', 60)
                        )}" />`,
                        'Minimal 20 detik.'
                    )}

                    ${field(
                        'Percobaan ulang',
                        `<input class="input" name="retries" type="number" min="0" max="20" value="${escapeHtml(
                            value('retries', 0)
                        )}" />`,
                        'Jumlah percobaan sebelum dinyatakan gangguan.'
                    )}

                    ${field(
                        'Jeda percobaan (detik)',
                        `<input class="input" name="retryInterval" type="number" min="5" max="3600" value="${escapeHtml(
                            value('retryInterval', 60)
                        )}" />`,
                        'Jarak antar percobaan ulang.'
                    )}

                    ${field(
                        'Timeout (detik)',
                        `<input class="input" name="timeout" type="number" min="1" max="120" value="${escapeHtml(
                            value('timeout', 15)
                        )}" />`
                    )}
                </div>

                <div class="divider"></div>
                <div class="eyebrow" style="margin-bottom:6px">Perilaku</div>
                <div id="switches">
                    ${switchRow('upsideDown', 'Balikkan status', 'Anggap monitor sehat saat pemeriksaan gagal (gunakan untuk deteksi blokir).', value('upsideDown'))}
                    ${switchRow('certExpiryNotification', 'Pantau sertifikat TLS', 'Kirim peringatan saat sertifikat mendekati kedaluwarsa.', value('certExpiryNotification', true))}
                    ${switchRow('domainExpiryNotification', 'Pantau masa berlaku domain', 'Cek tanggal kedaluwarsa domain lewat RDAP.', value('domainExpiryNotification'))}
                    ${switchRow('ignoreTls', 'Abaikan error TLS', 'Terima sertifikat self-signed atau tidak valid.', value('ignoreTls'))}
                    ${switchRow('active', 'Monitor aktif', 'Monitor yang dijeda tidak dijalankan.', value('active', true))}
                </div>

                <div class="divider"></div>
                <div class="form-grid">
                    ${field(
                        'Tag',
                        `<div class="chip-picker" id="tag-picker">
                            ${
                                (ctx.state.tags || []).length
                                    ? ctx.state.tags
                                          .map(
                                              (tag) => `<button type="button" class="chip ${
                                                  (monitor?.tags || []).some((item) => item.id === tag.id) ? 'on' : ''
                                              }" data-tag="${tag.id}"><span class="dot" style="background:${escapeHtml(
                                                  tag.color
                                              )}"></span>${escapeHtml(tag.name)}</button>`
                                          )
                                          .join('')
                                    : '<span class="hint">Belum ada tag. Buat dari halaman Pengaturan.</span>'
                            }
                        </div>`,
                        '',
                        true
                    )}
                    ${field(
                        'Notifikasi',
                        `<div class="chip-picker" id="notification-picker">
                            ${
                                (ctx.state.notifications || []).length
                                    ? ctx.state.notifications
                                          .map(
                                              (notification) => `<button type="button" class="chip ${
                                                  (monitor?.notificationIds || []).includes(notification.id) ? 'on' : ''
                                              }" data-notification="${notification.id}">${escapeHtml(
                                                  notification.name
                                              )}</button>`
                                          )
                                          .join('')
                                    : '<span class="hint">Belum ada kanal notifikasi.</span>'
                            }
                        </div>`,
                        'Notifikasi default selalu dikirim.',
                        true
                    )}
                    ${field(
                        'Deskripsi',
                        `<textarea class="textarea" name="description" placeholder="Catatan internal tentang monitor ini">${escapeHtml(
                            value('description')
                        )}</textarea>`,
                        '',
                        true
                    )}
                    <div class="field full" id="row-headers">
                        <label>Header HTTP (JSON)</label>
                        <textarea class="textarea" name="headers" placeholder='{"Authorization": "Bearer …"}'>${escapeHtml(
                            value('headers')
                        )}</textarea>
                    </div>
                    <div class="field full" id="row-body">
                        <label>Body permintaan</label>
                        <textarea class="textarea" name="body" placeholder="Hanya untuk POST/PUT/PATCH">${escapeHtml(
                            value('body')
                        )}</textarea>
                    </div>
                    ${field(
                        'Maksimum redirect',
                        `<input class="input" name="maxRedirects" type="number" min="0" max="20" value="${escapeHtml(
                            value('maxRedirects', 10)
                        )}" />`,
                        '',
                        true
                    )}
                </div>

                ${
                    editing && monitor.type === 'push'
                        ? `<div class="divider"></div>
                           <div class="eyebrow" style="margin-bottom:6px">Endpoint push</div>
                           <div class="code" id="push-url">${escapeHtml(
                               `${location.origin}/api/push/${monitor.pushToken}`
                           )}</div>
                           <span class="hint">Kirim GET/POST ke URL ini dengan parameter <code>status=up|down</code>, <code>msg</code>, dan <code>ping</code>.</span>`
                        : ''
                }
                <div id="form-error"></div>
            </form>
        `,
        footer: `
            <button class="btn ghost" data-close>Batal</button>
            <button class="btn primary" id="save-monitor" form="monitor-form" type="submit">${
                editing ? 'Simpan perubahan' : 'Buat monitor'
            }</button>
        `,
    });

    const form = modal.querySelector('#monitor-form');
    const typeInput = form.querySelector('input[name="type"]');

    const applyType = (type) => {
        const http = ['http', 'keyword', 'json'].includes(type);
        form.querySelector('#row-url').classList.toggle('hidden', !http);
        form.querySelector('#row-method').classList.toggle('hidden', !http);
        form.querySelector('#row-headers').classList.toggle('hidden', !http);
        form.querySelector('#row-body').classList.toggle('hidden', !http);
        form.querySelector('#row-keyword').classList.toggle('hidden', type !== 'keyword');
        form.querySelector('#row-jsonpath').classList.toggle('hidden', type !== 'json');
        form.querySelector('#row-expected').classList.toggle('hidden', !['json', 'dns'].includes(type));
        form.querySelector('#row-dnstype').classList.toggle('hidden', type !== 'dns');
        form.querySelector('#row-dnsresolver').classList.toggle('hidden', type !== 'dns');
        form.querySelector('#row-host').classList.toggle('hidden', !['tcp', 'ping', 'dns', 'redis', 'mqtt', 'postgres'].includes(type));
        form.querySelector('#row-port').classList.toggle('hidden', !['tcp', 'redis', 'mqtt', 'postgres'].includes(type));
        form.querySelector('#row-port input').placeholder = PORT_PLACEHOLDER[type] || '';
        form.querySelectorAll('[data-only]').forEach((row) => {
            row.classList.toggle('hidden', row.dataset.only !== type);
        });
    };
    applyType(selectedType);

    form.querySelectorAll('.type-option').forEach((button) => {
        button.addEventListener('click', () => {
            form.querySelectorAll('.type-option').forEach((item) => item.classList.remove('active'));
            button.classList.add('active');
            typeInput.value = button.dataset.type;
            applyType(button.dataset.type);
        });
    });

    form.querySelectorAll('.switch').forEach((button) => {
        button.addEventListener('click', () => button.classList.toggle('on'));
    });

    form.querySelectorAll('[data-tag]').forEach((button) => {
        button.addEventListener('click', () => button.classList.toggle('on'));
    });

    form.querySelectorAll('[data-notification]').forEach((button) => {
        button.addEventListener('click', () => button.classList.toggle('on'));
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = form.querySelector('#form-error');
        errorBox.innerHTML = '';
        const button = modal.querySelector('#save-monitor');
        button.disabled = true;
        button.textContent = 'Menyimpan…';

        const selectedType = typeInput.value;
        let options = {};
        if (selectedType === 'redis') {
            options = {
                password: form.redisPassword.value,
                db: Number(form.redisDb.value || 0),
                command: form.redisCommand.value.trim(),
                expected: form.redisExpected.value.trim(),
            };
        } else if (selectedType === 'mqtt') {
            options = {
                topic: form.mqttTopic.value.trim(),
                username: form.mqttUser.value.trim(),
                password: form.mqttPassword.value,
                clientId: form.mqttClientId.value.trim(),
                expected: form.mqttExpected.value.trim(),
            };
        } else if (selectedType === 'docker') {
            options = {
                container: form.dockerContainer.value.trim(),
                socket: form.dockerSocket.value.trim(),
            };
        } else if (selectedType === 'postgres') {
            options = {
                user: form.pgUser.value.trim(),
                password: form.pgPassword.value,
                database: form.pgDatabase.value.trim(),
                query: form.pgQuery.value.trim(),
            };
        }

        const data = {
            type: selectedType,
            name: form.name.value.trim(),
            url: form.url.value.trim(),
            hostname: form.hostname.value.trim(),
            port: form.port.value ? Number(form.port.value) : null,
            method: form.method.value,
            headers: form.headers.value.trim(),
            body: form.body.value,
            acceptedCodes: form.acceptedCodes.value.trim(),
            keyword: form.keyword.value,
            jsonPath: form.jsonPath.value.trim(),
            expectedValue: form.expectedValue.value,
            dnsRecordType: form.dnsRecordType.value,
            dnsResolver: form.dnsResolver.value.trim(),
            options,
            parentId: form.parentId.value ? Number(form.parentId.value) : null,
            interval: Number(form.interval.value),
            retries: Number(form.retries.value),
            retryInterval: Number(form.retryInterval.value),
            timeout: Number(form.timeout.value),
            maxRedirects: Number(form.maxRedirects.value),
            description: form.description.value,
            upsideDown: form.upsideDown.classList.contains('on'),
            certExpiryNotification: form.certExpiryNotification.classList.contains('on'),
            domainExpiryNotification: form.domainExpiryNotification.classList.contains('on'),
            ignoreTls: form.ignoreTls.classList.contains('on'),
            active: form.active.classList.contains('on'),
            tags: [...form.querySelectorAll('[data-tag].on')].map((item) => Number(item.dataset.tag)),
            notificationIds: [...form.querySelectorAll('[data-notification].on')].map((item) =>
                Number(item.dataset.notification)
            ),
        };

        try {
            if (editing) {
                await endpoints.updateMonitor(monitor.id, data);
            } else {
                await endpoints.createMonitor(data);
            }
            closeModal();
            toast(editing ? 'Monitor diperbarui' : 'Monitor dibuat', data.name, 'ok');
            await ctx.reload();
        } catch (error) {
            button.disabled = false;
            button.textContent = editing ? 'Simpan perubahan' : 'Buat monitor';
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
