import { endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    fmtDate,
    openModal,
    closeModal,
    confirmDialog,
    toast,
} from '../ui.js';

function stateOf(maintenance) {
    const now = Date.now();
    if (!maintenance.active) return { key: 'paused', label: 'Dijeda', cls: 'paused' };
    if (maintenance.startAt > now) return { key: 'upcoming', label: 'Terjadwal', cls: 'pending' };
    if (maintenance.endAt < now) return { key: 'past', label: 'Selesai', cls: 'pushed' };
    return { key: 'active', label: 'Berlangsung', cls: 'maintenance' };
}

export async function render(root, ctx) {
    const { state } = ctx;
    const rows = state.maintenances || [];
    const pages = state.statusPages || [];

    root.innerHTML = `
        <div class="page-head">
            <div class="grow">
                <h1 class="page-title">Pemeliharaan</h1>
                <div class="page-sub">Jadwalkan jendela pemeliharaan agar notifikasi tidak berbunyi saat sistem memang sedang dirawat.</div>
            </div>
            <div class="head-actions">
                <button class="btn primary" data-action="add">${icon('plus', 15)}<span>Jadwal baru</span></button>
            </div>
        </div>
        ${
            rows.length
                ? `<div class="list-grid ledger-list">${rows.map((maintenance) => rowHtml(maintenance, state)).join('')}</div>`
                : `<div class="empty">
                    <div class="empty-icon">${icon('wrench', 20)}</div>
                    <h3>Belum ada jadwal pemeliharaan</h3>
                    <p>Buat jendela pemeliharaan agar gangguan yang direncanakan tercatat rapi dan tidak memicu alarm.</p>
                    <button class="btn primary" data-action="add">${icon('plus', 15)} Buat jadwal</button>
                </div>`
        }
        ${
            pages.length
                ? `<p class="page-note mt-16">Jendela pemeliharaan yang tertaut ke status page akan tampil pada halaman publik.</p>`
                : ''
        }
    `;

    root.querySelectorAll('[data-action="add"]').forEach((button) =>
        button.addEventListener('click', () => openForm(null, ctx))
    );

    root.querySelectorAll('[data-edit]').forEach((button) =>
        button.addEventListener('click', () => {
            const item = rows.find((row) => row.id === Number(button.dataset.edit));
            if (item) openForm(item, ctx);
        })
    );

    root.querySelectorAll('[data-delete]').forEach((button) =>
        button.addEventListener('click', async () => {
            const item = rows.find((row) => row.id === Number(button.dataset.delete));
            if (!item) return;
            const ok = await confirmDialog({
                title: 'Hapus jadwal',
                message: `Jadwal “${item.title}” akan dihapus permanen.`,
                confirmLabel: 'Hapus',
            });
            if (!ok) return;
            try {
                await endpoints.deleteMaintenance(item.id);
                toast('Jadwal dihapus', item.title, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );

    root.querySelectorAll('[data-toggle]').forEach((button) =>
        button.addEventListener('click', async () => {
            const item = rows.find((row) => row.id === Number(button.dataset.toggle));
            if (!item) return;
            try {
                await endpoints.updateMaintenance(item.id, { active: !item.active });
                toast(item.active ? 'Jadwal dijeda' : 'Jadwal diaktifkan', item.title, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );

    root.querySelectorAll('[data-now]').forEach((button) =>
        button.addEventListener('click', () => {
            const item = rows.find((row) => row.id === Number(button.dataset.now));
            if (item) openForm(item, ctx, true);
        })
    );
}

function rowHtml(maintenance, state) {
    const status = stateOf(maintenance);
    const monitors = (maintenance.monitorIds || [])
        .map((id) => state.monitors.find((monitor) => monitor.id === id))
        .filter(Boolean);
    const pages = (maintenance.statusPageIds || [])
        .map((id) => state.statusPages.find((page) => page.id === id))
        .filter(Boolean);
    return `<div class="row-card">
        <span class="status-dot ${status.key === 'active' ? 'maintenance' : status.key === 'upcoming' ? 'pending' : 'paused'}"></span>
        <div class="grow">
            <div class="inline" style="gap:8px">
                <h3>${escapeHtml(maintenance.title)}</h3>
                <span class="pill ${status.cls}">${status.label}</span>
                <span class="tag">${strategyLabel(maintenance.strategy)}</span>
            </div>
            <div class="meta">${fmtDate(maintenance.startAt)} → ${fmtDate(maintenance.endAt)}</div>
            <div class="meta">${monitors.length} monitor${
        pages.length ? ` · ${pages.map((page) => escapeHtml(page.title)).join(', ')}` : ''
    }</div>
        </div>
        <div class="actions">
            <button class="btn sm ghost" data-now="${maintenance.id}">Mulai sekarang</button>
            <button class="btn sm ghost" data-toggle="${maintenance.id}">${maintenance.active ? 'Jeda' : 'Aktifkan'}</button>
            <button class="btn sm ghost" data-edit="${maintenance.id}">${icon('edit', 13)} Ubah</button>
            <button class="btn sm danger" data-delete="${maintenance.id}" aria-label="Hapus">${icon('trash', 13)}</button>
        </div>
    </div>`;
}

function strategyLabel(strategy) {
    return { once: 'Sekali', daily: 'Setiap hari', weekly: 'Mingguan' }[strategy] || strategy;
}

function field(label, inner, hint = '', full = false) {
    return `<div class="field ${full ? 'full' : ''}">
        <label>${escapeHtml(label)}</label>
        ${inner}
        ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

function openForm(maintenance, ctx, startNow = false) {
    const editing = Boolean(maintenance);
    const monitors = (ctx.state.monitors || []).filter((monitor) => monitor.type !== 'group');
    const pages = ctx.state.statusPages || [];
    const now = Date.now();
    const start = startNow ? now : maintenance?.startAt || now + 60 * 60 * 1000;
    const end = startNow ? now + 60 * 60 * 1000 : maintenance?.endAt || now + 2 * 60 * 60 * 1000;
    const selectedMonitors = maintenance?.monitorIds || [];
    const selectedPages = maintenance?.statusPageIds || [];

    const modal = openModal({
        title: editing ? 'Ubah pemeliharaan' : 'Jadwal pemeliharaan',
        subtitle: 'Selama jendela aktif, monitor terkait tidak memicu notifikasi.',
        wide: true,
        body: `
            <form id="maintenance-form" autocomplete="off">
                <div class="form-grid">
                    ${field(
                        'Judul',
                        `<input class="input" name="title" required maxlength="150" value="${escapeHtml(
                            maintenance?.title || ''
                        )}" placeholder="Pemeliharaan basis data" />`,
                        '',
                        true
                    )}
                    ${field(
                        'Deskripsi',
                        `<textarea class="textarea" name="description" placeholder="Apa yang dikerjakan dan dampaknya bagi pengguna">${escapeHtml(
                            maintenance?.description || ''
                        )}</textarea>`,
                        '',
                        true
                    )}
                    ${field(
                        'Pola',
                        `<select class="select" name="strategy">
                            <option value="once" ${maintenance?.strategy !== 'daily' && maintenance?.strategy !== 'weekly' ? 'selected' : ''}>Sekali</option>
                            <option value="daily" ${maintenance?.strategy === 'daily' ? 'selected' : ''}>Setiap hari</option>
                            <option value="weekly" ${maintenance?.strategy === 'weekly' ? 'selected' : ''}>Mingguan</option>
                        </select>`,
                        'Jadwal berulang digeser otomatis ke periode berikutnya.'
                    )}
                    ${field('Zona waktu', `<input class="input" name="timezone" value="${escapeHtml(
                        maintenance?.timezone || ctx.state.settings.timezone || 'Asia/Jakarta'
                    )}" />`)}
                    ${field('Mulai', `<input class="input" name="startAt" type="datetime-local" required value="${toLocalInput(
                        start
                    )}" />`)}
                    ${field('Selesai', `<input class="input" name="endAt" type="datetime-local" required value="${toLocalInput(
                        end
                    )}" />`)}
                </div>

                <div class="divider"></div>
                <div class="inline" style="margin-bottom:8px">
                    <div class="eyebrow">Monitor yang terdampak</div>
                    <span class="spacer"></span>
                    <button type="button" class="btn sm ghost" id="all-monitors">Pilih semua</button>
                </div>
                <div class="chip-picker" id="maintenance-monitors">
                    ${
                        monitors.length
                            ? monitors
                                  .map(
                                      (monitor) => `<button type="button" class="chip ${
                                          selectedMonitors.includes(monitor.id) ? 'on' : ''
                                      }" data-monitor="${monitor.id}">${escapeHtml(monitor.name)}</button>`
                                  )
                                  .join('')
                            : '<span class="hint">Belum ada monitor.</span>'
                    }
                </div>

                <div class="divider"></div>
                <div class="eyebrow" style="margin-bottom:8px">Status page yang menampilkan</div>
                <div class="chip-picker" id="maintenance-pages">
                    ${
                        pages.length
                            ? pages
                                  .map(
                                      (page) => `<button type="button" class="chip ${
                                          selectedPages.includes(page.id) ? 'on' : ''
                                      }" data-page="${page.id}">${escapeHtml(page.title)}</button>`
                                  )
                                  .join('')
                            : '<span class="hint">Belum ada status page.</span>'
                    }
                </div>

                <div class="divider"></div>
                ${switchRow('active', 'Aktif', 'Nonaktifkan untuk menyimpan jadwal tanpa menjalankannya.', maintenance?.active ?? true)}
                <div id="maintenance-error"></div>
            </form>
        `,
        footer: `
            <button class="btn ghost" data-close>Batal</button>
            <button class="btn primary" type="submit" form="maintenance-form" id="save-maintenance">${
                editing ? 'Simpan perubahan' : 'Buat jadwal'
            }</button>
        `,
    });

    const form = modal.querySelector('#maintenance-form');
    form.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => chip.classList.toggle('on')));
    form.querySelector('#all-monitors')?.addEventListener('click', () => {
        const chips = [...form.querySelectorAll('#maintenance-monitors .chip')];
        const allOn = chips.every((chip) => chip.classList.contains('on'));
        chips.forEach((chip) => chip.classList.toggle('on', !allOn));
    });
    form.querySelector('.switch').addEventListener('click', () => form.querySelector('.switch').classList.toggle('on'));

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = form.querySelector('#maintenance-error');
        errorBox.innerHTML = '';
        const button = modal.querySelector('#save-maintenance');
        button.disabled = true;
        button.textContent = 'Menyimpan…';
        const payload = {
            title: form.title.value.trim(),
            description: form.description.value,
            strategy: form.strategy.value,
            timezone: form.timezone.value,
            startAt: new Date(form.startAt.value).getTime(),
            endAt: new Date(form.endAt.value).getTime(),
            active: form.active.classList.contains('on'),
            monitorIds: [...form.querySelectorAll('#maintenance-monitors .chip.on')].map((chip) => Number(chip.dataset.monitor)),
            statusPageIds: [...form.querySelectorAll('#maintenance-pages .chip.on')].map((chip) => Number(chip.dataset.page)),
        };
        try {
            if (editing) await endpoints.updateMaintenance(maintenance.id, payload);
            else await endpoints.maintenance(payload);
            closeModal();
            toast(editing ? 'Jadwal diperbarui' : 'Jadwal dibuat', payload.title, 'ok');
            await ctx.reload();
        } catch (error) {
            button.disabled = false;
            button.textContent = editing ? 'Simpan perubahan' : 'Buat jadwal';
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

function toLocalInput(timestamp) {
    const date = new Date(Number(timestamp));
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
        date.getMinutes()
    )}`;
}
