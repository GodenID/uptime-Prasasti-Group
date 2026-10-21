import { api, endpoints } from '../api.js';
import {
    escapeHtml,
    icon,
    fmtDate,
    timeAgo,
    openModal,
    closeModal,
    confirmDialog,
    copyText,
    toast,
} from '../ui.js';

const TIMEZONES = [
    'Asia/Jakarta',
    'Asia/Makassar',
    'Asia/Jayapura',
    'Asia/Singapore',
    'Asia/Kuala_Lumpur',
    'Asia/Bangkok',
    'Asia/Tokyo',
    'Asia/Shanghai',
    'Asia/Kolkata',
    'Asia/Dubai',
    'Australia/Sydney',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Amsterdam',
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'America/Sao_Paulo',
    'UTC',
];

const BAR_SIZES = [20, 30, 40, 50, 60, 80, 100, 120];

export async function render(root, ctx) {
    const { state } = ctx;
    const settings = state.settings || {};
    const tags = state.tags || [];
    const stats = state.stats || {};
    const apiKeys = state.apiKeys || [];

    root.innerHTML = `
        <div class="page-head">
            <div class="grow">
                <h1 class="page-title">Pengaturan</h1>
                <div class="page-sub">Identitas instance, ambang peringatan, tag, keamanan akun, dan pemindahan data.</div>
            </div>
            <div class="head-actions">
                <span class="page-note">Disimpan otomatis per panel</span>
            </div>
        </div>

        <div class="settings-cols">
            <div class="list-grid">
                <div class="panel">
                    <div class="panel-head">
                        <h3>Identitas instance</h3>
                        <span class="spacer"></span>
                        <span class="page-note">Tampil di judul tab dan status page</span>
                    </div>
                    <div class="panel-body">
                        <form id="general-form" autocomplete="off">
                            <div class="form-grid">
                                ${field(
                                    'Judul',
                                    `<input class="input" name="title" maxlength="120" value="${escapeHtml(
                                        settings.title || ''
                                    )}" required />`,
                                    '',
                                    true
                                )}
                                ${field(
                                    'Deskripsi',
                                    `<textarea class="textarea" name="description" placeholder="Ringkasan singkat instance ini">${escapeHtml(
                                        settings.description || ''
                                    )}</textarea>`,
                                    '',
                                    true
                                )}
                                ${field(
                                    'Zona waktu',
                                    `<select class="select" name="timezone">${TIMEZONES.map(
                                        (zone) =>
                                            `<option value="${zone}" ${
                                                settings.timezone === zone ? 'selected' : ''
                                            }>${zone}</option>`
                                    ).join('')}${
                                        TIMEZONES.includes(settings.timezone)
                                            ? ''
                                            : `<option value="${escapeHtml(
                                                  settings.timezone || ''
                                              )}" selected>${escapeHtml(settings.timezone || '')}</option>`
                                    }</select>`,
                                    'Dipakai untuk menampilkan waktu di seluruh antarmuka.'
                                )}
                                ${field(
                                    'Lebar riwayat',
                                    `<select class="select" name="heartbeatBarSize">${BAR_SIZES.map(
                                        (size) =>
                                            `<option value="${size}" ${
                                                Number(settings.heartbeatBarSize) === size ? 'selected' : ''
                                            }>${size} denyut</option>`
                                    ).join('')}</select>`,
                                    'Jumlah batang denyut yang ditampilkan pada kartu monitor.'
                                )}
                            </div>
                            <div class="divider"></div>
                            ${switchRow(
                                'showPoweredBy',
                                'Tampilkan kredit Prasasti',
                                'Footer kecil pada status page publik.',
                                isOn(settings.showPoweredBy)
                            )}
                            <div class="inline mt-16">
                                <button class="btn primary" type="submit">${icon('check', 14)} Simpan identitas</button>
                            </div>
                        </form>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h3>Ambang &amp; retensi</h3>
                    </div>
                    <div class="panel-body">
                        <form id="threshold-form" autocomplete="off">
                            <div class="form-grid">
                                ${field(
                                    'Simpan riwayat (hari)',
                                    `<input class="input" name="retentionDays" type="number" min="1" max="3650" value="${escapeHtml(
                                        settings.retentionDays || '180'
                                    )}" />`,
                                    'Denyut yang lebih lama dari batas ini dibersihkan otomatis.'
                                )}
                                ${field(
                                    'Peringatan sertifikat (hari)',
                                    `<input class="input" name="certificateExpiryDays" type="number" min="1" max="365" value="${escapeHtml(
                                        settings.certificateExpiryDays || '14'
                                    )}" />`,
                                    'Notifikasi dikirim sebelum masa berlaku TLS berakhir.'
                                )}
                                ${field(
                                    'Peringatan domain (hari)',
                                    `<input class="input" name="domainExpiryDays" type="number" min="1" max="365" value="${escapeHtml(
                                        settings.domainExpiryDays || '30'
                                    )}" />`,
                                    'Untuk domain yang terdaftar pada monitor DNS.'
                                )}
                            </div>
                            <div class="inline mt-16">
                                <button class="btn primary" type="submit">${icon('check', 14)} Simpan ambang</button>
                            </div>
                        </form>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h3>Tag</h3>
                        <span class="spacer"></span>
                        <span class="page-note">${tags.length} tag</span>
                    </div>
                    <div class="panel-body">
                        <div class="tag-cloud" id="tag-cloud">
                            ${
                                tags.length
                                    ? tags
                                          .map(
                                              (tag) => `<div class="tag-item">
                                                  <span class="tag"><span class="dot" style="background:${escapeHtml(
                                                      tag.color || '#566780'
                                                  )}"></span>${escapeHtml(tag.name)}</span>
                                                  <button class="icon-btn" data-tag-edit="${
                                                      tag.id
                                                  }" title="Ubah tag" aria-label="Ubah tag">${icon('edit', 13)}</button>
                                                  <button class="icon-btn" data-tag-delete="${
                                                      tag.id
                                                  }" title="Hapus tag" aria-label="Hapus tag">${icon(
                                                  'trash',
                                                  13
                                              )}</button>
                                              </div>`
                                          )
                                          .join('')
                                    : '<span class="hint">Belum ada tag. Tag dipakai untuk menyaring monitor di dasbor.</span>'
                            }
                        </div>
                        <form id="tag-form" class="inline mt-16" autocomplete="off">
                            <input class="input" name="name" placeholder="Nama tag baru" maxlength="40" required style="max-width:200px" />
                            <input class="color-input" name="color" type="color" value="#566780" aria-label="Warna tag" />
                            <button class="btn sm ghost" type="submit">${icon('plus', 13)} Tambah</button>
                        </form>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h3>Keamanan</h3>
                    </div>
                    <div class="panel-body">
                        <form id="password-form" autocomplete="off">
                            <div class="form-grid">
                                ${field(
                                    'Kata sandi saat ini',
                                    '<input class="input" name="current" type="password" autocomplete="current-password" required />',
                                    '',
                                    true
                                )}
                                ${field(
                                    'Kata sandi baru',
                                    '<input class="input" name="next" type="password" autocomplete="new-password" minlength="8" required />',
                                    'Minimal 8 karakter.'
                                )}
                                ${field(
                                    'Ulangi kata sandi baru',
                                    '<input class="input" name="confirm" type="password" autocomplete="new-password" minlength="8" required />'
                                )}
                            </div>
                            <p class="page-note">Mengganti kata sandi mengakhiri semua sesi lain yang masih aktif.</p>
                            <div class="inline mt-8">
                                <button class="btn primary" type="submit">${icon('lock', 14)} Ganti kata sandi</button>
                            </div>
                        </form>

                        <div class="divider"></div>

                        <div class="eyebrow mb-8">Tambah pengguna</div>
                        <form id="user-form" class="form-grid" autocomplete="off">
                            ${field(
                                'Username',
                                '<input class="input" name="username" minlength="3" maxlength="40" placeholder="operator" required />'
                            )}
                            ${field(
                                'Kata sandi',
                                '<input class="input" name="password" type="password" minlength="8" autocomplete="new-password" required />'
                            )}
                            <div class="field full">
                                <button class="btn ghost" type="submit">${icon('plus', 13)} Buat pengguna</button>
                            </div>
                        </form>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h3>Kunci API</h3>
                        <span class="spacer"></span>
                        <span class="page-note">Akses programatis tanpa sesi</span>
                    </div>
                    <div class="panel-body">
                        <p class="muted" style="margin-top:0;font-size:12.5px;line-height:1.6">
                            Kunci dipakai lewat header <code>Authorization: Bearer &lt;token&gt;</code> pada endpoint admin.
                            Token hanya ditampilkan sekali, saat kunci dibuat.
                        </p>
                        <div id="api-key-list">
                            ${
                                apiKeys.length
                                    ? apiKeys.map(apiKeyRow).join('')
                                    : '<p class="page-note">Belum ada kunci API.</p>'
                            }
                        </div>
                        <div class="divider"></div>
                        <div class="eyebrow mb-8">Buat kunci baru</div>
                        <form id="api-key-form" class="form-grid" autocomplete="off">
                            ${field(
                                'Nama',
                                '<input class="input" name="name" maxlength="80" placeholder="CI pipeline" required />'
                            )}
                            ${field(
                                'Cakupan',
                                `<select class="select" name="scope">
                                    <option value="read">Baca saja</option>
                                    <option value="write">Baca dan tulis</option>
                                </select>`
                            )}
                            ${field(
                                'Masa berlaku (hari)',
                                '<input class="input" name="expiresInDays" type="number" min="0" max="3650" value="0" />',
                                '0 berarti tidak pernah kedaluwarsa.'
                            )}
                            <div class="field full">
                                <button class="btn ghost" type="submit">${icon('plus', 13)} Buat kunci</button>
                            </div>
                        </form>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head">
                        <h3>Data</h3>
                    </div>
                    <div class="panel-body">
                        <p class="muted" style="margin-top:0;font-size:12.5px;line-height:1.6">
                            Ekspor seluruh konfigurasi ke berkas JSON: monitor, tag, notifikasi, status page, dan jadwal
                            pemeliharaan. Riwayat denyut tidak disertakan.
                        </p>
                        <div class="inline">
                            <button class="btn ghost" id="export-button">${icon('download', 14)} Ekspor JSON</button>
                            <button class="btn ghost" id="import-button">${icon('upload', 14)} Impor JSON</button>
                            <input type="file" id="import-file" accept="application/json,.json" hidden />
                        </div>
                        <div id="data-status" class="mt-16"></div>
                    </div>
                </div>
            </div>

            <div class="list-grid">
                <div class="panel">
                    <div class="panel-head"><h3>Tentang</h3></div>
                    <div class="panel-body">
                        <div class="about-mark">${icon('stele', 22)}</div>
                        <div class="about-name">Uptime Prasasti Websites</div>
                        <div class="about-sub">Pemantauan uptime milik sendiri, direkam seperti prasasti.</div>
                        <div class="kv"><span class="k">Versi</span><span class="v mono">${escapeHtml(
                            state.version || '1.0.0'
                        )}</span></div>
                        <div class="kv"><span class="k">Monitor</span><span class="v mono">${stats.total || 0}</span></div>
                        <div class="kv"><span class="k">Denyut tersimpan</span><span class="v mono">${Number(
                            stats.storedBeats || 0
                        ).toLocaleString('id-ID')}</span></div>
                        <div class="kv"><span class="k">Status page</span><span class="v mono">${
                            state.statusPages.length
                        }</span></div>
                        <div class="kv"><span class="k">Waktu server</span><span class="v mono">${fmtDate(
                            Date.now()
                        )}</span></div>
                        <div class="kv"><span class="k">Login sebagai</span><span class="v">${escapeHtml(
                            state.user?.username || ''
                        )}</span></div>
                        <p class="page-note mt-8">Berjalan lokal dengan SQLite dan Node.js, tanpa layanan pihak ketiga.</p>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head"><h3>Pintasan</h3></div>
                    <div class="panel-body" style="padding:8px">
                        <button class="shortcut" data-go="#/">
                            <span>${icon('dashboard', 16)}</span>
                            <div><b>Dasbor</b><span>Semua monitor dan denyut terbaru</span></div>
                        </button>
                        <button class="shortcut" data-go="#/status-pages">
                            <span>${icon('layout', 16)}</span>
                            <div><b>Status page</b><span>Halaman publik untuk pengguna</span></div>
                        </button>
                        <button class="shortcut" data-go="#/notifications">
                            <span>${icon('bell', 16)}</span>
                            <div><b>Notifikasi</b><span>Kanal dan riwayat pengiriman</span></div>
                        </button>
                        <button class="shortcut" data-go="#/maintenance">
                            <span>${icon('wrench', 16)}</span>
                            <div><b>Pemeliharaan</b><span>Jendela perawatan terjadwal</span></div>
                        </button>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-head"><h3>Perawatan basis data</h3></div>
                    <div class="panel-body">
                        <p class="muted" style="margin-top:0;font-size:12.5px;line-height:1.6">
                            Riwayat lebih tua dari ambang retensi dibersihkan oleh mesin pemantauan setiap siklus.
                            Ekspor berkala tetap disarankan sebelum perubahan besar.
                        </p>
                        <div class="kv"><span class="k">Retensi aktif</span><span class="v mono">${escapeHtml(
                            settings.retentionDays || '180'
                        )} hari</span></div>
                        <div class="kv"><span class="k">Terakhir diperiksa</span><span class="v">${
                            stats.lastBeat ? timeAgo(stats.lastBeat) : '—'
                        }</span></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    bindInteractions(root, ctx);
}

function bindInteractions(root, ctx) {
    const general = root.querySelector('#general-form');
    general.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = general.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const next = {
                title: general.title.value.trim(),
                description: general.description.value,
                timezone: general.timezone.value,
                heartbeatBarSize: Number(general.heartbeatBarSize.value),
                showPoweredBy: general.showPoweredBy.classList.contains('on') ? '1' : '0',
            };
            const data = await endpoints.settings(next);
            ctx.state.settings = data.settings;
            document.title = `${data.settings.title || 'Uptime Prasasti'} · Prasasti`;
            toast('Identitas disimpan', next.title, 'ok');
            await ctx.reload();
        } catch (error) {
            ctx.notifyError(error);
            button.disabled = false;
        }
    });

    const threshold = root.querySelector('#threshold-form');
    threshold.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = threshold.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const data = await endpoints.settings({
                retentionDays: Number(threshold.retentionDays.value),
                certificateExpiryDays: Number(threshold.certificateExpiryDays.value),
                domainExpiryDays: Number(threshold.domainExpiryDays.value),
            });
            ctx.state.settings = data.settings;
            toast('Ambang disimpan', 'Retensi dan peringatan diperbarui', 'ok');
            button.disabled = false;
        } catch (error) {
            ctx.notifyError(error);
            button.disabled = false;
        }
    });

    root.querySelectorAll('.switch').forEach((button) =>
        button.addEventListener('click', () => {
            button.classList.toggle('on');
            button.setAttribute('aria-pressed', button.classList.contains('on') ? 'true' : 'false');
        })
    );

    root.querySelectorAll('[data-go]').forEach((button) =>
        button.addEventListener('click', () => ctx.navigate(button.dataset.go))
    );

    const tagForm = root.querySelector('#tag-form');
    tagForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = tagForm.name.value.trim();
        if (!name) return;
        try {
            await endpoints.tag({ name, color: tagForm.color.value });
            toast('Tag ditambahkan', name, 'ok');
            await ctx.reload();
        } catch (error) {
            ctx.notifyError(error);
        }
    });

    root.querySelectorAll('[data-tag-edit]').forEach((button) =>
        button.addEventListener('click', () => {
            const tag = ctx.state.tags.find((item) => item.id === Number(button.dataset.tagEdit));
            if (tag) openTagForm(tag, ctx);
        })
    );

    root.querySelectorAll('[data-tag-delete]').forEach((button) =>
        button.addEventListener('click', async () => {
            const tag = ctx.state.tags.find((item) => item.id === Number(button.dataset.tagDelete));
            if (!tag) return;
            const ok = await confirmDialog({
                title: 'Hapus tag',
                message: `Tag “${tag.name}” akan dilepas dari semua monitor.`,
                confirmLabel: 'Hapus tag',
            });
            if (!ok) return;
            try {
                await endpoints.deleteTag(tag.id);
                toast('Tag dihapus', tag.name, 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );

    const passwordForm = root.querySelector('#password-form');
    passwordForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (passwordForm.next.value !== passwordForm.confirm.value) {
            toast('Kata sandi tidak sama', 'Konfirmasi ulangi kata sandi baru tidak cocok', 'err');
            return;
        }
        const button = passwordForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            await endpoints.password(passwordForm.current.value, passwordForm.next.value);
            passwordForm.reset();
            toast('Kata sandi diganti', 'Sesi lain telah diakhiri', 'ok');
        } catch (error) {
            ctx.notifyError(error);
        }
        button.disabled = false;
    });

    const userForm = root.querySelector('#user-form');
    userForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = userForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            await endpoints.createUser(userForm.username.value.trim(), userForm.password.value);
            toast('Pengguna dibuat', userForm.username.value.trim(), 'ok');
            userForm.reset();
        } catch (error) {
            ctx.notifyError(error);
        }
        button.disabled = false;
    });

    const apiKeyForm = root.querySelector('#api-key-form');
    apiKeyForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = apiKeyForm.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const data = await endpoints.createApiKey({
                name: apiKeyForm.name.value.trim(),
                scope: apiKeyForm.scope.value,
                expiresInDays: Number(apiKeyForm.expiresInDays.value || 0),
            });
            apiKeyForm.reset();
            showApiKeyToken(data.token);
            await ctx.reload();
        } catch (error) {
            ctx.notifyError(error);
        }
        button.disabled = false;
    });

    root.querySelectorAll('[data-revoke-key]').forEach((button) =>
        button.addEventListener('click', async () => {
            const id = Number(button.dataset.revokeKey);
            const ok = await confirmDialog({
                title: 'Cabut kunci API',
                message: 'Pengguna yang memakai kunci ini langsung kehilangan akses. Tindakan ini tidak bisa dibatalkan.',
                confirmLabel: 'Cabut kunci',
            });
            if (!ok) return;
            try {
                await endpoints.deleteApiKey(id);
                toast('Kunci dicabut', '', 'ok');
                await ctx.reload();
            } catch (error) {
                ctx.notifyError(error);
            }
        })
    );

    const status = root.querySelector('#data-status');
    const fileInput = root.querySelector('#import-file');

    root.querySelector('#export-button').addEventListener('click', async () => {
        const button = root.querySelector('#export-button');
        button.disabled = true;
        try {
            const data = await endpoints.exportData();
            const stamp = new Date().toISOString().slice(0, 10);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `prasasti-${stamp}.json`;
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            status.innerHTML = `<div class="alert ok">Ekspor dibuat: ${escapeHtml(
                link.download
            )} · ${data.monitors.length} monitor, ${data.statusPages.length} status page.</div>`;
        } catch (error) {
            status.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`;
        }
        button.disabled = false;
    });

    root.querySelector('#import-button').addEventListener('click', () => {
        status.innerHTML = '';
        fileInput.click();
    });

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        let payload;
        try {
            const text = await file.text();
            payload = JSON.parse(text);
        } catch {
            status.innerHTML = '<div class="alert">Berkas bukan JSON yang valid.</div>';
            return;
        }
        if (!payload || !Array.isArray(payload.monitors)) {
            status.innerHTML = '<div class="alert">Struktur berkas tidak dikenali: kunci “monitors” tidak ditemukan.</div>';
            return;
        }
        const ok = await confirmDialog({
            title: 'Impor data',
            message: `Berkas berisi ${payload.monitors.length} monitor. Data akan ditambahkan ke instance ini, bukan menggantikan yang sudah ada.`,
            confirmLabel: 'Impor sekarang',
            danger: false,
        });
        if (!ok) return;
        try {
            const result = await endpoints.importData(payload);
            const imported = result.imported || {};
            status.innerHTML = `<div class="alert ok">Impor selesai: ${imported.monitors || 0} monitor, ${
                imported.notifications || 0
            } notifikasi, ${imported.statusPages || 0} status page.</div>`;
            toast('Impor selesai', `${imported.monitors || 0} monitor ditambahkan`, 'ok');
            await ctx.reload();
        } catch (error) {
            status.innerHTML = `<div class="alert">${escapeHtml(error.message)}</div>`;
        }
    });
}

function openTagForm(tag, ctx) {
    const modal = openModal({
        title: 'Ubah tag',
        subtitle: 'Nama dan warna dipakai pada dasbor serta detail monitor.',
        body: `
            <form id="tag-edit-form" autocomplete="off">
                <div class="form-grid">
                    ${field(
                        'Nama',
                        `<input class="input" name="name" maxlength="40" required value="${escapeHtml(tag.name)}" />`
                    )}
                    ${field(
                        'Warna',
                        `<input class="color-input block" name="color" type="color" value="${escapeHtml(
                            tag.color || '#566780'
                        )}" style="width:100%;height:38px" />`
                    )}
                </div>
                <div id="tag-error"></div>
            </form>
        `,
        footer: `<button class="btn ghost" data-close>Batal</button>
                 <button class="btn primary" type="submit" form="tag-edit-form" id="save-tag">Simpan</button>`,
    });

    const form = modal.querySelector('#tag-edit-form');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = modal.querySelector('#save-tag');
        button.disabled = true;
        try {
            await endpoints.updateTag(tag.id, { name: form.name.value.trim(), color: form.color.value });
            closeModal();
            toast('Tag diperbarui', form.name.value.trim(), 'ok');
            await ctx.reload();
        } catch (error) {
            button.disabled = false;
            form.querySelector('#tag-error').innerHTML = `<div class="alert" style="margin-top:12px">${escapeHtml(
                error.message
            )}</div>`;
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

function apiKeyRow(key) {
    const expired = key.expires_at && Number(key.expires_at) < Date.now();
    return `<div class="kv" data-api-key="${key.id}">
        <span class="k">${escapeHtml(key.name)}<span class="tiny muted mono"> ${escapeHtml(key.prefix)}…</span></span>
        <span class="v">
            ${key.scope === 'write' ? 'baca + tulis' : 'baca saja'}
            ${expired ? '<span class="tiny muted"> · kedaluwarsa</span>' : ''}
            <span class="tiny muted"> · dibuat ${fmtDate(key.created_at, false)}</span>
            <span class="tiny muted"> · dipakai ${key.last_used_at ? timeAgo(key.last_used_at) : 'belum'}</span>
            <button class="btn sm ghost" data-revoke-key="${key.id}">Cabut</button>
        </span>
    </div>`;
}

function showApiKeyToken(token) {
    openModal({
        title: 'Kunci API dibuat',
        subtitle: 'Token hanya ditampilkan sekali. Simpan di tempat aman.',
        body: `<div class="code" id="api-token">${escapeHtml(token)}</div>
            <p class="page-note">Pakai header <code>Authorization: Bearer ${escapeHtml(
                token
            )}</code> pada endpoint admin.</p>`,
        footer: `<button class="btn ghost" data-close>Tutup</button>
            <button class="btn primary" id="copy-token">Salin token</button>`,
        onMount(node) {
            node.querySelector('#copy-token').addEventListener('click', async () => {
                await copyText(token);
                toast('Token disalin', '', 'ok');
            });
        },
    });
}

function switchRow(name, title, description, on) {
    return `<div class="switch-row">
        <button type="button" class="switch ${on ? 'on' : ''}" name="${name}" aria-pressed="${on ? 'true' : 'false'}"></button>
        <div class="switch-text"><b>${escapeHtml(title)}</b><span>${escapeHtml(description)}</span></div>
    </div>`;
}

function isOn(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
}
