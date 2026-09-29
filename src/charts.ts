// Small, dependency-free chart helpers. Each render* function returns an
// HTML string; call attachTooltips() on the containing element after it's
// inserted into the DOM to wire up tooltips on any element carrying a
// data-tooltip attribute. Tooltips open on hover (mouse) and on tap (touch),
// since most staff use the app on phones.

import { escapeHtml, shortDate } from './util';

// ---- Tooltips ---------------------------------------------------------

let tooltipEl: HTMLDivElement | null = null;
let activeEl: Element | null = null;
let globalListeners = false;

function getTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chart-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

function showTooltip(text: string, pageX: number, pageY: number) {
  const tooltip = getTooltip();
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  const w = tooltip.offsetWidth;
  const left = Math.max(window.scrollX + 8, Math.min(pageX - w / 2, window.scrollX + window.innerWidth - w - 8));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${pageY - tooltip.offsetHeight - 12}px`;
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
  activeEl = null;
}

export function attachTooltips(container: HTMLElement) {
  if (!globalListeners) {
    document.addEventListener('click', hideTooltip);
    window.addEventListener('hashchange', hideTooltip);
    globalListeners = true;
  }
  container.querySelectorAll<HTMLElement | SVGElement>('[data-tooltip]').forEach((el) => {
    const text = () => el.dataset.tooltip || '';
    el.addEventListener('mousemove', (e) => showTooltip(text(), (e as MouseEvent).pageX, (e as MouseEvent).pageY));
    el.addEventListener('mouseleave', () => {
      if (activeEl !== el) hideTooltip();
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeEl === el) {
        hideTooltip();
        return;
      }
      showTooltip(text(), (e as MouseEvent).pageX, (e as MouseEvent).pageY);
      activeEl = el;
    });
  });
}

// ---- Shared geometry ----------------------------------------------------

export interface SeriesPoint {
  x: string; // yyyy-MM-dd
  y: number;
  extra?: string;
}

export interface SeriesOptions {
  color: string;
  formatValue: (n: number) => string;
  formatAxis: (n: number) => string;
  /** Last point is today and still incomplete: drawn dashed/hollow. */
  partialLast?: boolean;
  /** Numbered dashed lines just after these dates (e.g. the last trip of a
   * closed route), explained in a key under the chart — see chartMarkers(). */
  markers?: ChartMarker[];
}

export interface ChartMarker {
  after: string; // yyyy-MM-dd: the line is drawn between this day and the next
  text: string;
}

const W = 640;
const H = 220;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 30;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * mag >= v) return step * mag;
  }
  return 10 * mag;
}

/** `band`: each point gets an equal slot with the point in its middle (for
 * columns, so the first and last bars don't sit on the chart's edges);
 * otherwise points run edge to edge (for lines). */
function frame(points: SeriesPoint[], opts: SeriesOptions, band = false) {
  const maxY = niceMax(Math.max(...points.map((p) => p.y), 0));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const step = band ? plotW / points.length : points.length > 1 ? plotW / (points.length - 1) : 0;
  const xAt = (i: number) => (band ? PAD_L + (i + 0.5) * step : points.length > 1 ? PAD_L + i * step : PAD_L + plotW / 2);
  const yAt = (v: number) => PAD_T + plotH - (Math.max(v, 0) / maxY) * plotH;
  const baseY = PAD_T + plotH;

  const grid = [0, maxY / 2, maxY]
    .map((t) => {
      const y = yAt(t).toFixed(1);
      return `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" class="${t === 0 ? 'chart-baseline' : 'chart-grid-line'}"></line>
        <text x="${PAD_L - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" class="chart-axis-label">${escapeHtml(opts.formatAxis(t))}</text>`;
    })
    .join('');

  const n = points.length;
  const labelIdxs = n <= 6 ? points.map((_, i) => i) : [0, 1, 2, 3, 4, 5].map((k) => Math.round((k * (n - 1)) / 5));
  const xLabels = labelIdxs
    .map((i) => {
      const isToday = opts.partialLast && i === n - 1;
      const anchor = band ? 'middle' : n > 1 && i === 0 ? 'start' : n > 1 && i === n - 1 ? 'end' : 'middle';
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" class="chart-axis-label">${isToday ? 'Today' : escapeHtml(shortDate(points[i].x))}</text>`;
    })
    .join('');

  // Full-height, full-step-width invisible strips: far easier to hit with a
  // finger than a 4px dot. Kept inside the plot area, so the hover shading
  // never spills past the chart's edges.
  const stripW = n > 1 || band ? step : plotW;
  const hits = points
    .map((p, i) => {
      const isToday = opts.partialLast && i === n - 1;
      const tip = `${isToday ? 'Today (so far)' : shortDate(p.x, true)}: ${opts.formatValue(p.y)}${p.extra ? ' · ' + p.extra : ''}`;
      const x0 = Math.max(PAD_L, xAt(i) - stripW / 2);
      const x1 = Math.min(W - PAD_R, xAt(i) + stripW / 2);
      return `<rect x="${x0.toFixed(1)}" y="${PAD_T}" width="${(x1 - x0).toFixed(1)}" height="${plotH.toFixed(1)}" class="chart-hit" data-tooltip="${escapeHtml(tip)}"></rect>`;
    })
    .join('');

  const markers = (opts.markers ?? [])
    .map((m, k) => {
      const i = points.findIndex((p) => p.x === m.after);
      if (i < 0 || i >= n - 1) return '';
      const x = (xAt(i) + xAt(i + 1)) / 2;
      return `<line x1="${x.toFixed(1)}" y1="${PAD_T + 12}" x2="${x.toFixed(1)}" y2="${baseY}" class="chart-marker"></line>
        <circle cx="${x.toFixed(1)}" cy="${PAD_T + 2}" r="10" class="chart-marker-badge"></circle>
        <text x="${x.toFixed(1)}" y="${PAD_T + 2}" text-anchor="middle" dominant-baseline="central" class="chart-marker-num">${k + 1}</text>`;
    })
    .join('');

  return { xAt, yAt, baseY, step, grid, xLabels, hits, markers };
}

/** The key for a chart's markers, numbered to match the badges. */
export function chartMarkers(markers: ChartMarker[] | undefined): string {
  if (!markers?.length) return '';
  return `<ol class="chart-markers">${markers.map((m) => `<li>${escapeHtml(m.text)}</li>`).join('')}</ol>`;
}

function svg(body: string, label: string): string {
  return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="chart" role="img" aria-label="${escapeHtml(label)}">${body}</svg>`;
}

// ---- Line chart ------------------------------------------------------------

/** A single-series trend line over dates, with y-axis gridlines. */
export function renderLineChart(points: SeriesPoint[], opts: SeriesOptions & { label: string }): string {
  if (points.length === 0) return '<p class="muted">No data.</p>';
  const { xAt, yAt, baseY, grid, xLabels, hits, markers } = frame(points, opts);
  const n = points.length;
  const coords = points.map((p, i) => ({ x: xAt(i), y: yAt(p.y) }));
  const pathOf = (cs: { x: number; y: number }[]) =>
    cs.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');

  const partial = opts.partialLast && n > 1;
  const solid = partial ? coords.slice(0, n - 1) : coords;
  const solidPath = pathOf(solid);
  const area = `${solidPath} L ${solid[solid.length - 1].x.toFixed(1)} ${baseY} L ${solid[0].x.toFixed(1)} ${baseY} Z`;
  const dashed = partial
    ? `<path d="${pathOf(coords.slice(n - 2))}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-dasharray="5 5"></path>`
    : '';

  const dots = coords
    .map((c, i) =>
      opts.partialLast && i === n - 1
        ? `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4" fill="var(--color-surface)" stroke="${opts.color}" stroke-width="2"></circle>`
        : n <= 45
          ? `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3" fill="${opts.color}"></circle>`
          : '',
    )
    .join('');

  return svg(
    `${grid}
    <path d="${area}" fill="${opts.color}" opacity="0.1" stroke="none"></path>
    <path d="${solidPath}" fill="none" stroke="${opts.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
    ${dashed}${dots}${markers}${xLabels}${hits}`,
    opts.label,
  );
}

// ---- Column chart ------------------------------------------------------------

/** One column per date; zero days draw nothing. Suited to sparse events such
 * as cash shortages, where a line would imply values between days. */
export function renderColumnChart(points: SeriesPoint[], opts: SeriesOptions & { label: string }): string {
  if (points.length === 0) return '<p class="muted">No data.</p>';
  const { xAt, yAt, baseY, step, grid, xLabels, hits, markers } = frame(points, opts, true);
  const barW = Math.max(3, Math.min(24, step * 0.7));
  const bars = points
    .map((p, i) => {
      if (p.y <= 0) return '';
      const y = yAt(p.y);
      const partial = opts.partialLast && i === points.length - 1;
      return `<rect x="${(xAt(i) - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${(baseY - y).toFixed(1)}" rx="2" fill="${opts.color}"${partial ? ' opacity="0.5"' : ''}></rect>`;
    })
    .join('');
  return svg(`${grid}${bars}${markers}${xLabels}${hits}`, opts.label);
}

// ---- Horizontal bar list -----------------------------------------------------

export interface BarRow {
  label: string;
  value: number;
  display: string; // formatted value shown next to the bar
  sub?: string;
  color?: string;
}

/** Ranked horizontal bars with the value always printed — readable without
 * any hovering. */
export function renderBarList(rows: BarRow[]): string {
  if (rows.length === 0) return '<p class="muted">No data.</p>';
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 0) || 1;
  return `
    <div class="bar-list">
      ${rows
        .map((r) => {
          const pct = r.value === 0 ? 0 : Math.max(1.5, (Math.abs(r.value) / max) * 100);
          const bg = r.value < 0 ? 'var(--color-danger)' : r.color || 'var(--series-1)';
          return `
            <div class="bar-row">
              <div class="bar-label">${escapeHtml(r.label)}</div>
              <div class="bar-track"><div class="bar-fill" style="width: ${pct}%; background: ${bg}"></div></div>
              <div class="bar-value">${escapeHtml(r.display)}${r.sub ? ` <span class="bar-sub">· ${escapeHtml(r.sub)}</span>` : ''}</div>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

// ---- Donut (pie) chart ---------------------------------------------------------

export interface PieSlice {
  label: string;
  value: number;
  color?: string;
}

const PIE_COLORS = ['var(--series-1)', 'var(--series-3)', 'var(--series-2)', 'var(--series-6)', 'var(--series-4)', 'var(--series-5)', 'var(--color-muted)'];

/** A fixed color per position, so the same item can keep its color across charts. */
export function pieColor(i: number): string {
  return PIE_COLORS[i % PIE_COLORS.length];
}

/** Share of a whole as a donut, with a key listing every slice's value and
 * percentage (so nothing depends on hovering). Beyond `maxSlices`, the
 * smallest slices are combined into "Other". */
export function renderDonut(
  slices: PieSlice[],
  opts: { formatValue: (n: number) => string; centerLabel: string; label: string; maxSlices?: number },
): string {
  let rows = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return '<p class="muted">No data.</p>';
  const max = opts.maxSlices ?? 6;
  if (rows.length > max) {
    const rest = rows.slice(max - 1);
    rows = [...rows.slice(0, max - 1), { label: `Other (${rest.length})`, value: rest.reduce((sum, s) => sum + s.value, 0), color: 'var(--color-muted)' }];
  }
  const colored = rows.map((s, i) => ({ ...s, color: s.color || PIE_COLORS[i % PIE_COLORS.length] }));

  const R = 70;
  const C = 2 * Math.PI * R;
  const gap = colored.length > 1 ? 1.5 : 0; // thin separator between slices
  let offset = 0;
  const arcs = colored
    .map((s) => {
      const len = (s.value / total) * C;
      const tip = `${s.label}: ${opts.formatValue(s.value)} (${pct(s.value / total)})`;
      const arc = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${s.color}" stroke-width="32"
        stroke-dasharray="${Math.max(len - gap, 0.5).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
        transform="rotate(-90 100 100)" class="pie-slice" data-tooltip="${escapeHtml(tip)}"></circle>`;
      offset += len;
      return arc;
    })
    .join('');

  return `
    <div class="pie">
      <svg viewBox="0 0 200 200" class="pie-chart" role="img" aria-label="${escapeHtml(opts.label)}">
        ${arcs}
        <text x="100" y="92" text-anchor="middle" class="pie-center-label">${escapeHtml(opts.centerLabel)}</text>
        <text x="100" y="116" text-anchor="middle" class="pie-center-value">${escapeHtml(opts.formatValue(total))}</text>
      </svg>
      <ul class="pie-key">
        ${colored
          .map(
            (s) => `<li><span class="pie-dot" style="background: ${s.color}"></span><span class="pie-name">${escapeHtml(s.label)}</span>
              <span class="pie-pct">${pct(s.value / total)}</span><span class="pie-val">${escapeHtml(opts.formatValue(s.value))}</span></li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

function pct(x: number): string {
  const v = x * 100;
  return `${v >= 10 || v === 0 ? Math.round(v) : v.toFixed(1)}%`;
}

// ---- Rate list -------------------------------------------------------------------

export interface RateRow {
  label: string;
  rate: number; // 0..1
  sub?: string;
  tone: 'high' | 'above' | 'normal' | 'below';
}

/** Rates (e.g. return rates) on one shared 0–N% scale, with a dashed line in
 * every bar at the overall average — so "worse than usual" is visible at a
 * glance, and nearly equal rates look nearly equal. */
export function renderRateList(rows: RateRow[], opts: { average: number; averageLabel: string }): string {
  if (rows.length === 0) return '<p class="muted">No data.</p>';
  const top = Math.max(opts.average, ...rows.map((r) => r.rate));
  const scale = Math.max(0.05, Math.ceil(top * 20) / 20); // next 5%
  const at = (rate: number) => `${Math.min(100, (rate / scale) * 100).toFixed(1)}%`;
  const fmt = (x: number) => {
    const v = x * 100;
    return `${v !== 0 && v < 10 ? v.toFixed(1) : Math.round(v)}%`;
  };
  return `
    <div class="rate-list">
      ${rows
        .map(
          (r) => `
        <div class="rate-row">
          <div class="rate-head"><span class="rate-label">${escapeHtml(r.label)}</span><span class="rate-value tone-${r.tone}">${fmt(r.rate)}</span></div>
          <div class="rate-track">
            <div class="rate-fill tone-${r.tone}" style="width: ${r.rate > 0 ? `max(3px, ${at(r.rate)})` : '0'}"></div>
            <div class="rate-avg" style="left: ${at(opts.average)}"></div>
          </div>
          ${r.sub ? `<div class="rate-sub">${escapeHtml(r.sub)}</div>` : ''}
        </div>`,
        )
        .join('')}
      <div class="rate-scale"><span>0%</span><span class="rate-scale-avg"><i></i>${escapeHtml(opts.averageLabel)} ${fmt(opts.average)}</span><span>${fmt(scale)}</span></div>
    </div>`;
}
