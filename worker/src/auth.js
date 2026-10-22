/**
 * Autentikasi untuk Worker: scrypt, sesi di D1, kunci API, pembatasan login.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now, randomToken, safeEqual } from './util.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'prasasti_sid';
export const SESSION_TTL = 1000 * 60 * 60 * 12;
export const REMEMBER_TTL = 1000 * 60 * 60 * 24 * 30;

const API_KEY_PREFIX = 'pk_';
const API_KEY_SCOPES = new Set(['read', 'write']);

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(String(password), salt, 64);
    return `scrypt:${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
        return false;
    }
    const [, salt, digest] = parts;
    const derived = await scrypt(String(password), salt, 64);
    return safeEqual(derived.toString('hex'), digest);
}

export function parseCookies(header) {
    const result = {};
    if (!header) {
        return result;
    }
    for (const chunk of String(header).split(';')) {
        const index = chunk.indexOf('=');
        if (index === -1) {
            continue;
        }
        const key = chunk.slice(0, index).trim();
        const value = chunk.slice(index + 1).trim();
        if (key) {
            try {
                result[key] = decodeURIComponent(value);
            } catch {
                result[key] = value;
            }
        }
    }
    return result;
}

export async function createSession(db, userId, { remember = false, ip = '', userAgent = '' } = {}) {
    const token = randomToken(32);
    const created = now();
    const expires = created + (remember ? REMEMBER_TTL : SESSION_TTL);
    await db.run(
        'INSERT INTO session (token, user_id, created_at, expires_at, remember, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [token, userId, created, expires, remember ? 1 : 0, String(userAgent).slice(0, 250), String(ip).slice(0, 64)]
    );
    return { token, expires };
}

export async function getSessionUser(db, token) {
    if (!token) {
        return null;
    }
    const session = await db.one('SELECT * FROM session WHERE token = ?', [token]);
    if (!session) {
        return null;
    }
    if (session.expires_at < now()) {
        await db.run('DELETE FROM session WHERE token = ?', [token]);
        return null;
    }
    const user = await db.one('SELECT id, username, active, created_at FROM user WHERE id = ?', [session.user_id]);
    if (!user || !user.active) {
        return null;
    }
    return user;
}

export async function destroySession(db, token) {
    if (token) {
        await db.run('DELETE FROM session WHERE token = ?', [token]);
    }
}

export async function destroyOtherSessions(db, userId, keepToken) {
    await db.run('DELETE FROM session WHERE user_id = ? AND token != ?', [userId, keepToken || '']);
}

export async function cleanupSessions(db) {
    await db.run('DELETE FROM session WHERE expires_at < ?', [now()]);
}

export function sessionCookie(token, expires) {
    const maxAge = Math.max(0, Math.floor((expires - now()) / 1000));
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function countUsers(db) {
    const row = await db.one('SELECT COUNT(*) AS total FROM user');
    return row ? Number(row.total) : 0;
}

export async function getUserByName(db, username) {
    return db.one('SELECT * FROM user WHERE username = ? COLLATE NOCASE', [username]);
}

export async function listUsers(db) {
    return db.all('SELECT id, username, active, created_at FROM user ORDER BY id');
}

// ---------- kunci API ----------

function hashApiToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export async function createApiKey(db, userId, { name, scope = 'read', expiresInDays = 0 } = {}) {
    const cleanName = String(name || '').trim().slice(0, 80) || 'Kunci API';
    const cleanScope = API_KEY_SCOPES.has(scope) ? scope : 'read';
    const token = `${API_KEY_PREFIX}${randomToken(24)}`;
    const timestamp = now();
    const days = Number(expiresInDays) || 0;
    const expiresAt = days > 0 ? timestamp + days * 86400000 : null;
    const info = await db.run(
        'INSERT INTO api_key (name, token_hash, prefix, scope, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [cleanName, hashApiToken(token), token.slice(0, 11), cleanScope, userId, timestamp, expiresAt]
    );
    return {
        id: Number(info.meta.last_row_id),
        name: cleanName,
        scope: cleanScope,
        prefix: token.slice(0, 11),
        token,
        createdAt: timestamp,
        expiresAt,
    };
}

export async function findApiKey(db, token) {
    if (!token) {
        return null;
    }
    const row = await db.one('SELECT * FROM api_key WHERE token_hash = ?', [hashApiToken(token)]);
    if (!row) {
        return null;
    }
    if (row.expires_at && Number(row.expires_at) < now()) {
        return null;
    }
    return row;
}

export async function touchApiKey(db, id) {
    await db.run('UPDATE api_key SET last_used_at = ? WHERE id = ?', [now(), id]);
}

export async function listApiKeys(db, userId) {
    return db.all(
        'SELECT id, name, prefix, scope, created_at, last_used_at, expires_at FROM api_key WHERE user_id = ? ORDER BY id',
        [userId]
    );
}

export async function revokeApiKey(db, id, userId) {
    await db.run('DELETE FROM api_key WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---------- pembatasan login ----------

const attempts = new Map();

function throttleKey(ip, username) {
    return `${ip}|${String(username || '').toLowerCase()}`;
}

export function isThrottled(ip, username) {
    const entry = attempts.get(throttleKey(ip, username));
    if (!entry) {
        return false;
    }
    if (entry.resetAt < now()) {
        attempts.delete(throttleKey(ip, username));
        return false;
    }
    return entry.count >= 8;
}

export function recordFailure(ip, username) {
    const key = throttleKey(ip, username);
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now()) {
        attempts.set(key, { count: 1, resetAt: now() + 10 * 60 * 1000 });
        return;
    }
    entry.count += 1;
}

export function clearFailures(ip, username) {
    attempts.delete(throttleKey(ip, username));
}
