import { escapeHtml, fmtPing, fmtTime, statusMeta } from './ui.js';

/**
 * Render a responsive SVG response-time chart with hover readout.
 */
export function lineChart(container, points, { height = 190 } = {}) {
    const data = (points || []).filter((point) => point && point.time);
    container.innerHTML = '';

    if (!data.length) {
        container.innerHTML = '<div class="chart-empty">Belum ada data respons untuk ditampilkan.</div>';
        return;
    }

    const width = 760;
    const pad = { top: 14, right: 10, bottom: 24, left: 40 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const values = data.map((point) => (point.ping === null ? null : Number(point.ping)));
    const numeric = values.filter((value) => Number.isFinite(value));
    const rawMax = numeric.length ? Math.max(...numeric) : 100;
    const maxValue = Math.max(10, Math.ceil((rawMax * 1.25) / 10) * 10);

    const times = data.map((point) => Number(point.time));
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const span = Math.max(1, maxTime - minTime);

    const x = (time) => pad.left + ((Number(time) - minTime) / span) * innerW;
    const y = (value) => pad.top + innerH - (Number(value) / maxValue) * innerH;

    const segments = [];
    let current = [];
    data.forEach((point, index) => {
        const value = values[index];
        if (value === null || !Number.isFinite(value)) {
            if (current.length) segments.push(current);
            current = [];
            return;
        }
        current.push([x(point.time), y(value), point]);
    });
    if (current.length) segments.push(current);

    const linePath = segments
        .map((segment) =>
            segment
                .map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
                .join(' ')
        )
        .filter(Boolean)
        .join(' ');

    const areaSegments = segments
        .filter((segment) => segment.length > 1)
        .map((segment) => {
            const start = segment[0];
            const end = segment[segment.length - 1];
            const line = segment
                .map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`)
                .join(' ');
            return `${line} L${end[0].toFixed(1)},${(pad.top + innerH).toFixed(1)} L${start[0].toFixed(
                1
            )},${(pad.top + innerH).toFixed(1)} Z`;
        })
        .join(' ');

    const ticks = 4;
    let grid = '';
    for (let index = 0; index <= ticks; index += 1) {
        const value = (maxValue / ticks) * index;
        const py = y(value);
        grid += `<line x1="${pad.left}" y1="${py.toFixed(1)}" x2="${width - pad.right}" y2="${py.toFixed(1)}" />`;
        grid += `<text x="${pad.left - 7}" y="${(py + 3).toFixed(1)}" text-anchor="end">${Math.round(value)}</text>`;
    }

    const labelCount = Math.min(5, data.length);
    let xLabels = '';
    for (let index = 0; index < labelCount; index += 1) {
        const ratio = labelCount === 1 ? 0 : index / (labelCount - 1);
        const time = minTime + span * ratio;
        const px = pad.left + innerW * ratio;
        xLabels += `<text x="${px.toFixed(1)}" y="${height - 6}" text-anchor="${
            index === 0 ? 'start' : index === labelCount - 1 ? 'end' : 'middle'
        }">${fmtTime(time)}</text>`;
    }

    // Tanda gangguan: garis merah tipis di dasar grafik untuk setiap denyut "down".
    const baseline = pad.top + innerH;
    const downMarks = data
        .filter((point) => Number(point.status) === 0)
        .map(
            (point) =>
                `<rect class="chart-down" x="${(x(point.time) - 1).toFixed(1)}" y="${(baseline - 4).toFixed(
                    1
                )}" width="2" height="4" />`
        )
        .join('');

    container.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Grafik waktu respons">
            <g class="chart-grid">${grid}</g>
            <g class="chart-axis">${xLabels}</g>
            <path class="chart-area" d="${areaSegments}" stroke="none"></path>
            <path class="chart-line" d="${linePath}"></path>
            <g class="chart-points">${downMarks}</g>
            <g class="chart-cursor hidden">
                <line class="chart-hover-line" y1="${pad.top}" y2="${pad.top + innerH}" />
                <circle r="3.5"></circle>
            </g>
            <rect class="chart-overlay" x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" fill="transparent" />
        </svg>
        <div class="chart-tip"></div>
    `;

    const svg = container.querySelector('svg');
    const tip = container.querySelector('.chart-tip');
    const cursor = container.querySelector('.chart-cursor');
    const cursorLine = cursor.querySelector('line');
    const cursorDot = cursor.querySelector('circle');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.height = `${height}px`;

    svg.querySelector('.chart-overlay').addEventListener('mousemove', (event) => {
        const rect = svg.getBoundingClientRect();
        const relative = ((event.clientX - rect.left) / rect.width) * width;
        const ratio = Math.min(1, Math.max(0, (relative - pad.left) / innerW));
        const targetTime = minTime + span * ratio;

        let best = null;
        let bestDistance = Infinity;
        data.forEach((point, index) => {
            const distance = Math.abs(Number(point.time) - targetTime);
            if (distance < bestDistance && values[index] !== null) {
                bestDistance = distance;
                best = { point, value: values[index], index };
            }
        });
        if (!best) return;

        const px = x(best.point.time);
        const py = y(best.value);
        const meta = statusMeta(best.point.status);
        cursor.classList.remove('hidden');
        cursorLine.setAttribute('x1', px);
        cursorLine.setAttribute('x2', px);
        cursorDot.setAttribute('cx', px);
        cursorDot.setAttribute('cy', py);
        cursorDot.style.fill = meta.key === 'down' ? 'var(--down)' : 'var(--primary)';

        tip.innerHTML = `<b>${escapeHtml(fmtPing(best.value))}</b> · ${escapeHtml(meta.label)}<br><span>${escapeHtml(
            fmtTime(best.point.time)
        )}</span>`;
        tip.style.opacity = '1';
        tip.style.left = `${(px / width) * 100}%`;
        tip.style.top = `${(py / height) * 100}%`;
    });

    svg.querySelector('.chart-overlay').addEventListener('mouseleave', () => {
        tip.style.opacity = '0';
        cursor.classList.add('hidden');
    });
}
