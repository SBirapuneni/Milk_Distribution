export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Dates ------------------------------------------------------------
// The business runs on India time, so "today" is India's date whatever the
// device's timezone (a phone set to another timezone, or the owner checking
// from abroad, must still see today's trips and shop orders). All dates are
// 'yyyy-MM-dd' strings; arithmetic is done on the calendar date (UTC), never
// on the device's local clock.

export const BUSINESS_TZ = 'Asia/Kolkata';

const businessParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Current date and time in India. */
export function businessNow(): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(businessParts.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** Today's date in India, 'yyyy-MM-dd'. */
export function localDateStr(): string {
  return businessNow().date;
}

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y, m, d];
}

function fromUtc(t: Date): string {
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = ymd(date);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + n)));
}

/** First day of the month `offset` months from `date`'s month. */
export function monthStart(date: string, offset = 0): string {
  const [y, m] = ymd(date);
  return fromUtc(new Date(Date.UTC(y, m - 1 + offset, 1)));
}

export function daysAgoStr(n: number): string {
  return addDays(localDateStr(), -n);
}

/** Inclusive number of days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  const [y1, m1, d1] = ymd(from);
  const [y2, m2, d2] = ymd(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) + 1;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-27' → '27 Sep' (or '27 Sep 2026' with withYear). */
export function shortDate(date: string, withYear = false): string {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return String(date);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

// ---- Numbers ----------------------------------------------------------

const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function signed(v: number, body: string): string {
  return v < 0 ? `−${body}` : body;
}

/** Exact amount, Indian digit grouping: ₹15,69,284 or ₹52.50. Blank → '—'. */
export function money(n: number | string | '' | null | undefined): string {
  if (n === '' || n === null || n === undefined) return '—';
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const abs = Math.abs(v);
  return signed(v, `₹${Number.isInteger(abs) ? inr0.format(abs) : inr2.format(abs)}`);
}

/** Rounded to the rupee — for totals and summaries where paise are noise. */
export function moneyRound(n: number): string {
  const v = Math.round(Number(n) || 0);
  return signed(v, `₹${inr0.format(Math.abs(v))}`);
}

/** Short form for chart axes: ₹950, ₹12K, ₹1.5L, ₹2.3Cr. */
export function moneyCompact(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number, unit: string) => `₹${Number(v.toFixed(v < 10 ? 1 : 0))}${unit}`;
  let body: string;
  if (abs >= 1e7) body = fmt(abs / 1e7, 'Cr');
  else if (abs >= 1e5) body = fmt(abs / 1e5, 'L');
  else if (abs >= 1e3) body = fmt(abs / 1e3, 'K');
  else body = `₹${Math.round(abs)}`;
  return signed(n, body);
}

export function percent(fraction: number): string {
  const p = fraction * 100;
  return `${p !== 0 && Math.abs(p) < 10 ? p.toFixed(1) : Math.round(p)}%`;
}
