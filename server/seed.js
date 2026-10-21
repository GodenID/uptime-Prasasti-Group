'use strict';

/**
 * Mengisi basis data dengan contoh konfigurasi yang siap dipakai.
 *
 *   npm run seed
 *
 * Skrip ini idempoten: monitor, tag, dan status page dicek berdasarkan nama/slug
 * sehingga menjalankannya dua kali tidak menggandakan data.
 */

const crypto = require('node:crypto');
const { get, run, transaction, getSettings } = require('./db');
const { hashPassword, countUsers } = require('./auth');
const { now } = require('./util');

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'prasasti2026';

const TAGS = [
    { name: 'Produksi', color: '#46c392' },
    { name: 'Jaringan', color: '#c9894a' },
    { name: 'Internal', color: '#8a7a5c' },
];

const MONITORS = [
    {
        name: 'Prasasti Docs',
        type: 'http',
        url: 'https://example.com',
        interval: 300,
        retries: 2,
        retryInterval: 60,
        timeout: 15,
        description: 'Halaman contoh yang dipantau lewat HTTP.',
        tags: ['Produksi'],
    },
    {
        name: 'Cloudflare DNS',
        type: 'dns',
        hostname: 'one.one.one.one',
        dnsRecordType: 'A',
        dnsResolver: '1.1.1.1',
        expectedValue: '1.1.1.1',
        interval: 300,
        timeout: 10,
        description: 'Resolusi DNS publik melalui 1.1.1.1.',
        tags: ['Jaringan'],
    },
    {
        name: 'Google DNS TCP',
        type: 'tcp',
        hostname: '8.8.8.8',
        port: 53,
        interval: 300,
        timeout: 10,
        description: 'Ketersediaan port TCP 53 pada resolver publik.',
        tags: ['Jaringan'],
    },
    {
        name: 'Jaringan Publik',
        type: 'ping',
        hostname: '8.8.8.8',
        interval: 300,
        timeout: 10,
        description: 'ICMP ping ke 8.8.8.8.',
        tags: ['Jaringan'],
    },
    {
        name: 'Contoh Push',
        type: 'push',
        interval: 300,
        description: 'Monitor pasif; kirim denyut dari cron atau skrip Anda.',
        tags: ['Internal'],
    },
    {
        name: 'Layanan Prasasti',
        type: 'group',
        interval: 300,
        description: 'Grup untuk merangkum layanan utama.',
        tags: ['Produksi'],
    },
];

function ensureTag(name, color) {
    const existing = get('SELECT id FROM tag WHERE name = ?', [name]);
    if (existing) {
        return Number(existing.id);
    }
    const info = run('INSERT INTO tag (name, color, created_at) VALUES (?, ?, ?)', [name, color, now()]);
    return Number(info.lastInsertRowid);
}

function ensureMonitor(definition) {
    const existing = get('SELECT id FROM monitor WHERE name = ?', [definition.name]);
    if (existing) {
        return Number(existing.id);
    }
    const timestamp = now();
    const columns = [
        'name', 'type', 'url', 'hostname', 'port', 'method', 'interval', 'retries', 'retry_interval',
        'timeout', 'upside_down', 'keyword', 'json_path', 'expected_value', 'accepted_codes', 'max_redirects',
        'ignore_tls', 'cert_expiry_notification', 'domain_expiry_notification', 'dns_record_type', 'dns_resolver',
        'parent_id', 'description', 'active', 'push_token', 'created_at', 'updated_at',
    ];
    const values = [
        definition.name,
        definition.type,
        definition.url || null,
        definition.hostname || null,
        definition.port === undefined ? null : definition.port,
        'GET',
        definition.interval || 300,
        definition.retries || 0,
        definition.retryInterval || 60,
        definition.timeout || 15,
        0,
        definition.keyword || null,
        definition.jsonPath || null,
        definition.expectedValue || null,
        definition.acceptedCodes || null,
        10,
        0,
        definition.type === 'http' || definition.type === 'keyword' || definition.type === 'json' ? 1 : 0,
        definition.domainExpiryNotification ? 1 : 0,
        definition.dnsRecordType || 'A',
        definition.dnsResolver || null,
        definition.parentId || null,
        definition.description || '',
        1,
        definition.type === 'push' ? crypto.randomBytes(18).toString('hex') : null,
        timestamp,
        timestamp,
    ];
    const info = run(
        `INSERT INTO monitor (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );
    const monitorId = Number(info.lastInsertRowid);

    for (const tagName of definition.tags || []) {
        const tag = get('SELECT id FROM tag WHERE name = ?', [tagName]);
        if (tag) {
            run('INSERT OR IGNORE INTO monitor_tag (monitor_id, tag_id) VALUES (?, ?)', [monitorId, Number(tag.id)]);
        }
    }
    return monitorId;
}

function ensureStatusPage() {
    const slug = 'layanan-prasasti';
    const existing = get('SELECT id FROM status_page WHERE slug = ?', [slug]);
    if (existing) {
        return Number(existing.id);
    }
    const timestamp = now();
    const info = run(
        `INSERT INTO status_page (slug, title, description, icon, theme, published, show_tags, show_powered_by,
         footer_text, custom_css, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
            slug,
            'Layanan Prasasti',
            'Status ketersediaan layanan yang diukir satu per satu.',
            '/favicon.svg',
            'stone',
            1,
            1,
            1,
            '',
            '',
            timestamp,
        ]
    );
    return Number(info.lastInsertRowid);
}

async function main() {
    const summary = { user: null, tags: 0, monitors: 0, statusPage: null, maintenance: null };

    if (countUsers() === 0) {
        const info = run('INSERT INTO user (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)', [
            ADMIN_USER,
            await hashPassword(ADMIN_PASSWORD),
            now(),
        ]);
        summary.user = { id: Number(info.lastInsertRowid), username: ADMIN_USER, password: ADMIN_PASSWORD };
    } else {
        const user = get('SELECT id, username FROM user ORDER BY id LIMIT 1');
        summary.user = user ? { id: Number(user.id), username: user.username, password: null } : null;
    }

    transaction(() => {
        for (const tag of TAGS) {
            ensureTag(tag.name, tag.color);
            summary.tags += 1;
        }

        const groupId = ensureMonitor(MONITORS.find((monitor) => monitor.type === 'group'));
        for (const monitor of MONITORS.filter((item) => item.type !== 'group')) {
            ensureMonitor({ ...monitor, parentId: groupId });
            summary.monitors += 1;
        }
        summary.monitors += 1;

        const pageId = ensureStatusPage();
        summary.statusPage = pageId;

        const docs = get("SELECT id FROM monitor WHERE name = 'Prasasti Docs'");
        const dns = get("SELECT id FROM monitor WHERE name = 'Cloudflare DNS'");
        const tcp = get("SELECT id FROM monitor WHERE name = 'Google DNS TCP'");
        const ping = get("SELECT id FROM monitor WHERE name = 'Jaringan Publik'");

        run('DELETE FROM status_page_monitor WHERE status_page_id = ?', [pageId]);
        run('DELETE FROM status_page_group_monitor WHERE group_id IN (SELECT id FROM status_page_group WHERE status_page_id = ?)', [pageId]);
        run('DELETE FROM status_page_group WHERE status_page_id = ?', [pageId]);

        for (const monitor of [docs, dns]) {
            if (monitor) {
                run('INSERT OR IGNORE INTO status_page_monitor (status_page_id, monitor_id, weight) VALUES (?, ?, ?)', [
                    pageId,
                    Number(monitor.id),
                    0,
                ]);
            }
        }
        const groupInfo = run('INSERT INTO status_page_group (status_page_id, name, weight) VALUES (?, ?, ?)', [
            pageId,
            'Jaringan',
            0,
        ]);
        const pageGroupId = Number(groupInfo.lastInsertRowid);
        for (const monitor of [tcp, ping]) {
            if (monitor) {
                run('INSERT OR IGNORE INTO status_page_group_monitor (group_id, monitor_id) VALUES (?, ?)', [
                    pageGroupId,
                    Number(monitor.id),
                ]);
            }
        }

        const existingMaintenance = get("SELECT id FROM maintenance WHERE title = 'Pemeliharaan terjadwal'");
        if (!existingMaintenance) {
            const start = now() + 24 * 60 * 60 * 1000;
            const info = run(
                `INSERT INTO maintenance (title, description, strategy, start_at, end_at, active, created_at, updated_at)
                 VALUES (?, ?, 'once', ?, ?, 1, ?, ?)`,
                [
                    'Pemeliharaan terjadwal',
                    'Contoh jendela pemeliharaan untuk grup Jaringan.',
                    start,
                    start + 60 * 60 * 1000,
                    now(),
                    now(),
                ]
            );
            const maintenanceId = Number(info.lastInsertRowid);
            if (tcp) {
                run('INSERT OR IGNORE INTO maintenance_monitor (maintenance_id, monitor_id) VALUES (?, ?)', [
                    maintenanceId,
                    Number(tcp.id),
                ]);
            }
            run('INSERT OR IGNORE INTO maintenance_status_page (maintenance_id, status_page_id) VALUES (?, ?)', [
                maintenanceId,
                pageId,
            ]);
            summary.maintenance = maintenanceId;
        }
    });

    const settings = getSettings();
    console.log('Seed selesai.');
    console.log(
        `  Pengguna   : ${
            summary.user
                ? `${summary.user.username}${summary.user.password ? ` / ${summary.user.password}` : ' (sudah ada)'}`
                : 'tidak ada'
        }`
    );
    console.log(`  Tag        : ${summary.tags}`);
    console.log(`  Monitor    : ${summary.monitors}`);
    console.log(`  Status page: ${summary.statusPage ? '/status/layanan-prasasti' : '-'}`);
    console.log(`  Zona waktu : ${settings.timezone}`);
}

main().catch((error) => {
    console.error('Seed gagal:', error);
    process.exitCode = 1;
});
