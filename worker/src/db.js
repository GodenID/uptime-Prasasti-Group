/**
 * Lapisan basis data di atas D1.
 *
 * D1 tidak punya transaksi interaktif, jadi penulisan majemuk memakai
 * `batch()` yang dijalankan sebagai satu unit.
 */

export const DEFAULT_SETTINGS = {
    title: 'Uptime Prasasti Websites',
    description: 'Pemantauan ketersediaan situs dan layanan, direkam satu per satu seperti prasasti.',
    timezone: 'Asia/Jakarta',
    theme: 'stone',
    retentionDays: '180',
    allowRegistration: '0',
    certificateExpiryDays: '14',
    domainExpiryDays: '30',
    heartbeatBarSize: '60',
    showPoweredBy: '1',
};

export class Db {
    constructor(env) {
        this.env = env;
    }

    prepare(sql) {
        return this.env.DB.prepare(sql);
    }

    async all(sql, params = []) {
        const { results } = await this.env.DB.prepare(sql)
            .bind(...params)
            .all();
        return results || [];
    }

    async one(sql, params = []) {
        const row = await this.env.DB.prepare(sql)
            .bind(...params)
            .first();
        return row || null;
    }

    async run(sql, params = []) {
        return this.env.DB.prepare(sql)
            .bind(...params)
            .run();
    }

    /**
     * Jalankan beberapa pernyataan sebagai satu batch (satu transaksi).
     */
    async batch(statements) {
        if (!statements.length) {
            return [];
        }
        return this.env.DB.batch(statements);
    }

    /**
     * Jalankan sekumpulan prepare sebagai batch. Setiap fungsi menerima
     * helper prepare yang mengembalikan statement D1.
     */
    async tx(fn) {
        const statements = [];
        const prepare = (sql) => {
            const statement = this.env.DB.prepare(sql);
            statements.push(statement);
            return statement;
        };
        const result = await fn(prepare);
        if (statements.length) {
            await this.env.DB.batch(statements);
        }
        return result;
    }

    async settings() {
        const result = { ...DEFAULT_SETTINGS };
        for (const row of await this.all('SELECT `key`, value FROM setting')) {
            result[row.key] = row.value;
        }
        return result;
    }

    async setting(key, fallback = null) {
        const row = await this.one('SELECT value FROM setting WHERE `key` = ?', [key]);
        return row ? row.value : fallback;
    }

    async setSetting(key, value) {
        await this.run(
            'INSERT INTO setting (`key`, value) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET value = excluded.value',
            [key, String(value)]
        );
    }

    async ensureSettings() {
        const statements = Object.entries(DEFAULT_SETTINGS).map(([key, value]) =>
            this.env.DB.prepare('INSERT OR IGNORE INTO setting (`key`, value) VALUES (?, ?)').bind(key, value)
        );
        if (statements.length) {
            await this.env.DB.batch(statements);
        }
    }
}
