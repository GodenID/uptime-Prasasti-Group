-- Skema Uptime Prasasti Websites untuk D1 (Cloudflare Workers).
-- Sama dengan skema SQLite di server/db.js, ditambah kolom next_run untuk
-- penjadwalan berbasis Durable Object.

CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    remember INTEGER NOT NULL DEFAULT 0,
    user_agent TEXT,
    ip TEXT
);

CREATE TABLE IF NOT EXISTS api_key (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'read',
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS setting (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#a8825a',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT,
    hostname TEXT,
    port INTEGER,
    method TEXT DEFAULT 'GET',
    headers TEXT,
    body TEXT,
    interval INTEGER NOT NULL DEFAULT 60,
    retries INTEGER NOT NULL DEFAULT 0,
    retry_interval INTEGER NOT NULL DEFAULT 60,
    timeout REAL NOT NULL DEFAULT 15,
    upside_down INTEGER NOT NULL DEFAULT 0,
    keyword TEXT,
    json_path TEXT,
    expected_value TEXT,
    accepted_codes TEXT,
    max_redirects INTEGER NOT NULL DEFAULT 10,
    ignore_tls INTEGER NOT NULL DEFAULT 0,
    cert_expiry_notification INTEGER NOT NULL DEFAULT 1,
    domain_expiry_notification INTEGER NOT NULL DEFAULT 0,
    dns_record_type TEXT DEFAULT 'A',
    dns_resolver TEXT,
    parent_id INTEGER REFERENCES monitor(id) ON DELETE SET NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    push_token TEXT UNIQUE,
    options TEXT NOT NULL DEFAULT '{}',
    next_run INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_tag (
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, tag_id)
);

CREATE TABLE IF NOT EXISTS notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    events TEXT NOT NULL DEFAULT '',
    resend_interval REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_notification (
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    notification_id INTEGER NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
    PRIMARY KEY (monitor_id, notification_id)
);

CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    status INTEGER NOT NULL,
    msg TEXT,
    ping REAL,
    time INTEGER NOT NULL,
    important INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0,
    cert_info TEXT
);

CREATE TABLE IF NOT EXISTS heartbeat_daily (
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    day INTEGER NOT NULL,
    up_count INTEGER NOT NULL DEFAULT 0,
    down_count INTEGER NOT NULL DEFAULT 0,
    pending_count INTEGER NOT NULL DEFAULT 0,
    maintenance_count INTEGER NOT NULL DEFAULT 0,
    ping_sum REAL NOT NULL DEFAULT 0,
    ping_count INTEGER NOT NULL DEFAULT 0,
    downtime_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (monitor_id, day)
);

CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_id INTEGER,
    monitor_id INTEGER,
    event TEXT NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incident (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER REFERENCES monitor(id) ON DELETE SET NULL,
    status_page_id INTEGER REFERENCES status_page(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT,
    style TEXT NOT NULL DEFAULT 'warning',
    started_at INTEGER NOT NULL,
    resolved_at INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    strategy TEXT NOT NULL DEFAULT 'once',
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS maintenance_monitor (
    maintenance_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS status_page (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT NOT NULL DEFAULT '/favicon.svg',
    theme TEXT NOT NULL DEFAULT 'stone',
    published INTEGER NOT NULL DEFAULT 0,
    show_tags INTEGER NOT NULL DEFAULT 1,
    show_powered_by INTEGER NOT NULL DEFAULT 1,
    footer_text TEXT,
    custom_css TEXT,
    domain TEXT NOT NULL DEFAULT '',
    announcement TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'id',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_page_group (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status_page_id INTEGER NOT NULL REFERENCES status_page(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    weight INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS status_page_group_monitor (
    group_id INTEGER NOT NULL REFERENCES status_page_group(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS status_page_monitor (
    status_page_id INTEGER NOT NULL REFERENCES status_page(id) ON DELETE CASCADE,
    monitor_id INTEGER NOT NULL REFERENCES monitor(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (status_page_id, monitor_id)
);

CREATE TABLE IF NOT EXISTS maintenance_status_page (
    maintenance_id INTEGER NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
    status_page_id INTEGER NOT NULL REFERENCES status_page(id) ON DELETE CASCADE,
    PRIMARY KEY (maintenance_id, status_page_id)
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_monitor_time ON heartbeat(monitor_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_heartbeat_time ON heartbeat(time);
CREATE INDEX IF NOT EXISTS idx_heartbeat_important ON heartbeat(monitor_id, important, time DESC);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON session(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key(user_id);
CREATE INDEX IF NOT EXISTS idx_incident_started ON incident(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_parent ON monitor(parent_id);
CREATE INDEX IF NOT EXISTS idx_monitor_next_run ON monitor(next_run);
CREATE INDEX IF NOT EXISTS idx_notification_monitor ON notification_log(monitor_id, created_at DESC);
