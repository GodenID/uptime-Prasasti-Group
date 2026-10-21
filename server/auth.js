'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { get, run, all } = require('./db');
const { now, randomToken, safeEqual } = require('./util');

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = 'prasasti_sid';
const SESSION_TTL = 1000 * 60 * 60 * 12;
const REMEMBER_TTL = 1000 * 60 * 60 * 24 * 30;

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(String(password), salt, 64);
    return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
        return false;
    }
    const [, salt, digest] = parts;
    const derived = await scrypt(String(password), salt, 64);
    return safeEqual(derived.toString('hex'), digest);
}

function parseCookies(header) {
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
            result[key] = decodeURIComponent(value);
        }
    }
    return result;
}

function createSession(userId, { remember = false, ip = '', userAgent = '' } = {}) {
    const token = randomToken(32);
    const created = now();
    const expires = created + (remember ? REMEMBER_TTL : SESSION_TTL);
    run(
        'INSERT INTO session (token, user_id, created_at, expires_at, remember, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [token, userId, created, expires, remember ? 1 : 0, String(userAgent).slice(0, 250), String(ip).slice(0, 64)]
    );
    return { token, expires };
}

function getSessionUser(token) {
    if (!token) {
        return null;
    }
    const session = get('SELECT * FROM session WHERE token = ?', [token]);
    if (!session) {
        return null;
    }
    if (session.expires_at < now()) {
        run('DELETE FROM session WHERE token = ?', [token]);
        return null;
    }
    const user = get('SELECT id, username, active, created_at FROM user WHERE id = ?', [session.user_id]);
    if (!user || !user.active) {
        return null;
    }
    return user;
}

function destroySession(token) {
    if (token) {
        run('DELETE FROM session WHERE token = ?', [token]);
    }
}

function destroyOtherSessions(userId, keepToken) {
    run('DELETE FROM session WHERE user_id = ? AND token != ?', [userId, keepToken || '']);
}

function cleanupSessions() {
    run('DELETE FROM session WHERE expires_at < ?', [now()]);
}

function sessionCookie(token, expires) {
    const maxAge = Math.max(0, Math.floor((expires - now()) / 1000));
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function countUsers() {
    const row = get('SELECT COUNT(*) AS total FROM user');
    return row ? row.total : 0;
}

function getUserByName(username) {
    return get('SELECT * FROM user WHERE username = ? COLLATE NOCASE', [username]);
}

function listUsers() {
    return all('SELECT id, username, active, created_at FROM user ORDER BY id');
}

// ---------- kunci API ----------

const API_KEY_PREFIX = 'pk_';
const API_KEY_SCOPES = new Set(['read', 'write']);

function hashApiToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Token hanya disimpan sebagai hash SHA-256. Nilai aslinya hanya ditampilkan
 * sekali, saat kunci dibuat.
 */
function createApiKey(userId, { name, scope = 'read', expiresInDays = 0 } = {}) {
    const cleanName = String(name || '').trim().slice(0, 80) || 'Kunci API';
    const cleanScope = API_KEY_SCOPES.has(scope) ? scope : 'read';
    const token = `${API_KEY_PREFIX}${randomToken(24)}`;
    const timestamp = now();
    const days = Number(expiresInDays) || 0;
    const expiresAt = days > 0 ? timestamp + days * 86400000 : null;
    const info = run(
        'INSERT INTO api_key (name, token_hash, prefix, scope, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [cleanName, hashApiToken(token), token.slice(0, 11), cleanScope, userId, timestamp, expiresAt]
    );
    return {
        id: Number(info.lastInsertRowid),
        name: cleanName,
        scope: cleanScope,
        prefix: token.slice(0, 11),
        token,
        createdAt: timestamp,
        expiresAt,
    };
}

function findApiKey(token) {
    if (!token) {
        return null;
    }
    const row = get('SELECT * FROM api_key WHERE token_hash = ?', [hashApiToken(token)]);
    if (!row) {
        return null;
    }
    if (row.expires_at && Number(row.expires_at) < now()) {
        return null;
    }
    return row;
}

function touchApiKey(id) {
    run('UPDATE api_key SET last_used_at = ? WHERE id = ?', [now(), id]);
}

function listApiKeys(userId) {
    return all(
        'SELECT id, name, prefix, scope, created_at, last_used_at, expires_at FROM api_key WHERE user_id = ? ORDER BY id',
        [userId]
    );
}

function revokeApiKey(id, userId) {
    run('DELETE FROM api_key WHERE id = ? AND user_id = ?', [id, userId]);
}

// Simple in-memory login throttling: 8 failures per 10 minutes per key.
const attempts = new Map();

function throttleKey(ip, username) {
    return `${ip}|${String(username || '').toLowerCase()}`;
}

function isThrottled(ip, username) {
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

function recordFailure(ip, username) {
    const key = throttleKey(ip, username);
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now()) {
        attempts.set(key, { count: 1, resetAt: now() + 10 * 60 * 1000 });
        return;
    }
    entry.count += 1;
}

function clearFailures(ip, username) {
    attempts.delete(throttleKey(ip, username));
}

module.exports = {
    SESSION_COOKIE,
    SESSION_TTL,
    hashPassword,
    verifyPassword,
    parseCookies,
    createSession,
    getSessionUser,
    destroySession,
    destroyOtherSessions,
    cleanupSessions,
    sessionCookie,
    clearCookie,
    countUsers,
    getUserByName,
    listUsers,
    createApiKey,
    findApiKey,
    touchApiKey,
    listApiKeys,
    revokeApiKey,
    isThrottled,
    recordFailure,
    clearFailures,
};
