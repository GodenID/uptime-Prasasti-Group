/**
 * Kamus bahasa untuk status page publik.
 *
 * Status page dapat memakai bahasa 'id', 'en', atau 'auto' (mengikuti
 * preferensi peramban). Dasbor admin tetap memakai bahasa Indonesia.
 */

const DICTIONARIES = {
    id: {
        skipToContent: 'Lewati ke konten',
        loading: 'Memuat status layanan…',
        notFoundTitle: 'Halaman tidak ditemukan',
        notFoundText:
            'Status page ini belum diterbitkan atau sudah dihapus. Hubungi penyedia layanan untuk tautan yang benar.',
        openPrasasti: 'Buka Prasasti',
        cannotLoad: 'Tidak dapat memuat status',
        retry: 'Coba lagi',
        netNote: 'Koneksi langsung terputus. Halaman menyegarkan diri setiap menit.',
        overallAllUp: 'Semua sistem beroperasi',
        overallDown: 'Gangguan layanan terdeteksi',
        overallPending: 'Menunggu pemeriksaan pertama',
        overallMaintenance: 'Pemeliharaan terjadwal',
        overallUnknown: 'Status tidak diketahui',
        subDown: '{down} dari {total} layanan sedang terganggu.',
        subMaintenance: 'Sebagian layanan sedang dalam pemeliharaan terjadwal.',
        subPending: 'Pemeriksaan pertama belum selesai untuk sebagian layanan.',
        subDefault: '{total} layanan dipantau secara berkala.',
        liveTitleOn: 'Pembaruan langsung aktif',
        liveTitleOff: 'Menyegarkan berkala',
        liveOn: 'Pembaruan langsung',
        liveOff: 'Diperbarui berkala',
        uptime24: 'uptime 24 jam',
        services: 'layanan',
        updated: 'pembaruan',
        updatedFooter: 'Diperbarui',
        poweredBy: 'Didukung',
        announcementTitle: 'Pengumuman',
        maintenanceTitle: 'Pemeliharaan',
        noticeActive: 'Sedang berlangsung · selesai',
        noticeScheduled: 'Dijadwalkan · mulai',
        incidentsTitle: 'Insiden aktif',
        pinned: 'Disematkan',
        started: 'Mulai',
        finished: 'selesai',
        ongoing: 'masih berlangsung',
        servicesTitle: 'Layanan',
        noServices: 'Belum ada layanan yang ditampilkan pada halaman ini.',
        response: 'respons',
        last24: '24 jam',
        last30: '30 hari',
        historyTitle: 'Riwayat insiden',
        feedLink: 'Feed RSS',
        justNow: 'baru saja',
        secAgo: '{n} dtk lalu',
        minAgo: '{n} mnt lalu',
        hourAgo: '{n} jam lalu',
        dayAgo: '{n} hari lalu',
        types: {
            http: 'HTTP(s)',
            keyword: 'Kata kunci',
            json: 'JSON query',
            tcp: 'Port TCP',
            ping: 'Ping',
            dns: 'DNS',
            push: 'Push',
            group: 'Grup',
            redis: 'Redis',
            mqtt: 'MQTT',
            docker: 'Docker',
            postgres: 'PostgreSQL',
        },
        statusLabels: {
            down: 'Gangguan',
            up: 'Operasional',
            pending: 'Menunggu',
            maintenance: 'Pemeliharaan',
        },
    },
    en: {
        skipToContent: 'Skip to content',
        loading: 'Loading service status…',
        notFoundTitle: 'Page not found',
        notFoundText:
            'This status page is not published or has been removed. Contact the service provider for the right link.',
        openPrasasti: 'Open Prasasti',
        cannotLoad: 'Cannot load status',
        retry: 'Try again',
        netNote: 'Live connection lost. The page refreshes itself every minute.',
        overallAllUp: 'All systems operational',
        overallDown: 'Service disruption detected',
        overallPending: 'Waiting for the first check',
        overallMaintenance: 'Scheduled maintenance',
        overallUnknown: 'Status unknown',
        subDown: '{down} of {total} services are disrupted.',
        subMaintenance: 'Some services are under scheduled maintenance.',
        subPending: 'The first check has not finished for some services.',
        subDefault: '{total} services are monitored regularly.',
        liveTitleOn: 'Live updates enabled',
        liveTitleOff: 'Refreshing periodically',
        liveOn: 'Live updates',
        liveOff: 'Updated periodically',
        uptime24: '24h uptime',
        services: 'services',
        updated: 'updated',
        updatedFooter: 'Updated',
        poweredBy: 'Powered by',
        announcementTitle: 'Announcement',
        maintenanceTitle: 'Maintenance',
        noticeActive: 'In progress · ends',
        noticeScheduled: 'Scheduled · starts',
        incidentsTitle: 'Active incidents',
        pinned: 'Pinned',
        started: 'Started',
        finished: 'resolved',
        ongoing: 'ongoing',
        servicesTitle: 'Services',
        noServices: 'No services are listed on this page yet.',
        response: 'response',
        last24: '24h',
        last30: '30d',
        historyTitle: 'Incident history',
        feedLink: 'RSS feed',
        justNow: 'just now',
        secAgo: '{n}s ago',
        minAgo: '{n}m ago',
        hourAgo: '{n}h ago',
        dayAgo: '{n}d ago',
        types: {
            http: 'HTTP(s)',
            keyword: 'Keyword',
            json: 'JSON query',
            tcp: 'TCP port',
            ping: 'Ping',
            dns: 'DNS',
            push: 'Push',
            group: 'Group',
            redis: 'Redis',
            mqtt: 'MQTT',
            docker: 'Docker',
            postgres: 'PostgreSQL',
        },
        statusLabels: {
            down: 'Down',
            up: 'Operational',
            pending: 'Pending',
            maintenance: 'Maintenance',
        },
    },
};

let current = 'id';

export function setLang(lang) {
    current = DICTIONARIES[lang] ? lang : 'id';
    document.documentElement.lang = current === 'en' ? 'en' : 'id-ID';
    return current;
}

export function currentLang() {
    return current;
}

export function currentLocale() {
    return current === 'en' ? 'en-GB' : 'id-ID';
}

/**
 * Terjemahkan kunci. Parameter ditulis dengan {nama} dan diisi dari params.
 */
export function t(key, params = {}) {
    const table = DICTIONARIES[current] || DICTIONARIES.id;
    const fallback = DICTIONARIES.id[key];
    let value = table[key] ?? fallback ?? key;
    if (typeof value !== 'string') {
        return value;
    }
    for (const [name, replacement] of Object.entries(params)) {
        value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
}

export function typeLabel(type) {
    const table = DICTIONARIES[current] || DICTIONARIES.id;
    return table.types?.[type] || DICTIONARIES.id.types?.[type] || type;
}

const STATUS_KEYS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

export function statusText(status) {
    const table = DICTIONARIES[current] || DICTIONARIES.id;
    const key = STATUS_KEYS[status] || 'unknown';
    return table.statusLabels?.[key] || DICTIONARIES.id.statusLabels?.[key] || key;
}
