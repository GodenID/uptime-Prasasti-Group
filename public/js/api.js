const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(path, {
        method,
        headers: body !== undefined ? JSON_HEADERS : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        signal,
    });

    const type = response.headers.get('content-type') || '';
    const payload = type.includes('application/json')
        ? await response.json().catch(() => ({}))
        : await response.text();

    if (!response.ok) {
        const message = (payload && payload.error) || (typeof payload === 'string' && payload) || 'Permintaan gagal';
        throw new ApiError(response.status, message);
    }
    return payload;
}

export const endpoints = {
    session: () => api('/api/session'),
    setup: (username, password) => api('/api/setup', { method: 'POST', body: { username, password } }),
    login: (username, password, remember) =>
        api('/api/login', { method: 'POST', body: { username, password, remember } }),
    logout: () => api('/api/logout', { method: 'POST', body: {} }),
    bootstrap: () => api('/api/bootstrap'),
    createMonitor: (body) => api('/api/monitors', { method: 'POST', body }),
    updateMonitor: (id, body) => api(`/api/monitors/${id}`, { method: 'PATCH', body }),
    deleteMonitor: (id) => api(`/api/monitors/${id}`, { method: 'DELETE' }),
    pauseMonitor: (id) => api(`/api/monitors/${id}/pause`, { method: 'POST', body: {} }),
    resumeMonitor: (id) => api(`/api/monitors/${id}/resume`, { method: 'POST', body: {} }),
    checkMonitor: (id) => api(`/api/monitors/${id}/check`, { method: 'POST', body: {} }),
    monitor: (id) => api(`/api/monitors/${id}`),
    monitorEvents: (id, offset) => api(`/api/monitors/${id}/events?limit=20&offset=${offset}`),
    tag: (body) => api('/api/tags', { method: 'POST', body }),
    updateTag: (id, body) => api(`/api/tags/${id}`, { method: 'PATCH', body }),
    deleteTag: (id) => api(`/api/tags/${id}`, { method: 'DELETE' }),
    notification: (body) => api('/api/notifications', { method: 'POST', body }),
    updateNotification: (id, body) => api(`/api/notifications/${id}`, { method: 'PATCH', body }),
    deleteNotification: (id) => api(`/api/notifications/${id}`, { method: 'DELETE' }),
    testNotification: (id) => api(`/api/notifications/${id}/test`, { method: 'POST', body: {} }),
    notificationLogs: () => api('/api/notification-logs'),
    statusPage: (body) => api('/api/status-pages', { method: 'POST', body }),
    updateStatusPage: (id, body) => api(`/api/status-pages/${id}`, { method: 'PATCH', body }),
    deleteStatusPage: (id) => api(`/api/status-pages/${id}`, { method: 'DELETE' }),
    publishStatusPage: (id, published) =>
        api(`/api/status-pages/${id}/publish`, { method: 'POST', body: { published } }),
    incident: (body) => api('/api/incidents', { method: 'POST', body }),
    resolveIncident: (id) => api(`/api/incidents/${id}/resolve`, { method: 'POST', body: {} }),
    deleteIncident: (id) => api(`/api/incidents/${id}`, { method: 'DELETE' }),
    maintenance: (body) => api('/api/maintenances', { method: 'POST', body }),
    updateMaintenance: (id, body) => api(`/api/maintenances/${id}`, { method: 'PATCH', body }),
    deleteMaintenance: (id) => api(`/api/maintenances/${id}`, { method: 'DELETE' }),
    settings: (body) => api('/api/settings', { method: 'PATCH', body }),
    password: (current, next) => api('/api/password', { method: 'POST', body: { current, next } }),
    createUser: (username, password) => api('/api/users', { method: 'POST', body: { username, password } }),
    exportData: () => api('/api/export'),
    importData: (data) => api('/api/import', { method: 'POST', body: { data } }),
};
