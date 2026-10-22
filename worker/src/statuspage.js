/**
 * Payload status page publik dan umpan RSS.
 */

import { STATUS, now, percent, escapeHtml } from './util.js';
import { shapeStatusPage, shapeIncident, shapeMaintenance } from './models.js';
import { summaryOf, uptimeOf } from './engine.js';

const DAY = 86400000;

async function pageMonitors(db, pageId) {
    const direct = await db.all(
        `SELECT m.*, spm.weight FROM monitor m
         JOIN status_page_monitor spm ON spm.monitor_id = m.id
         WHERE spm.status_page_id = ? AND m.active = 1
         ORDER BY spm.weight, m.name`,
        [pageId]
    );
    const groups = await db.all(
        'SELECT * FROM status_page_group WHERE status_page_id = ? ORDER BY weight, id',
        [pageId]
    );
    const grouped = [];
    for (const group of groups) {
        const monitors = await db.all(
            `SELECT m.*, gm.weight FROM monitor m
             JOIN status_page_group_monitor gm ON gm.monitor_id = m.id
             WHERE gm.group_id = ? AND m.active = 1
             ORDER BY gm.weight, m.name`,
            [group.id]
        );
        grouped.push({ id: group.id, name: group.name, monitors });
    }
    return { direct, groups: grouped };
}

function compact(summary, options) {
    return {
        id: summary.id,
        name: summary.name,
        type: summary.type,
        status: summary.status,
        uptime24: summary.uptime24,
        uptime30: options.uptime30 ? options.uptime30[summary.id] : null,
        avgPing24: summary.avgPing24,
        beats: summary.beats.slice(-30).map((beat) => ({ status: beat.status, time: beat.time, msg: beat.msg })),
        url: options.showUrls ? summary.url || summary.hostname : undefined,
        tags: options.showTags ? summary.tags : [],
        parentId: summary.parentId,
    };
}

export function overallStatus(monitors, maintenanceActive) {
    if (!monitors.length) {
        return maintenanceActive ? STATUS.MAINTENANCE : STATUS.UP;
    }
    const statuses = monitors.map((monitor) => monitor.status);
    if (statuses.includes(STATUS.DOWN)) {
        return STATUS.DOWN;
    }
    if (statuses.includes(STATUS.PENDING)) {
        return STATUS.PENDING;
    }
    if (statuses.every((status) => status === STATUS.MAINTENANCE)) {
        return STATUS.MAINTENANCE;
    }
    return STATUS.UP;
}

export async function statusPagePayload(db, pageRow) {
    const page = shapeStatusPage(pageRow);
    const { direct, groups } = await pageMonitors(db, page.id);
    const allMonitors = [...direct, ...groups.flatMap((group) => group.monitors)];
    const summaries = new Map();
    for (const monitor of allMonitors) {
        if (!summaries.has(monitor.id)) {
            summaries.set(monitor.id, await summaryOf(db, monitor, { beatLimit: 30, shallow: true }));
        }
    }
    const uptime30 = {};
    for (const monitor of allMonitors) {
        uptime30[monitor.id] = (await uptimeOf(db, monitor.id, now() - 30 * DAY)).uptime;
    }
    const options = { showTags: page.showTags, showUrls: true, uptime30 };

    const timestamp = now();
    const activeMaintenance = await db.all(
        `SELECT m.* FROM maintenance m
         JOIN maintenance_status_page msp ON msp.maintenance_id = m.id
         WHERE msp.status_page_id = ? AND m.active = 1 AND m.start_at <= ? AND m.end_at >= ?
         ORDER BY m.start_at DESC`,
        [page.id, timestamp, timestamp]
    );
    const upcomingMaintenance = await db.all(
        `SELECT m.* FROM maintenance m
         JOIN maintenance_status_page msp ON msp.maintenance_id = m.id
         WHERE msp.status_page_id = ? AND m.active = 1 AND m.start_at > ?
         ORDER BY m.start_at ASC LIMIT 5`,
        [page.id, timestamp]
    );

    const monitorStatuses = [...summaries.values()];
    const activeIncidents = await db.all(
        `SELECT * FROM incident WHERE status_page_id = ? AND resolved_at IS NULL
         ORDER BY pinned DESC, started_at DESC LIMIT 10`,
        [page.id]
    );
    const history = await db.all(
        `SELECT * FROM incident WHERE status_page_id = ? AND resolved_at IS NOT NULL
         ORDER BY resolved_at DESC LIMIT 10`,
        [page.id]
    );

    const ids = allMonitors.map((monitor) => monitor.id);
    let beatRow = null;
    if (ids.length) {
        beatRow = await db.one(
            `SELECT SUM(CASE WHEN h.status = 1 THEN 1 ELSE 0 END) AS up,
                    SUM(CASE WHEN h.status IN (0,1) THEN 1 ELSE 0 END) AS total
             FROM heartbeat h JOIN monitor m ON m.id = h.monitor_id
             WHERE h.time >= ? AND m.active = 1 AND m.id IN (${ids.map(() => '?').join(',')})`,
            [now() - DAY, ...ids]
        );
    }

    return {
        page,
        overall: {
            status: overallStatus(monitorStatuses, activeMaintenance.length > 0),
            uptime24: beatRow && Number(beatRow.total) ? percent(Number(beatRow.up), Number(beatRow.total)) : null,
            totalMonitors: summaries.size,
            downMonitors: monitorStatuses.filter((monitor) => monitor.status === STATUS.DOWN).length,
        },
        groups: groups
            .map((group) => ({
                id: group.id,
                name: group.name,
                monitors: group.monitors.map((monitor) => compact(summaries.get(monitor.id), options)),
            }))
            .filter((group) => group.monitors.length),
        monitors: direct.map((monitor) => compact(summaries.get(monitor.id), options)),
        incidents: activeIncidents.map(shapeIncident),
        history: history.map(shapeIncident),
        maintenance: {
            active: activeMaintenance.map((row) => ({ ...shapeMaintenance(row), description: row.description || '' })),
            upcoming: upcomingMaintenance.map(shapeMaintenance),
        },
        generatedAt: timestamp,
    };
}

export async function getPageBySlug(db, slug) {
    if (!slug) {
        return null;
    }
    return db.one('SELECT * FROM status_page WHERE slug = ?', [slug]);
}

export async function getPageByDomain(db, host) {
    const value = String(host || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, '');
    if (!value) {
        return null;
    }
    return db.one('SELECT * FROM status_page WHERE domain = ?', [value]);
}

const STATUS_LABEL = {
    [STATUS.UP]: 'operasional',
    [STATUS.DOWN]: 'gangguan',
    [STATUS.PENDING]: 'menunggu',
    [STATUS.MAINTENANCE]: 'pemeliharaan',
};

function rssDate(timestamp) {
    return new Date(Number(timestamp) || Date.now()).toUTCString();
}

export async function statusPageFeed(db, pageRow, baseUrl) {
    const page = shapeStatusPage(pageRow);
    const payload = await statusPagePayload(db, pageRow);
    const origin = String(baseUrl || '').replace(/\/+$/, '');
    const link = `${origin}/status/${page.slug}`;
    const items = [];

    for (const incident of payload.incidents) {
        items.push({
            title: incident.title,
            description: incident.content || incident.title,
            date: incident.startedAt,
            link,
        });
    }
    for (const maintenance of [...payload.maintenance.active, ...payload.maintenance.upcoming]) {
        items.push({
            title: `Pemeliharaan: ${maintenance.title}`,
            description: maintenance.description || maintenance.title,
            date: maintenance.startAt,
            link,
        });
    }
    const monitors = [...payload.monitors, ...payload.groups.flatMap((group) => group.monitors)];
    for (const monitor of monitors) {
        const uptime =
            monitor.uptime30 === null || monitor.uptime30 === undefined
                ? '—'
                : `${monitor.uptime30.toFixed(2)}%`;
        items.push({
            title: `${monitor.name}: ${STATUS_LABEL[monitor.status] || monitor.status}`,
            description: `Uptime 30 hari ${uptime}. Status terakhir: ${monitor.status}.`,
            date: payload.generatedAt,
            link,
        });
    }

    const rendered = items
        .map(
            (item) => `    <item>
      <title>${escapeHtml(item.title)}</title>
      <link>${escapeHtml(item.link)}</link>
      <guid isPermaLink="false">${escapeHtml(`${page.slug}-${item.date}-${item.title}`)}</guid>
      <description>${escapeHtml(item.description)}</description>
      <pubDate>${rssDate(item.date)}</pubDate>
    </item>`
        )
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(page.title)}</title>
    <link>${escapeHtml(link)}</link>
    <description>${escapeHtml(page.description || page.title)}</description>
    <language>${page.lang === 'en' ? 'en' : 'id-ID'}</language>
    <lastBuildDate>${rssDate(payload.generatedAt)}</lastBuildDate>
    <generator>Uptime Prasasti Websites</generator>
${rendered}
  </channel>
</rss>
`;
}
