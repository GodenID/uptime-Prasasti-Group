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
    isThrottled,
    recordFailure,
    clearFailures,
};
