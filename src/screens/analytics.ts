import { navHtml, wireNav } from '../components/nav';
import { getAnalytics } from '../api';
import { attachTooltips, chartMarkers, pieColor, renderBarList, renderColumnChart, renderDonut, renderLineChart, renderRateList } from '../charts';
import type { ChartMarker, RateRow, SeriesPoint } from '../charts';
import type { Analytics, AnalyticsByDate, AnalyticsByDriver, AnalyticsByProduct } from '../types';
import {
  addDays,
  daysBetween,
  escapeHtml,
  localDateStr,
  money,
  monthStart,
  moneyCompact,
  moneyRound,
  percent,
  shortDate,
} from '../util';

type PresetKey = 'today' | '7d' | '30d' | 'month' | 'lastMonth';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
];

function presetRange(key: PresetKey): { from: string; to: string } {
  const today = localDateStr(); // India date
  switch (key) {
    case 'today':
      return { from: today, to: today };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'month':
      return { from: monthStart(today), to: today };
    case 'lastMonth':
      return { from: monthStart(today, -1), to: addDays(monthStart(today), -1) };
  }
}

interface Context {
  from: string;
  to: string;
  days: number;
  partialLast: boolean; // range ends today, so today's figures are incomplete
  // Comparison window: the complete days of the range (so it stops at
  // yesterday when the range ends today), compared with the same number of
  // days immediately before it. Null for a range that is only today.
  compare: { to: string; days: number } | null;
  prev: Analytics | null;
}

export async function renderAnalytics(container: HTMLElement) {
  const initial = presetRange('30d');
  container.innerHTML =
    navHtml('analytics') +
    `
    <main class="page">
      <h1>Analytics</h1>
      <div class="presets">
        ${PRESETS.map((p) => `<button type="button" class="preset${p.key === '30d' ? ' active' : ''}" data-preset="${p.key}">${p.label}</button>`).join('')}
      </div>
      <div class="field-row">
        <label>From <input type="date" id="date-from" value="${initial.from}" /></label>
        <label>To <input type="date" id="date-to" value="${initial.to}" /></label>
      </div>
      <div id="analytics-content">Loading...</div>
    </main>
  `;
  wireNav(container);

  const content = container.querySelector<HTMLDivElement>('#analytics-content')!;
  const dateFrom = container.querySelector<HTMLInputElement>('#date-from')!;
  const dateTo = container.querySelector<HTMLInputElement>('#date-to')!;
  const presetBtns = Array.from(container.querySelectorAll<HTMLButtonElement>('.preset'));

  let requestId = 0;

  async function load() {
    const from = dateFrom.value;
    const to = dateTo.value;
    if (!from || !to || from > to) {
      content.innerHTML = '<p class="error">Pick a valid date range.</p>';
      return;
    }
    const myRequest = ++requestId;
    content.innerHTML = 'Loading...';

    // Compare complete days only: a half-finished today against full earlier
    // days would always read as a drop.
    const today = localDateStr();
    const days = daysBetween(from, to);
    const compareTo = to >= today ? addDays(today, -1) : to;
    const compare = compareTo >= from ? { to: compareTo, days: daysBetween(from, compareTo) } : null;
    const prevTo = addDays(from, -1);
    const prevFrom = compare ? addDays(prevTo, -(compare.days - 1)) : prevTo;

    try {
      // One request: the backend computes the comparison range from the same
      // sheet read.
      const data = await getAnalytics({
        dateFrom: from,
        dateTo: to,
        previous: compare ? { dateFrom: prevFrom, dateTo: prevTo } : undefined,
      });
      const prev = data.previous ?? null;
      if (myRequest !== requestId) return; // a newer range was picked meanwhile
      const lastDate = data.byDate[data.byDate.length - 1]?.date;
      const ctx: Context = { from, to, days, compare, prev, partialLast: to === today && lastDate === today };
      content.innerHTML = renderContent(data, ctx);
      attachTooltips(content);
    } catch (err) {
      if (myRequest !== requestId) return;
      content.innerHTML = `<p class="error">Failed to load: ${escapeHtml((err as Error).message)}</p>`;
    }
  }

  presetBtns.forEach((btn) =>
    btn.addEventListener('click', () => {
      const range = presetRange(btn.dataset.preset as PresetKey);
      dateFrom.value = range.from;
      dateTo.value = range.to;
      presetBtns.forEach((b) => b.classList.toggle('active', b === btn));
      load();
    }),
  );
  [dateFrom, dateTo].forEach((el) =>
    el.addEventListener('change', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      load();
    }),
  );
  await load();
}

// ---- Layout --------------------------------------------------------------

function renderContent(data: Analytics, ctx: Context): string {
  if (data.summary.tripCount === 0) {
    return '<p>No settled trips in this date range yet. Numbers fill in once a Morning/Evening trip is settled.</p>';
  }

  const byDate = fillDates(data.byDate, ctx);
  const markers = rangeEvents(data, byDate, ctx);
  // One color per product, shared by every product chart on the page.
  const productColor = new Map(data.byProduct.map((p, i) => [p.productId, pieColor(i)]));

  return `
    ${renderSummary(data, ctx)}

    <h2>Sales trend</h2>
    ${renderTrendStats(byDate, ctx)}
    ${renderLineChart(
      byDate.map((d) => ({ x: d.date, y: d.revenue, extra: `${d.tripCount} trip${d.tripCount === 1 ? '' : 's'}` })),
      { color: 'var(--series-1)', formatValue: moneyRound, formatAxis: moneyCompact, partialLast: ctx.partialLast, label: 'Sales per day', markers },
    )}
    ${chartMarkers(markers)}

    <div class="pie-row">
      <section>
        <h2>Sales by product</h2>
        ${renderDonut(
          data.byProduct.map((p) => ({ label: p.productName, value: p.revenue, color: productColor.get(p.productId) })),
          { formatValue: moneyCompact, centerLabel: 'Sales', label: 'Share of sales by product', maxSlices: 7 },
        )}
      </section>
      <section>
        <h2>Morning vs Evening</h2>
        ${renderDonut(
          data.bySession.map((x) => ({ label: `${x.session} · ${x.tripCount} trip${x.tripCount === 1 ? '' : 's'}`, value: x.revenue, color: x.session === 'Morning' ? 'var(--series-1)' : 'var(--series-2)' })),
          { formatValue: moneyCompact, centerLabel: 'Sales', label: 'Share of sales by session' },
        )}
      </section>
    </div>

    <h2>Sales by route</h2>
    ${renderDonut(
      data.byRoute.map((r) => ({ label: r.routeName, value: r.revenue })),
      { formatValue: moneyCompact, centerLabel: 'Sales', label: 'Share of sales by route', maxSlices: 7 },
    )}
    ${renderBarList(
      data.byRoute.map((r) => ({
        label: r.routeName,
        value: r.revenue,
        display: moneyRound(r.revenue),
        sub:
          `${r.tripCount} trip${r.tripCount === 1 ? '' : 's'}` +
          (r.shortage > 0 ? ` · short ${money(r.shortage)}` : '') +
          (r.excess > 0 ? ` · excess ${money(r.excess)}` : ''),
      })),
    )}

    <h2>Cash short per day</h2>
    ${
      data.summary.totalShortage > 0
        ? renderColumnChart(
            byDate.map((d) => ({ x: d.date, y: d.shortage })),
            { color: 'var(--color-danger)', formatValue: money, formatAxis: moneyCompact, partialLast: ctx.partialLast, label: 'Cash short per day' },
          )
        : '<p class="ok">No cash shortages in this period.</p>'
    }

    <h2>Cash discrepancies by driver</h2>
    ${renderShortShare(data.byDriver)}
    ${renderDriverTable(data.byDriver)}

    <h2>Returns</h2>
    ${renderReturns(data, byDate, ctx, productColor)}
  `;
}

/** Routes or products that started or stopped partway through the range —
 * explains steps in the sales trend (e.g. a route being closed). Only gaps of
 * three or more days at the start or end count, so a day off doesn't. */
function rangeEvents(data: Analytics, byDate: AnalyticsByDate[], ctx: Context): ChartMarker[] {
  if (byDate.length < 7) return [];
  const first = byDate[0].date;
  const last = byDate[byDate.length - (ctx.partialLast ? 2 : 1)].date; // last complete day
  const events: ChartMarker[] = [];
  const check = (name: string, firstDate: string, lastDate: string, what: 'trips' | 'sales') => {
    if (firstDate > addDays(first, 2)) {
      events.push({ after: addDays(firstDate, -1), text: `${name}: ${what === 'trips' ? 'first settled trip' : 'first sold'} on ${shortDate(firstDate)}` });
    }
    if (lastDate < addDays(last, -2)) {
      events.push({ after: lastDate, text: `${name}: ${what === 'trips' ? 'no settled trips' : 'not sold'} after ${shortDate(lastDate)}` });
    }
  };
  data.byRoute.forEach((r) => check(r.routeName, r.firstDate, r.lastDate, 'trips'));
  data.byProduct.forEach((p) => check(p.productName, p.firstDate, p.lastDate, 'sales'));
  return events.sort((a, b) => a.after.localeCompare(b.after)).slice(0, 6);
}

/** Every date from the first day with data (or the range start, if later)
 * to the range end, with zero rows for days without settled trips — so gaps
 * show as gaps instead of being silently bridged. */
function fillDates(rows: AnalyticsByDate[], ctx: Context): AnalyticsByDate[] {
  if (rows.length === 0) return rows;
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const start = rows[0].date > ctx.from ? rows[0].date : ctx.from;
  const end = ctx.partialLast ? ctx.to : ctx.to < localDateStr() ? ctx.to : addDays(localDateStr(), -1);
  const out: AnalyticsByDate[] = [];
  for (let d = start; d <= end && out.length < 1000; d = addDays(d, 1)) {
    out.push(byDate.get(d) ?? { date: d, dispatched: 0, returned: 0, cash: 0, discrepancy: 0, shortage: 0, tripCount: 0, revenue: 0 });
  }
  return out;
}

// ---- Summary cards ----------------------------------------------------------

function renderDelta(cur: number, prev: number, goodWhenUp: boolean): string {
  if (prev === 0 && cur === 0) return '<p class="stat-delta muted">No change</p>';
  if (prev === 0) return `<p class="stat-delta ${goodWhenUp ? 'good' : 'bad'}">▲ up from ₹0</p>`;
  const change = (cur - prev) / Math.abs(prev);
  if (Math.abs(change) < 0.0005) return '<p class="stat-delta muted">No change</p>';
  const up = change > 0;
  const cls = up === goodWhenUp ? 'good' : 'bad';
  return `<p class="stat-delta ${cls}">${up ? '▲' : '▼'} ${percent(Math.abs(change))}</p>`;
}

interface Totals {
  sales: number;
  cash: number;
  shortage: number;
  trips: number;
  avg: number;
}

function totalsOf(rows: AnalyticsByDate[]): Totals {
  const t = rows.reduce(
    (acc, d) => ({
      sales: acc.sales + d.revenue,
      cash: acc.cash + d.cash,
      shortage: acc.shortage + d.shortage,
      trips: acc.trips + d.tripCount,
    }),
    { sales: 0, cash: 0, shortage: 0, trips: 0 },
  );
  return { ...t, avg: t.trips > 0 ? t.sales / t.trips : 0 };
}

function renderSummary(data: Analytics, ctx: Context): string {
  const s = data.summary;
  const avg = s.tripCount > 0 ? s.totalRevenue / s.tripCount : 0;

  // Deltas compare the complete days of this range with the same number of
  // days before it — and only when that earlier window has a similar amount
  // of data; otherwise, e.g. in the app's first month, a window holding a
  // single day produces nonsense like "▲ 2900%".
  const cmp = ctx.compare;
  const curRows = cmp ? data.byDate.filter((d) => d.date <= cmp.to) : [];
  const prevDays = ctx.prev?.byDate.length ?? 0;
  const comparable =
    !!cmp && !!ctx.prev && ctx.prev.summary.tripCount > 0 && curRows.length > 0 && prevDays >= Math.max(1, curRows.length * 0.6);
  const cur = comparable ? totalsOf(curRows) : null;
  const p = comparable ? totalsOf(ctx.prev!.byDate) : null;
  const delta = (pick: (t: Totals) => number, goodWhenUp = true) =>
    cur && p ? renderDelta(pick(cur), pick(p), goodWhenUp) : '';

  const card = (label: string, value: string, extra = '', cls = '') => `
    <div class="stat-card">
      <p class="stat-label">${label}</p>
      <p class="stat-value ${cls}">${value}</p>
      ${extra}
    </div>`;

  let caption: string;
  if (!cmp) {
    caption = 'Today is still in progress, so there is no comparison until the day ends.';
  } else {
    const n = cmp.days;
    const period = `previous ${n} day${n === 1 ? '' : 's'}`;
    const span = (a: string, b: string) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);
    caption = comparable
      ? `Arrows compare ${span(ctx.from, cmp.to)}${cmp.to !== ctx.to ? ' (complete days)' : ''} with the ${period} (${span(addDays(ctx.from, -n), addDays(ctx.from, -1))}).`
      : prevDays > 0
        ? `Only ${prevDays} of the ${period} have settled trips — not enough to compare with yet.`
        : `No settled trips in the ${period} to compare with.`;
    if (ctx.partialLast) caption += ' Today is still in progress, so its figures are partial.';
  }

  return `
    <div class="stat-grid">
      ${card('Sales (amount due)', moneyRound(s.totalRevenue), delta((t) => t.sales))}
      ${card('Cash collected', moneyRound(s.totalCash), delta((t) => t.cash))}
      ${card('Cash short', money(s.totalShortage), delta((t) => t.shortage, false), s.totalShortage > 0 ? 'warn' : 'ok')}
      ${card('Cash excess', money(s.totalExcess))}
      ${card('Trips settled', String(s.tripCount), delta((t) => t.trips))}
      ${card('Avg sales / trip', moneyRound(avg), delta((t) => t.avg))}
    </div>
    <p class="caption">${caption}</p>
  `;
}

function renderTrendStats(byDate: AnalyticsByDate[], ctx: Context): string {
  const complete = ctx.partialLast ? byDate.slice(0, -1) : byDate;
  if (complete.length < 2) return '';
  let hi = complete[0];
  let lo = complete[0];
  complete.forEach((d) => {
    if (d.revenue > hi.revenue) hi = d;
    if (d.revenue < lo.revenue) lo = d;
  });
  const avg = complete.reduce((sum, d) => sum + d.revenue, 0) / complete.length;
  return `<p class="chart-stats">Highest <strong>${moneyRound(hi.revenue)}</strong> on ${shortDate(hi.date)} · Lowest <strong>${moneyRound(lo.revenue)}</strong> on ${shortDate(lo.date)} · Average <strong>${moneyRound(avg)}</strong> a day</p>`;
}

// ---- Drivers ------------------------------------------------------------------

/** Who the missing cash went missing with — only when more than one driver
 * was short, otherwise the table says it all. */
function renderShortShare(drivers: AnalyticsByDriver[]): string {
  const short = drivers.filter((d) => d.shortage > 0);
  if (short.length < 2) return '';
  return `<h3>Share of cash short</h3>
    ${renderDonut(
      short.map((d) => ({ label: d.driver, value: d.shortage })),
      { formatValue: money, centerLabel: 'Short', label: 'Share of cash short by driver' },
    )}`;
}

function renderDriverTable(drivers: AnalyticsByDriver[]): string {
  const withIssues = drivers.filter((d) => d.shortage > 0 || d.excess > 0);
  if (withIssues.length === 0) return '<p class="ok">Every settled trip in this range balanced exactly.</p>';
  return `
    <table class="line-items driver-table">
      <thead><tr><th>Driver</th><th class="num">Short</th><th class="num">Excess</th><th class="num">Net</th></tr></thead>
      <tbody>
        ${withIssues
          .map(
            (d) => `
          <tr>
            <td>${escapeHtml(d.driver)}<span class="sub">${d.tripCount} trip${d.tripCount === 1 ? '' : 's'}</span></td>
            <td class="num ${d.shortage > 0 ? 'warn' : ''}">${money(d.shortage)}<span class="sub">${d.shortTrips > 0 ? `${d.shortTrips} trip${d.shortTrips === 1 ? '' : 's'}` : '—'}</span></td>
            <td class="num">${money(d.excess)}</td>
            <td class="num ${d.discrepancy < 0 ? 'warn' : ''}">${money(d.discrepancy)}</td>
          </tr>
        `,
          )
          .join('')}
      </tbody>
    </table>
  `;
}

// ---- Returns ------------------------------------------------------------------

function valueRate(returned: number, dispatched: number): number {
  return dispatched > 0 ? returned / dispatched : 0;
}

function renderReturns(data: Analytics, byDate: AnalyticsByDate[], ctx: Context, productColor: Map<string, string>): string {
  const s = data.summary;
  const overall = valueRate(s.totalReturned, s.totalDispatched);
  // "High" = clearly worse than the business as a whole, not a fixed cut-off:
  // at least 1.5× the overall rate and at least 5%. "Above"/"below" = 20%+
  // away from it; the same cut-offs as the "× average" wording.
  const tone = (rate: number): RateRow['tone'] =>
    rate >= 0.05 && rate >= overall * 1.5
      ? 'high'
      : overall > 0 && rate >= overall * 1.2
        ? 'above'
        : overall > 0 && rate <= overall * 0.8
          ? 'below'
          : 'normal';
  const vsAverage = (rate: number) => {
    if (overall <= 0) return '';
    const ratio = rate / overall;
    return ratio >= 1.2 ? ` · ${ratio.toFixed(1)}× average` : ratio <= 0.8 ? ' · below average' : ' · about average';
  };

  const products = [...data.byProduct].sort(
    (a, b) => valueRate(b.returnedValue, b.dispatchedValue) - valueRate(a.returnedValue, a.dispatchedValue),
  );
  const routes = [...data.byRoute].sort((a, b) => valueRate(b.returned, b.dispatched) - valueRate(a.returned, a.dispatched));

  const perDay: SeriesPoint[] = byDate
    .filter((d) => d.dispatched > 0 || (ctx.partialLast && d === byDate[byDate.length - 1]))
    .map((d) => ({ x: d.date, y: valueRate(d.returned, d.dispatched) }));

  return `
    <p class="chart-stats">Overall, <strong>${percent(overall)}</strong> of stock sent out (by value, ${moneyRound(s.totalReturned)}) came back.</p>
    ${renderReturnsCallout(products, s.totalReturned, s.totalDispatched)}

    <h3>Where the returned value comes from</h3>
    ${renderDonut(
      data.byProduct.map((p) => ({ label: p.productName, value: p.returnedValue, color: productColor.get(p.productId) })),
      { formatValue: moneyCompact, centerLabel: 'Returned', label: 'Share of returned value by product', maxSlices: 7 },
    )}

    <h3>Returns per day (% of value sent out)</h3>
    ${renderLineChart(perDay, { color: 'var(--series-2)', formatValue: percent, formatAxis: percent, partialLast: ctx.partialLast, label: 'Return rate per day' })}

    <h3>Return rate by product</h3>
    ${renderRateList(
      products.map((p) => {
        const rate = valueRate(p.returnedValue, p.dispatchedValue);
        return {
          label: p.productName,
          rate,
          tone: tone(rate),
          sub: `${qty(p.qtyReturned)} of ${qty(p.qtyDispatched)} came back · ${moneyRound(p.returnedValue)}${vsAverage(rate)}`,
        };
      }),
      { average: overall, averageLabel: 'Average' },
    )}

    <h3>Return rate by route</h3>
    ${renderRateList(
      routes.map((r) => {
        const rate = valueRate(r.returned, r.dispatched);
        return {
          label: r.routeName,
          rate,
          tone: tone(rate),
          sub: `${moneyRound(r.returned)} of ${moneyRound(r.dispatched)} came back${vsAverage(rate)}`,
        };
      }),
      { average: overall, averageLabel: 'Average' },
    )}

    <h3>Returns by route and product</h3>
    ${renderRouteProductReturns(data, products)}
  `;
}

function qty(n: number): string {
  return n.toLocaleString('en-IN');
}

/** Calls out the single product whose returns stand out most against the rest
 * of the range, e.g. "Curd: 15% returned — 3× everything else (5%)". */
function renderReturnsCallout(products: AnalyticsByProduct[], totalReturned: number, totalDispatched: number): string {
  let best: { name: string; rate: number; rest: number; ratio: number } | null = null;
  products.forEach((p) => {
    const rate = valueRate(p.returnedValue, p.dispatchedValue);
    const rest = valueRate(totalReturned - p.returnedValue, totalDispatched - p.dispatchedValue);
    const ratio = rest > 0 ? rate / rest : 0;
    if (rate >= 0.05 && ratio >= 1.5 && (!best || ratio > best.ratio)) best = { name: p.productName, rate, rest, ratio };
  });
  if (!best) return '';
  const b = best as { name: string; rate: number; rest: number; ratio: number };
  return `<p class="callout"><strong>${escapeHtml(b.name)}</strong> comes back ${percent(b.rate)} of the time — ${b.ratio.toFixed(1)}× everything else (${percent(b.rest)}). The route-by-product table at the end shows where.</p>`;
}

/** Each product's return rate on each route, shaded where a route returns a
 * product clearly more than the other routes do — the place to send less.
 * The worst of those are listed first as hot spots. */
function renderRouteProductReturns(data: Analytics, products: AnalyticsByProduct[]): string {
  if (data.byRouteProduct.length === 0 || data.byRoute.length < 2) return '<p class="muted">Needs at least two routes.</p>';
  const routes = [...data.byRoute].sort((a, b) => a.routeName.localeCompare(b.routeName, undefined, { numeric: true }));
  const cells = new Map(data.byRouteProduct.map((c) => [`${c.routeId}|${c.productId}`, c]));

  // A cell compared with the same product on every other route.
  const compare = (p: AnalyticsByProduct, routeId: string) => {
    const c = cells.get(`${routeId}|${p.productId}`);
    if (!c || c.dispatchedValue <= 0) return null;
    const rate = valueRate(c.returnedValue, c.dispatchedValue);
    const others = valueRate(p.returnedValue - c.returnedValue, p.dispatchedValue - c.dispatchedValue);
    const ratio = others > 0 ? rate / others : rate > 0 ? Infinity : 1;
    // Extra money back compared with what the other routes' rate would give.
    const extra = c.returnedValue - c.dispatchedValue * others;
    return { c, rate, others, ratio, extra };
  };
  const heat = (ratio: number, rate: number) => (rate < 0.03 ? 0 : ratio >= 2 ? 3 : ratio >= 1.5 ? 2 : ratio >= 1.25 ? 1 : 0);

  const hot = products
    .flatMap((p) => routes.map((r) => ({ p, r, x: compare(p, r.routeId) })))
    .filter((h) => h.x && heat(h.x.ratio, h.x.rate) >= 2 && h.x.extra > 0)
    .sort((a, b) => b.x!.extra - a.x!.extra)
    .slice(0, 3);

  const hotHtml = hot.length
    ? `<ul class="hotspots">${hot
        .map(
          ({ p, r, x }) =>
            `<li><strong>${escapeHtml(r.routeName)} · ${escapeHtml(p.productName)}</strong>: ${percent(x!.rate)} comes back, vs ${percent(x!.others)} on other routes
             <br><span class="muted">${qty(x!.c.qtyReturned)} of ${qty(x!.c.qtyDispatched)} returned · about ${moneyRound(x!.extra)} more than usual — send this route less</span></li>`,
        )
        .join('')}</ul>`
    : '<p class="ok">No route returns any product much more than the others do.</p>';

  const row = (p: AnalyticsByProduct) => {
    const all = valueRate(p.returnedValue, p.dispatchedValue);
    return `<tr><td>${escapeHtml(p.productName)}</td><td class="num all">${percent(all)}</td>${routes
      .map((r) => {
        const x = compare(p, r.routeId);
        if (!x) return '<td class="num muted">—</td>';
        const h = heat(x.ratio, x.rate);
        const tip = `${r.routeName} · ${p.productName}: ${percent(x.rate)} (${qty(x.c.qtyReturned)} of ${qty(x.c.qtyDispatched)}) · other routes ${percent(x.others)}`;
        return `<td class="num${h ? ` heat-${h}` : ''}" data-tooltip="${escapeHtml(tip)}">${percent(x.rate)}</td>`;
      })
      .join('')}</tr>`;
  };
  const totals = `<tr class="totals"><td>All products</td><td class="num all">${percent(valueRate(data.summary.totalReturned, data.summary.totalDispatched))}</td>${routes
    .map((r) => `<td class="num">${percent(valueRate(r.returned, r.dispatched))}</td>`)
    .join('')}</tr>`;

  return `
    ${hotHtml}
    <div class="table-scroll">
      <table class="line-items heatmap">
        <thead><tr><th>Product</th><th class="num all">All</th>${routes.map((r) => `<th class="num">${escapeHtml(r.routeName)}</th>`).join('')}</tr></thead>
        <tbody>${products.map(row).join('')}${totals}</tbody>
      </table>
    </div>
    <p class="heat-key"><span class="k1">1.25× other routes</span><span class="k2">1.5×</span><span class="k3">2× or more</span></p>
  `;
}
