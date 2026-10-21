import { api, endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    statusMeta,
    fmtDate,
    timeAgo,
    openModal,
    closeModal,
    confirmDialog,
    toast,
    copyText,
} from '../ui.js';

export async function render(root, ctx) {
    const { state } = ctx;
    const pages = state.statusPages || [];
    const monitors = (state.monitors || []).filter((monitor) => monitor.type !== 'group');

    root.innerHTML = `
        <div class="page-head">
            <div class="grow">
                <h1 class="page-title">Status Page</h1>
                <div class="page-sub">Halaman publik yang bisa Anda bagikan ke pengguna. Monitor yang dipilih tampil beserta riwayat dan insidennya.</div>
            </div>
            <div class="head-actions">
                <button class="btn primary" data-action="add">${icon('plus', 15)}<span>Status page baru</span></button>
            </div>
        </div>
        ${
            pages.length
                ? `<div class="list-grid ledger-list">${pages.map((page) => rowHtml(page, monitors)).join('')}</div>`
                : `<div class="empty">
                    <div class="empty-icon">${icon('layout', 20)}</div>
                    <h3>Belum ada status page</h3>
                    <p>Buat halaman status publik untuk menampilkan kondisi layanan tanpa harus membuka dasbor.</p>
                    <button class="btn primary" data-action="add">${icon('plus', 15)} Buat status page</button>
                </div>`
        }
    `;

    root.querySelectorAll('[data-action="add"]').forEach((button) =>
        button.addEventListener('click', () => openStatusPageForm(null, ctx))
    );

    root.querySelectorAll('[data-edit]').forEach((button) =>
        button.addEventListener('click', () => {
            const page = pages.find((item) => item.id === Number(button.dataset.edit));
            if (page) openStatusPageForm(page, ctx);
        })
    );

    root.querySelectorAll('[data-incidents]').forEach((button) =>
        button.addEventListener('click', () => {
            const page = pages.find((item) => item.id === Number(button.dataset.incidents));
            if (page) openIncidents(page, ctx);
        })
    );

    root.querySelectorAll('[data-publish]').forEach((button) =>
        button.addEventListener('click', async () => {
            const page = pages.find((item) => item.id === Number(button.dataset.publish));
            if (!page) return;
            button.disabled = true;
            try {
                await endpoints.publishStatusPage(page.id, !page.published);
                toast(page.published ? 'Status page disembunyikan' : 'Status page diterbitkan', page.title, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
                button.disabled = false;
            }
        })
    );

    root.querySelectorAll('[data-copy]').forEach((button) =>
        button.addEventListener('click', () => {
            const page = pages.find((item) => item.id === Number(button.dataset.copy));
            if (page) copyText(`${location.origin}/status/${page.slug}`);
        })
    );

    root.querySelectorAll('[data-delete]').forEach((button) =>
        button.addEventListener('click', async () => {
            const page = pages.find((item) => item.id === Number(button.dataset.delete));
            if (!page) return;
            const ok = await confirmDialog({
                title: 'Hapus status page',
                message: `Status page “${page.title}” dan seluruh insidennya akan dihapus. Tautan publiknya berhenti berfungsi.`,
                confirmLabel: 'Hapus status page',
            });
            if (!ok) return;
            try {
                await endpoints.deleteStatusPage(page.id);
                toast('Status page dihapus', page.title, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );
}

function rowHtml(page, monitors) {
    const monitorCount =
        (page.monitors || []).length + (page.groups || []).reduce((total, group) => total + group.monitors.length, 0);
    return `<div class="row-card">
        <span class="status-dot ${page.published ? 'up' : 'pending'}"></span>
        <div class="grow">
            <div class="inline" style="gap:8px">
                <h3>${escapeHtml(page.title)}</h3>
                <span class="pill ${page.published ? 'up' : 'paused'}">${page.published ? 'Publik' : 'Draf'}</span>
            </div>
            <div class="meta">/status/${escapeHtml(page.slug)} · ${monitorCount} monitor · ${
        page.groups.length
    } grup · dibuat ${fmtDate(page.createdAt, false)}</div>
        </div>
        <div class="actions">
            ${
                page.published
                    ? `<a class="btn sm ghost" href="/status/${encodeURIComponent(page.slug)}" target="_blank" rel="noopener">${icon(
                          'external',
                          13
                      )} Buka</a>`
                    : ''
            }
            <button class="btn sm ghost" data-copy="${page.id}">${icon('copy', 13)} Salin tautan</button>
            <button class="btn sm ghost" data-incidents="${page.id}">${icon('alert', 13)} Insiden</button>
            <button class="btn sm ghost" data-edit="${page.id}">${icon('edit', 13)} Ubah</button>
            <button class="btn sm ghost" data-publish="${page.id}">${page.published ? 'Sembunyikan' : 'Terbitkan'}</button>
            <button class="btn sm danger" data-delete="${page.id}" aria-label="Hapus">${icon('trash', 13)}</button>
        </div>
    </div>`;
}

function monitorChips(monitors, selected, groupIndex) {
    if (!monitors.length) {
        return '<span class="hint">Belum ada monitor.</span>';
    }
    return monitors
        .map(
            (monitor) => `<button type="button" class="chip ${
                selected.includes(monitor.id) || selected.includes(String(monitor.id)) ? 'on' : ''
            }" data-group-monitor="${monitor.id}" data-group-index="${groupIndex}"><span class="dot" style="background:${
                statusMeta(monitor.status).cls === 'up'
                    ? 'var(--up)'
                    : statusMeta(monitor.status).cls === 'down'
                      ? 'var(--down)'
                      : 'var(--faint)'
            }"></span>${escapeHtml(monitor.name)}</button>`
        )
        .join('');
}

export function openStatusPageForm(page, ctx) {
    const monitors = (ctx.state.monitors || []).filter((monitor) => monitor.type !== 'group');
    const editing = Boolean(page);
    const groups = page ? page.groups.map((group) => ({ name: group.name, monitors: [...group.monitors] })) : [];
    const ungrouped = page ? (page.monitors || []).map((item) => item.monitorId) : [];

    const modal = openModal({
        title: editing ? 'Ubah status page' : 'Status page baru',
        subtitle: editing ? `/status/${page.slug}` : 'Halaman publik dengan riwayat dan insiden.',
        wide: true,
        body: `
            <form id="status-page-form" autocomplete="off">
                <div class="form-grid">
                    ${field(
                        'Judul',
                        `<input class="input" name="title" required maxlength="150" value="${escapeHtml(
                            page?.title || ''
                        )}" placeholder="Status Layanan Prasasti" />`
                    )}
                    ${field(
                        'Slug',
                        `<input class="input" name="slug" maxlength="60" value="${escapeHtml(
                            page?.slug || ''
                        )}" placeholder="status" />`,
                        'Alamat publik: /status/<slug>'
                    )}
                    ${field(
                        'Deskripsi',
                        `<textarea class="textarea" name="description" placeholder="Informasi singkat untuk pengunjung">${escapeHtml(
                            page?.description || ''
                        )}</textarea>`,
                        '',
                        true
                    )}
                    ${field(
                        'Ikon',
                        `<input class="input" name="icon" value="${escapeHtml(
                            page?.icon || '/favicon.svg'
                        )}" placeholder="/favicon.svg" />`,
                        'URL gambar untuk favicon halaman publik.'
                    )}
                    ${field(
                        'Teks footer',
                        `<input class="input" name="footerText" maxlength="300" value="${escapeHtml(
                            page?.footerText || ''
                        )}" placeholder="Dikelola oleh tim infrastruktur" />`
                    )}
                </div>

                <div class="divider"></div>
                <div class="inline" style="margin-bottom:8px">
                    <div class="eyebrow">Monitor tanpa grup</div>
                    <span class="spacer"></span>
                    <span class="page-note">Klik untuk memilih</span>
                </div>
                <div class="chip-picker" id="page-monitors">
                    ${monitorChips(monitors, ungrouped, 'root')}
                </div>

                <div class="divider"></div>
                <div class="inline" style="margin-bottom:8px">
                    <div class="eyebrow">Grup monitor</div>
                    <span class="spacer"></span>
                    <button type="button" class="btn sm ghost" id="add-group">${icon('plus', 13)} Tambah grup</button>
                </div>
                <div id="group-editor" class="list-grid"></div>
                <p class="page-note">Grup membantu mengelompokkan layanan pada halaman publik, misalnya “API” atau “Situs Utama”.</p>

                <div class="divider"></div>
                <div id="page-switches">
                    ${switchRow('published', 'Terbitkan halaman', 'Halaman dapat diakses publik tanpa login.', page?.published)}
                    ${switchRow('showTags', 'Tampilkan tag', 'Tampilkan label seperti produksi atau internal.', page?.showTags ?? true)}
                    ${switchRow('showPoweredBy', 'Tampilkan kredit Prasasti', 'Footer kecil “Didukung Uptime Prasasti”.', page?.showPoweredBy ?? true)}
                </div>
                <div id="page-error"></div>
            </form>
        `,
        footer: `
            <button class="btn ghost" data-close>Batal</button>
            <button class="btn primary" type="submit" form="status-page-form" id="save-page">${
                editing ? 'Simpan perubahan' : 'Buat status page'
            }</button>
        `,
    });

    const form = modal.querySelector('#status-page-form');
    const editor = form.querySelector('#group-editor');

    const addGroupRow = (group = { name: '', monitors: [] }) => {
        const index = `g${Date.now()}${Math.random().toString(16).slice(2, 5)}`;
        const row = document.createElement('div');
        row.className = 'row-card';
        row.dataset.groupRow = index;
        row.innerHTML = `
            <div class="grow" style="min-width:240px">
                <input class="input" data-group-name placeholder="Nama grup, misalnya API" maxlength="100" value="${escapeHtml(
                    group.name
                )}" />
                <div class="chip-picker mt-8" data-group-chips>
                    ${monitorChips(monitors, group.monitors, index)}
                </div>
            </div>
            <button type="button" class="btn sm danger" data-remove-group>${icon('trash', 13)}</button>
        `;
        row.querySelector('[data-remove-group]').addEventListener('click', () => row.remove());
        row.querySelectorAll('[data-group-monitor]').forEach((chip) => {
            chip.addEventListener('click', () => chip.classList.toggle('on'));
        });
        editor.append(row);
    };

    groups.forEach(addGroupRow);
    form.querySelector('#add-group').addEventListener('click', () => addGroupRow());

    form.querySelectorAll('#page-monitors .chip').forEach((chip) =>
        chip.addEventListener('click', () => chip.classList.toggle('on'))
    );

    form.querySelectorAll('.switch').forEach((button) =>
        button.addEventListener('click', () => button.classList.toggle('on'))
    );

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = form.querySelector('#page-error');
        errorBox.innerHTML = '';
        const button = modal.querySelector('#save-page');
        button.disabled = true;
        button.textContent = 'Menyimpan…';

        const groupPayload = [...editor.querySelectorAll('[data-group-row]')]
            .map((row) => ({
                name: row.querySelector('[data-group-name]').value.trim(),
                monitors: [...row.querySelectorAll('[data-group-monitor].on')].map((chip) =>
                    Number(chip.dataset.groupMonitor)
                ),
            }))
            .filter((group) => group.name);

        const payload = {
            title: form.title.value.trim(),
            slug: form.slug.value.trim(),
            description: form.description.value,
            icon: form.icon.value.trim(),
            footerText: form.footerText.value,
            published: form.published.classList.contains('on'),
            showTags: form.showTags.classList.contains('on'),
            showPoweredBy: form.showPoweredBy.classList.contains('on'),
            monitors: [...form.querySelectorAll('#page-monitors .chip.on')].map((chip) =>
                Number(chip.dataset.groupMonitor)
            ),
            groups: groupPayload,
        };

        try {
            if (editing) await endpoints.updateStatusPage(page.id, payload);
            else await endpoints.statusPage(payload);
            closeModal();
            toast(editing ? 'Status page diperbarui' : 'Status page dibuat', payload.title, 'ok');
            await ctx.reload();
        } catch (error) {
            button.disabled = false;
            button.textContent = editing ? 'Simpan perubahan' : 'Buat status page';
            errorBox.innerHTML = `<div class="alert" style="margin-top:14px">${escapeHtml(error.message)}</div>`;
        }
    });
}

function field(label, inner, hint = '', full = false) {
    return `<div class="field ${full ? 'full' : ''}">
        <label>${escapeHtml(label)}</label>
        ${inner}
        ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

function switchRow(name, title, description, on) {
    return `<div class="switch-row">
        <button type="button" class="switch ${on ? 'on' : ''}" name="${name}" aria-pressed="${on ? 'true' : 'false'}"></button>
        <div class="switch-text"><b>${escapeHtml(title)}</b><span>${escapeHtml(description)}</span></div>
    </div>`;
}

export async function openIncidents(page, ctx) {
    const data = await api(`/api/incidents?statusPageId=${page.id}`);
    const modal = openModal({
        title: `Insiden · ${page.title}`,
        subtitle: 'Catat gangguan, pemeliharaan, atau informasi penting lain di halaman publik.',
        wide: true,
        body: `
            <div class="panel" style="margin-bottom:16px">
                <div class="panel-head"><h3>Insiden baru</h3></div>
                <div class="panel-body">
                    <form id="incident-form">
                        <div class="form-grid">
                            ${field(
                                'Judul',
                                '<input class="input" name="title" required maxlength="200" placeholder="Gangguan API pembayaran" />'
                            )}
                            ${field(
                                'Gaya',
                                `<select class="select" name="style">
                                    <option value="warning">Peringatan</option>
                                    <option value="danger">Gangguan</option>
                                    <option value="info">Informasi</option>
                                    <option value="success">Pulih</option>
                                </select>`
                            )}
                            ${field(
                                'Isi',
                                '<textarea class="textarea" name="content" placeholder="Penjelasan singkat, dampak, dan tindakan."></textarea>',
                                '',
                                true
                            )}
                            ${field(
                                'Mulai',
                                `<input class="input" name="startedAt" type="datetime-local" value="${toLocalInput(
                                    Date.now()
                                )}" />`
                            )}
                        </div>
                        <div id="incident-error"></div>
                        <div class="inline mt-16">
                            <button class="btn primary sm" type="submit">${icon('plus', 13)} Tambahkan insiden</button>
                        </div>
                    </form>
                </div>
            </div>
            <div class="panel">
                <div class="panel-head"><h3>Daftar insiden</h3><span class="spacer"></span><span class="page-note">${
                    data.incidents.length
                } catatan</span></div>
                <div class="panel-body" style="padding:0">
                    <div class="table-wrap">
                        <table class="table">
                            <thead><tr><th>Judul</th><th>Mulai</th><th>Status</th><th></th></tr></thead>
                            <tbody id="incident-rows">
                                ${
                                    data.incidents.length
                                        ? data.incidents.map((incident) => incidentRow(incident)).join('')
                                        : '<tr><td colspan="4" class="muted">Belum ada insiden untuk halaman ini.</td></tr>'
                                }
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `,
        footer: `<button class="btn ghost" data-close>Tutup</button>`,
    });

    const form = modal.querySelector('#incident-form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            await endpoints.incident({
                statusPageId: page.id,
                title: form.title.value.trim(),
                content: form.content.value,
                style: form.style.value,
                startedAt: form.startedAt.value ? new Date(form.startedAt.value).getTime() : Date.now(),
            });
            toast('Insiden ditambahkan', form.title.value.trim(), 'ok');
            await ctx.reload();
            openIncidents(page, ctx);
        } catch (error) {
            document.getElementById('incident-error').innerHTML = `<div class="alert" style="margin-top:12px">${escapeHtml(
                error.message
            )}</div>`;
            button.disabled = false;
        }
    });

    const bindRows = () => {
        modal.querySelectorAll('[data-incident-resolve]').forEach((button) =>
            button.addEventListener('click', async () => {
                try {
                    await endpoints.resolveIncident(Number(button.dataset.incidentResolve));
                    toast('Insiden diselesaikan', '', 'ok');
                    await ctx.reload();
                    openIncidents(page, ctx);
                } catch (error) {
                    ctx.notifyError(error);
                }
            })
        );
        modal.querySelectorAll('[data-incident-delete]').forEach((button) =>
            button.addEventListener('click', async () => {
                const ok = await confirmDialog({
                    title: 'Hapus insiden',
                    message: 'Catatan insiden ini akan dihapus dari status page.',
                    confirmLabel: 'Hapus',
                });
                if (!ok) return;
                try {
                    await endpoints.deleteIncident(Number(button.dataset.incidentDelete));
                    toast('Insiden dihapus', '', 'ok');
                    await ctx.reload();
                    openIncidents(page, ctx);
                } catch (error) {
                    ctx.notifyError(error);
                }
            })
        );
    };
    bindRows();
}

function incidentRow(incident) {
    return `<tr>
        <td>
            <div style="font-weight:500">${escapeHtml(incident.title)}</div>
            <div class="tiny muted" style="max-width:420px">${escapeHtml((incident.content || '').slice(0, 120))}</div>
        </td>
        <td class="mono tiny">${fmtDate(incident.startedAt)}</td>
        <td>${
            incident.resolvedAt
                ? `<span class="pill up">Selesai</span><div class="tiny muted">${timeAgo(incident.resolvedAt)}</div>`
                : `<span class="pill down">Berlangsung</span>`
        }</td>
        <td>
            <div class="inline" style="justify-content:flex-end">
                ${
                    incident.resolvedAt
                        ? ''
                        : `<button class="btn sm ghost" data-incident-resolve="${incident.id}">Selesaikan</button>`
                }
                <button class="btn sm danger" data-incident-delete="${incident.id}" aria-label="Hapus">${icon(
                    'trash',
                    12
                )}</button>
            </div>
        </td>
    </tr>`;
}

function toLocalInput(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
        date.getMinutes()
    )}`;
}
