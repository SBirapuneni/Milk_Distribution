#!/usr/bin/env node
// Converts CSV exports of the old Google Sheet into one SQL file that loads
// everything into the Supabase database.
//
// 1. In the Google Sheet, for each tab (Products, Routes, Trips, TripItems,
//    and Shops / Indents if you have them): File > Download > Comma
//    Separated Values. Put the files in one folder, named after the tab
//    (Products.csv, Routes.csv, ...).
// 2. node scripts/import-from-sheets.mjs <folder> [--dates=dmy|mdy]
//    → writes <folder>/import.sql and prints a summary.
// 3. Run import.sql in the Supabase SQL editor (or psql). It runs in one
//    transaction: either everything loads or nothing does. Safe to re-run:
//    rows that already exist are skipped.
//
// Shops keep their PINs: the old PIN hashes are imported and upgraded on
// each shop's first login.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const datesArg = (args.find((a) => a.startsWith('--dates=')) || '').split('=')[1];
if (!dir) {
  console.error('Usage: node scripts/import-from-sheets.mjs <folder-with-csv-files> [--dates=dmy|mdy]');
  process.exit(1);
}

// ---- CSV ---------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/^﻿/, ''));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

function readTab(name, required) {
  const file = fs.readdirSync(dir).find((f) => f.toLowerCase() === `${name.toLowerCase()}.csv` || f.toLowerCase().endsWith(` - ${name.toLowerCase()}.csv`));
  if (!file) {
    if (required) {
      console.error(`Missing ${name}.csv in ${dir}`);
      process.exit(1);
    }
    return [];
  }
  return parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'));
}

// ---- Values ----------------------------------------------------------------
// CSV exports contain the *displayed* values, so dates follow the Sheet's
// locale (28/09/2026 or 9/28/2026) and numbers may carry commas or ₹.

const warnings = [];

function num(v, { blankAsNull = false } = {}) {
  const s = String(v ?? '').replace(/[₹,\s]/g, '');
  if (s === '') return blankAsNull ? null : 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Not a number: "${v}"`);
  return n;
}

function bool(v) {
  return String(v).trim().toUpperCase() !== 'FALSE';
}

function phone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

let dateOrder = datesArg; // 'dmy' | 'mdy' | undefined → detect

function detectDateOrder(values) {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = String(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
  }
  if (dmy && mdy) throw new Error('Dates use both day-first and month-first formats; fix the Sheet or pass --dates=dmy|mdy');
  return dmy ? 'dmy' : mdy ? 'mdy' : null;
}

function date(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    if (!dateOrder) throw new Error(`Can't tell whether "${s}" is day/month or month/day — re-run with --dates=dmy or --dates=mdy`);
    const [d, mo] = dateOrder === 'dmy' ? [m[1], m[2]] : [m[2], m[1]];
    return `${m[3]}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  throw new Error(`Not a date: "${s}"`);
}

/** Timestamp (date + optional time) as ISO in India time, or null. */
function timestamp(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  try {
    const d = date(s);
    const t = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    let h = t ? Number(t[1]) : 0;
    if (t && t[4]) h = (h % 12) + (t[4].toUpperCase() === 'PM' ? 12 : 0);
    return `${d} ${String(h).padStart(2, '0')}:${t ? t[2] : '00'}:${t && t[3] ? t[3] : '00'}+05:30`;
  } catch {
    return null;
  }
}

function sql(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inserts(table, columns, rows) {
  if (rows.length === 0) return '';
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    out.push(
      `insert into app.${table} (${columns.join(', ')}) values\n` +
        chunk.map((r) => `  (${columns.map((c) => sql(r[c])).join(', ')})`).join(',\n') +
        `\non conflict do nothing;`,
    );
  }
  return out.join('\n\n');
}

// ---- Load ------------------------------------------------------------------

const products = readTab('Products', true);
const routes = readTab('Routes', true);
const trips = readTab('Trips', true);
const tripItems = readTab('TripItems', true);
const shops = readTab('Shops', false);
const indents = readTab('Indents', false);

if (!dateOrder) {
  dateOrder = detectDateOrder([...trips.map((t) => t.Date), ...indents.map((o) => o.Date)]) ?? undefined;
}

const base = Date.parse('2020-01-01T00:00:00Z');
const createdAt = (i) => new Date(base + i * 1000).toISOString(); // keeps the Sheet's order

const productRows = products
  .filter((p) => p.ProductId)
  .map((p, i) => ({ id: p.ProductId, name: p.Name || p.ProductId, unit: p.Unit || '', price: num(p.Price), active: bool(p.Active), created_at: createdAt(i) }));
const productIds = new Set(productRows.map((p) => p.id));

const routeRows = routes
  .filter((r) => r.RouteId)
  .map((r, i) => ({
    id: r.RouteId,
    name: r.Name || r.RouteId,
    villages: r.Villages || '',
    default_vehicle: r.DefaultVehicle || '',
    default_driver: r.DefaultDriver || '',
    active: bool(r.Active),
    created_at: createdAt(i),
  }));
const routeIds = new Set(routeRows.map((r) => r.id));

const seenPhones = new Set();
const shopRows = [];
for (const s of shops.filter((s) => s.ShopId)) {
  const ph = phone(s.Phone);
  if (!ph) warnings.push(`Shop ${s.Name}: no valid phone number — skipped`);
  else if (seenPhones.has(ph)) warnings.push(`Shop ${s.Name}: phone ${ph} already used by another shop — skipped`);
  else if (!routeIds.has(s.RouteId)) warnings.push(`Shop ${s.Name}: unknown route ${s.RouteId} — skipped`);
  else {
    seenPhones.add(ph);
    shopRows.push({
      id: s.ShopId,
      name: s.Name || s.ShopId,
      owner_name: s.OwnerName || '',
      phone: ph,
      route_id: s.RouteId,
      active: bool(s.Active),
      legacy_pin_hash: s.PinHash || null,
      legacy_pin_salt: s.PinSalt || null,
      created_at: timestamp(s.CreatedAt) ?? createdAt(0),
    });
  }
}
const shopIds = new Set(shopRows.map((s) => s.id));

const tripKeys = new Set();
const tripRows = [];
for (const t of trips.filter((t) => t.TripId)) {
  try {
    if (!routeIds.has(t.RouteId)) throw new Error(`unknown route ${t.RouteId}`);
    if (t.Session !== 'Morning' && t.Session !== 'Evening') throw new Error(`session "${t.Session}"`);
    const d = date(t.Date);
    const key = `${t.RouteId}|${d}|${t.Session}`;
    if (tripKeys.has(key)) throw new Error(`duplicate ${t.Session} trip for this route on ${d}`);
    tripKeys.add(key);
    tripRows.push({
      id: t.TripId,
      date: d,
      session: t.Session,
      route_id: t.RouteId,
      driver: t.Driver || '',
      vehicle: t.Vehicle || '',
      status: t.Status === 'Settled' ? 'Settled' : 'Dispatched',
      dispatched_total: num(t.DispatchedTotal),
      returned_total: num(t.ReturnedTotal, { blankAsNull: true }),
      amount_due: num(t.AmountDue, { blankAsNull: true }),
      cash_handed_over: num(t.CashHandedOver, { blankAsNull: true }),
      discrepancy: num(t.Discrepancy, { blankAsNull: true }),
      created_at: timestamp(t.CreatedAt) ?? `${d} 06:00:00+05:30`,
      settled_at: timestamp(t.SettledAt),
      dispatched_by: t.DispatchedBy || '',
      settled_by: t.SettledBy || '',
      reopened_by: t.ReopenedBy || '',
      reopened_at: timestamp(t.ReopenedAt),
    });
  } catch (e) {
    warnings.push(`Trip ${t.TripId}: ${e.message} — skipped`);
  }
}
const tripIds = new Set(tripRows.map((t) => t.id));

const itemKeys = new Set();
const itemRows = [];
for (const i of tripItems.filter((i) => i.TripItemId)) {
  if (!tripIds.has(i.TripId)) {
    warnings.push(`Trip item ${i.TripItemId}: trip ${i.TripId} not imported — skipped`);
    continue;
  }
  if (!productIds.has(i.ProductId)) {
    warnings.push(`Trip item ${i.TripItemId}: unknown product ${i.ProductId} — skipped`);
    continue;
  }
  const key = `${i.TripId}|${i.ProductId}`;
  if (itemKeys.has(key)) {
    warnings.push(`Trip item ${i.TripItemId}: product listed twice on trip ${i.TripId} — skipped`);
    continue;
  }
  itemKeys.add(key);
  const qd = num(i.QtyDispatched);
  let qr = num(i.QtyReturned);
  if (qr > qd) {
    warnings.push(`Trip item ${i.TripItemId}: returned ${qr} > dispatched ${qd} — capped at ${qd}`);
    qr = qd;
  }
  const price = num(i.Price);
  itemRows.push({
    id: i.TripItemId,
    trip_id: i.TripId,
    product_id: i.ProductId,
    price,
    qty_dispatched: qd,
    qty_returned: qr,
    dispatched_value: i.DispatchedValue !== '' ? num(i.DispatchedValue) : qd * price,
    returned_value: i.ReturnedValue !== '' ? num(i.ReturnedValue) : qr * price,
  });
}

const indentKeys = new Set();
const indentRows = [];
for (const o of indents.filter((o) => o.IndentId)) {
  try {
    if (!shopIds.has(o.ShopId)) throw new Error(`shop ${o.ShopId} not imported`);
    const d = date(o.Date);
    const key = `${o.ShopId}|${d}|${o.Session}`;
    if (indentKeys.has(key)) throw new Error('duplicate order');
    indentKeys.add(key);
    const items = JSON.parse(o.Items || '[]').filter((x) => productIds.has(x.productId) && Number(x.qty) > 0);
    indentRows.push({
      id: o.IndentId,
      date: d,
      session: o.Session,
      shop_id: o.ShopId,
      route_id: routeIds.has(o.RouteId) ? o.RouteId : shopRows.find((s) => s.id === o.ShopId).route_id,
      items: JSON.stringify(items),
      total: num(o.Total),
      updated_at: timestamp(o.UpdatedAt) ?? `${d} 00:00:00+05:30`,
    });
  } catch (e) {
    warnings.push(`Order ${o.IndentId}: ${e.message} — skipped`);
  }
}

// ---- Write -------------------------------------------------------------------

const out = [
  '-- Generated by scripts/import-from-sheets.mjs. Run once in the Supabase SQL editor.',
  'begin;',
  inserts('products', ['id', 'name', 'unit', 'price', 'active', 'created_at'], productRows),
  inserts('routes', ['id', 'name', 'villages', 'default_vehicle', 'default_driver', 'active', 'created_at'], routeRows),
  inserts('shops', ['id', 'name', 'owner_name', 'phone', 'route_id', 'active', 'legacy_pin_hash', 'legacy_pin_salt', 'created_at'], shopRows),
  inserts(
    'trips',
    ['id', 'date', 'session', 'route_id', 'driver', 'vehicle', 'status', 'dispatched_total', 'returned_total', 'amount_due',
      'cash_handed_over', 'discrepancy', 'created_at', 'settled_at', 'dispatched_by', 'settled_by', 'reopened_by', 'reopened_at'],
    tripRows,
  ),
  inserts('trip_items', ['id', 'trip_id', 'product_id', 'price', 'qty_dispatched', 'qty_returned', 'dispatched_value', 'returned_value'], itemRows),
  inserts('indents', ['id', 'date', 'session', 'shop_id', 'route_id', 'items', 'total', 'updated_at'], indentRows),
  'commit;',
  '',
]
  .filter(Boolean)
  .join('\n\n');

const outFile = path.join(dir, 'import.sql');
fs.writeFileSync(outFile, out);

console.log(`Wrote ${outFile}`);
console.log(
  `  ${productRows.length} products, ${routeRows.length} routes, ${shopRows.length} shops, ` +
    `${tripRows.length} trips, ${itemRows.length} trip items, ${indentRows.length} shop orders` +
    (dateOrder ? `  (dates read as ${dateOrder === 'dmy' ? 'day/month' : 'month/day'}/year)` : ''),
);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log(`  - ${w}`));
}
