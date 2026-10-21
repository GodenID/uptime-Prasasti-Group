import { api, endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    beatStrip,
    statusMeta,
    fmtPercent,
    fmtPing,
    fmtDate,
    fmtDuration,
    timeAgo,
    typeLabel,
    typeGlyph,
    targetOf,
    uptimeClass,
    openModal,
    closeModal,
    confirmDialog,
    toast,
    copyText,
    fmtTime,
} from '../ui.js';
import { lineChart } from '../chart.js';
import { openMonitorForm } from './dashboard.js';

export async function render(root, ctx) {
    const id = Number(ctx.params.id);
    const data = await api(`/api/monitors/${id}`);
    const monitor = data.monitor;
    const local = { data, range: 24 };

    draw(root, ctx, local);

    root.querySelector('[data-action="back"]')?.addEventListener('click', () => ctx.navigate('#/'));
    root.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
        openMonitorForm(monitor, ctx);
    });
    root.querySelector('[data-action="check"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.innerHTML = `${icon('refresh', 15)}<span>Memeriksa…</span>`;
        try {
            const result = await endpoints.checkMonitor(id);
            toast(statusMeta(result.beat.status).label, result.beat.msg, result.beat.status === 1 ? 'ok' : 'err');
            const fresh = await api(`/api/monitors/${id}`);
            local.data = fresh;
            draw(root, ctx, local);
        } catch (error) {
            ctx.notifyError(error);
        }
    });
    root.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
        try {
            if (monitor.active) await endpoints.pauseMonitor(id);
            else await endpoints.resumeMonitor(id);
            const fresh = await api(`/api/monitors/${id}`);
            local.data = fresh;
            draw(root, ctx, local);
            toast(monitor.active ? 'Monitor dijeda' : 'Monitor dilanjutkan', monitor.name, 'ok');
        } catch (error) {
            ctx.notifyError(error);
        }
    });
    root.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
        const ok = await confirmDialog({
            title: 'Hapus monitor',
            message: `Monitor “${monitor.name}” beserta seluruh riwayat heartbeat akan dihapus permanen.`,
            confirmLabel: 'Hapus monitor',
        });
        if (!ok) return;
        try {
            await endpoints.deleteMonitor(id);
            toast('Monitor dihapus', monitor.name, 'ok');
            ctx.navigate('#/');
        } catch (error) {
            ctx.notifyError(error);
        }
    });

    root.querySelectorAll('[data-range]').forEach((button) => {
        button.addEventListener('click', async () => {
            const hours = Number(button.dataset.range);
            local.range = hours;
            root.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('active', item === button));
            const chartData = await api(`/api/monitors/${id}/chart?hours=${hours}`);
            const chartBox = root.querySelector('#chart');
            lineChart(chartBox, chartData.chart, { height: 200 });
        });
    });

    root.querySelector('[data-action="copy-push"]')?.addEventListener('click', () => {
        copyText(`${location.origin}/api/push/${monitor.pushToken}`);
    });

    root.querySelectorAll('[data-resolve-incident]').forEach((button) => {
        button.addEventListener('click', async () => {
            try {
                await endpoints.resolveIncident(Number(button.dataset.resolveIncident));
                const fresh = await api(`/api/monitors/${id}`);
                local.data = fresh;
                draw(root, ctx, local);
                toast('Insiden diselesaikan', '', 'ok');
            } catch (error) {
                ctx.notifyError(error);
            }
        });
    });

    let eventOffset = data.events.length;
    root.querySelector('[data-action="more-events"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const more = await endpoints.monitorEvents(id, eventOffset);
            eventOffset += more.events.length;
            const list = root.querySelector('#event-list');
            if (list) {
                list.insertAdjacentHTML(
                    'beforeend',
                    more.events.map((beat) => eventRow(beat)).join('')
                );
            }
            if (!more.events.length || eventOffset >= more.total) button.remove();
            else button.disabled = false;
        } catch (error) {
            ctx.notifyError(error);
            button.disabled = false;
        }
    });

    return {
        onBeat(message) {
            if (message.monitorId !== id) return;
            local.data.monitor = message.summary;
            local.data.monitor.beats = [...(local.data.monitor.beats || []), message.beat].slice(-60);
            const fresh = local.data.monitor;
            const hero = root.querySelector('#detail-status');
            if (hero) {
                const meta = statusMeta(fresh.status);
                hero.className = `pill ${meta.cls}`;
                hero.textContent = meta.label;
            }
            const strip = root.querySelector('#detail-beats');
            if (strip) strip.innerHTML = beatStrip(fresh.beats, 60, { large: true });
            const uptime = root.querySelector('#detail-uptime24');
            if (uptime) uptime.textContent = fmtPercent(fresh.uptime24, 2);
            const ping = root.querySelector('#detail-ping24');
            if (ping) ping.textContent = fmtPing(fresh.avgPing24);
        },
        onRefresh() {
            render(root, ctx).catch((error) => ctx.notifyError(error));
        },
    };
}

function draw(root, ctx, local) {
    const { data, range } = local;
    const monitor = data.monitor;
    const meta = statusMeta(monitor.status);
    const paused = !monitor.active;
    const target = targetOf(monitor);
    const cert = monitor.cert;
    const uptime = data.uptime;

    root.innerHTML = `
        <a class="back-link" data-action="back" href="#/">${icon('chevron', 14)} Kembali ke dasbor</a>
        <div class="detail-hero">
            <div class="grow">
                <div class="detail-title">
                    <span>${escapeHtml(monitor.name)}</span>
                    <span class="pill ${paused ? 'paused' : meta.cls}" id="detail-status">${
                        paused ? 'Dijeda' : meta.label
                    }</span>
                </div>
                <div class="detail-target">${escapeHtml(target)}</div>
                <div class="inline mt-8">
                    <span class="tag">${escapeHtml(typeLabel(monitor.type))}</span>
                    <span class="tag">tiap ${monitor.interval} dtk</span>
                    ${(monitor.tags || [])
                        .map(
                            (tag) =>
                                `<span class="tag"><span class="dot" style="background:${escapeHtml(
                                    tag.color
                                )}"></span>${escapeHtml(tag.name)}</span>`
                        )
                        .join('')}
                    ${
                        monitor.cert && typeof monitor.cert.daysRemaining === 'number'
                            ? `<span class="tag" style="color:${
                                  monitor.cert.daysRemaining < 14 ? 'var(--down)' : 'var(--ink-2)'
                              }">TLS ${monitor.cert.daysRemaining} hari</span>`
                            : ''
                    }
                </div>
            </div>
            <div class="head-actions">
                <button class="btn ghost" data-action="check">${icon('refresh', 15)}<span>Periksa</span></button>
                <button class="btn ghost" data-action="toggle">${icon(monitor.active ? 'pause' : 'play', 15)}<span>${
                    monitor.active ? 'Jeda' : 'Lanjut'
                }</span></button>
                <button class="btn ghost" data-action="edit">${icon('edit', 15)}<span>Ubah</span></button>
                <button class="btn danger" data-action="delete" aria-label="Hapus">${icon('trash', 15)}</button>
            </div>
        </div>

        <div class="uptime-grid">
            ${uptimeBox('24 jam', uptime['24h'], 'detail-uptime24')}
            ${uptimeBox('7 hari', uptime['7d'])}
            ${uptimeBox('30 hari', uptime['30d'])}
            ${uptimeBox('1 tahun', uptime['365d'])}
        </div>

        <div class="detail-cols">
            <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
                ${
                    monitor.type === 'group'
                        ? groupChildren(monitor)
                        : `<div class="chart-box">
                    <div class="chart-head">
                        <h3>Waktu respons</h3>
                        <span class="page-note" id="detail-ping24">${fmtPing(monitor.avgPing24)} rata-rata</span>
                        <span class="spacer"></span>
                        <div class="tabs" style="margin:0;border:none">
                            ${[24, 168, 720]
                                .map(
                                    (hours) =>
                                        `<button class="tab ${range === hours ? 'active' : ''}" data-range="${hours}">${
                                            hours === 24 ? '24 jam' : hours === 168 ? '7 hari' : '30 hari'
                                        }</button>`
                                )
                                .join('')}
                        </div>
                    </div>
                    <div class="chart" id="chart"></div>
                    <div class="divider" style="margin:10px 0"></div>
                    <div class="chart-head"><h3 style="font-size:13px">Heartbeat</h3><span class="page-note">60 pemeriksaan terakhir</span></div>
                    <div id="detail-beats">${beatStrip(monitor.beats, 60, { large: true })}</div>
                    <div class="beat-labels"><span>lama</span><span>sekarang</span></div>
                </div>`
                }

                <div class="panel">
                    <div class="panel-head">
                        <h3>Log kejadian</h3>
                        <span class="spacer"></span>
                        <span class="page-note">${data.events.length} terbaru</span>
                    </div>
                    <div class="panel-body">
                        <div class="event-list" id="event-list">
                            ${
                                data.events.length
                                    ? data.events.map((beat) => eventRow(beat)).join('')
                                    : '<div class="page-note">Belum ada kejadian.</div>'
                            }
                        </div>
                        <div class="inline mt-16">
                            <button class="btn sm ghost" data-action="more-events">Muat lebih banyak</button>
                        </div>
                    </div>
                </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
                <div class="panel">
                    <div class="panel-head"><h3>Detail</h3></div>
                    <div class="panel-body" style="padding-top:4px">
                        <div class="kv"><span class="k">Tipe</span><span class="v">${escapeHtml(
                            typeLabel(monitor.type)
                        )}</span></div>
                        <div class="kv"><span class="k">Target</span><span class="v">${escapeHtml(target)}</span></div>
                        <div class="kv"><span class="k">Interval</span><span class="v">${monitor.interval} detik</span></div>
                        <div class="kv"><span class="k">Timeout</span><span class="v">${monitor.timeout} detik</span></div>
                        <div class="kv"><span class="k">Percobaan ulang</span><span class="v">${monitor.retries}× / ${
                            monitor.retryInterval
                        } detik</span></div>
                        <div class="kv"><span class="k">Terakhir diperiksa</span><span class="v">${
                            monitor.lastBeat ? fmtTime(monitor.lastBeat.time) : '—'
                        }</span></div>
                        <div class="kv"><span class="k">Status terakhir</span><span class="v">${escapeHtml(
                            monitor.lastBeat ? monitor.lastBeat.msg : 'Belum ada data'
                        )}</span></div>
                        ${
                            monitor.parentName
                                ? `<div class="kv"><span class="k">Grup</span><span class="v">${escapeHtml(
                                      monitor.parentName
                                  )}</span></div>`
                                : ''
                        }
                        ${
                            monitor.description
                                ? `<div class="kv"><span class="k">Catatan</span><span class="v">${escapeHtml(
                                      monitor.description
                                  )}</span></div>`
                                : ''
                        }
                    </div>
                </div>

                ${
                    cert
                        ? `<div class="panel">
                    <div class="panel-head"><h3>Sertifikat TLS</h3></div>
                    <div class="panel-body" style="padding-top:4px">
                        <div class="kv"><span class="k">Subjek</span><span class="v">${escapeHtml(
                            cert.subject || '—'
                        )}</span></div>
                        <div class="kv"><span class="k">Penerbit</span><span class="v">${escapeHtml(
                            cert.issuer || '—'
                        )}</span></div>
                        <div class="kv"><span class="k">Berlaku hingga</span><span class="v">${fmtDate(
                            Date.parse(cert.validTo)
                        )}</span></div>
                        <div class="kv"><span class="k">Sisa</span><span class="v" style="color:${
                            cert.daysRemaining < 14 ? 'var(--down)' : 'var(--up)'
                        }">${cert.daysRemaining} hari</span></div>
                    </div>
                </div>`
                        : ''
                }

                ${
                    monitor.domain
                        ? `<div class="panel">
                    <div class="panel-head"><h3>Domain</h3></div>
                    <div class="panel-body" style="padding-top:4px">
                        <div class="kv"><span class="k">Domain</span><span class="v">${escapeHtml(
                            monitor.domain.domain || '—'
                        )}</span></div>
                        <div class="kv"><span class="k">Kedaluwarsa</span><span class="v">${
                            monitor.domain.expiresAt ? fmtDate(monitor.domain.expiresAt, false) : 'Tidak diketahui'
                        }</span></div>
                        <div class="kv"><span class="k">Registrar</span><span class="v">${escapeHtml(
                            monitor.domain.registrar || '—'
                        )}</span></div>
                    </div>
                </div>`
                        : ''
                }

                ${
                    monitor.type === 'push'
                        ? `<div class="panel">
                    <div class="panel-head"><h3>Endpoint push</h3></div>
                    <div class="panel-body">
                        <div class="code">${escapeHtml(`${location.origin}/api/push/${monitor.pushToken}`)}</div>
                        <div class="inline mt-8">
                            <button class="btn sm ghost" data-action="copy-push">${icon('copy', 13)} Salin URL</button>
                        </div>
                        <p class="page-note" style="margin:10px 0 0">Contoh:<br /><code>curl "${escapeHtml(
                            location.origin
                        )}/api/push/${monitor.pushToken}?status=up&amp;ping=42"</code></p>
                    </div>
                </div>`
                        : ''
                }

                ${
                    data.incidents.length
                        ? `<div class="panel">
                    <div class="panel-head"><h3>Insiden</h3></div>
                    <div class="panel-body">
                        <div class="event-list">
                            ${data.incidents
                                .map(
                                    (incident) => `<div class="event-row">
                                        <span class="event-dot ${incident.resolvedAt ? 'up' : 'down'}"></span>
                                        <div class="event-main">
                                            <div class="event-msg">${escapeHtml(incident.title)}</div>
                                            <div class="event-meta">${fmtDate(incident.startedAt)}${
                                                incident.resolvedAt
                                                    ? ` · selesai ${fmtDate(incident.resolvedAt)}`
                                                    : ' · berlangsung'
                                            }</div>
                                        </div>
                                        ${
                                            incident.resolvedAt
                                                ? ''
                                                : `<button class="btn sm ghost" data-resolve-incident="${incident.id}">Selesaikan</button>`
                                        }
                                    </div>`
                                )
                                .join('')}
                        </div>
                    </div>
                </div>`
                        : ''
                }
            </div>
        </div>
    `;

    const chartEl = root.querySelector('#chart');
    if (chartEl) lineChart(chartEl, data.chart, { height: 200 });
}

function uptimeBox(label, value, id = '') {
    return `<div class="uptime-box">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value ${uptimeClass(value?.uptime)}" ${id ? `id="${id}"` : ''}>${fmtPercent(
            value?.uptime,
            2
        )}</div>
        <div class="sub">${fmtPing(value?.avgPing)} rata-rata · ${value?.total || 0} pemeriksaan</div>
    </div>`;
}

function eventRow(beat) {
    const meta = statusMeta(beat.status);
    return `<div class="event-row">
        <span class="event-dot ${meta.cls}"></span>
        <div class="event-main">
            <div class="event-msg">${escapeHtml(beat.msg || meta.label)}</div>
            <div class="event-meta">${fmtDate(beat.time)}${beat.ping ? ` · ${fmtPing(beat.ping)}` : ''} · ${
                    beat.important ? 'penting' : 'rutin'
                }</div>
        </div>
        <span class="pill ${meta.cls}">${meta.label}</span>
    </div>`;
}

function groupChildren(monitor) {
    return `<div class="panel">
        <div class="panel-head"><h3>Anggota grup</h3><span class="spacer"></span><span class="page-note">${
            monitor.childrenCount || 0
        } monitor</span></div>
        <div class="panel-body">
            ${
                monitor.children?.length
                    ? `<div class="list-grid ledger-list">${monitor.children
                          .map(
                              (child) => `<a class="row-card" href="#/monitor/${child.id}" style="text-decoration:none;color:inherit">
                                <span class="status-dot ${statusMeta(child.status).cls}"></span>
                                <div class="grow"><h3>${escapeHtml(child.name)}</h3><div class="meta">${escapeHtml(
                                    targetOf(child)
                                )}</div></div>
                                <span class="pill ${statusMeta(child.status).cls}">${statusMeta(child.status).label}</span>
                              </a>`
                          )
                          .join('')}</div>`
                    : '<div class="page-note">Belum ada monitor di grup ini.</div>'
            }
        </div>
    </div>`;
}
