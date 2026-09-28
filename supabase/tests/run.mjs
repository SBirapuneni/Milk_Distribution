#!/usr/bin/env node
// Database tests: starts a throwaway Postgres in Docker, loads the
// migrations, and exercises every API function the way the app calls them
// (as Supabase's `anon` role). Needs Docker. Usage: node supabase/tests/run.mjs

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTAINER = 'milk-db-test';
const sh = (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ---- Database -------------------------------------------------------------

function psql(sqlText, { asAnon = false } = {}) {
  const full = (asAnon ? 'set role anon;\n' : '') + sqlText;
  const r = sh('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], full);
  if (r.status !== 0) {
    const msg = (r.stderr.match(/ERROR:\s+(.*)/) || [])[1] || r.stderr.trim();
    const hint = (r.stderr.match(/HINT:\s+(.*)/) || [])[1];
    const err = new Error(msg);
    err.hint = hint;
    throw err;
  }
  return r.stdout.trim();
}

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** Calls a public API function as the anon role, exactly like the app does. */
function api(fn, payload = {}, token) {
  const args = token === undefined ? `${lit(JSON.stringify(payload))}::jsonb` : `${lit(token)}, ${lit(JSON.stringify(payload))}::jsonb`;
  const out = psql(`select public.${fn}(${args});`, { asAnon: true });
  return JSON.parse(out);
}

function apiError(fn, payload, token) {
  try {
    api(fn, payload, token);
  } catch (e) {
    return e;
  }
  throw new Error(`${fn} was expected to fail`);
}

/** Pretend the business clock says `ts` (local time). */
function setClock(ts) {
  psql(`create or replace function app.local_now() returns timestamp language sql stable as $$ select ${lit(ts)}::timestamp $$;`);
}

let passed = 0;
function ok(name) {
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// ---- Start Postgres --------------------------------------------------------

sh('docker', ['rm', '-f', CONTAINER]);
const run = sh('docker', ['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=test', 'postgres:16-alpine']);
if (run.status !== 0) {
  console.error('Could not start Postgres in Docker. Is Docker running?\n' + run.stderr);
  process.exit(1);
}
try {
  for (let i = 0; i < 60; i++) {
    if (sh('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres']).status === 0 && psql('select 1') === '1') break;
    sh('sleep', ['1']);
  }

  // Supabase's API roles, so the migrations' grants apply as in production.
  psql(`create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;`);
  for (const f of fs.readdirSync(path.join(root, 'supabase/migrations')).sort()) {
    psql(fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'));
  }
  ok('migrations load');

  // ---- Lock-down ------------------------------------------------------------
  assert.match(apiErrorSql('select count(*) from app.staff'), /permission denied/);
  assert.match(apiErrorSql("select app.create_admin('x','9000000000','123456')"), /permission denied/);
  ok('anon cannot read app tables or call internal functions');

  // ---- Staff logins ---------------------------------------------------------
  psql(`select app.create_admin('Owner', '+91 90000 00009', '999999');`);
  assert.equal(api('staff_login', { phone: '9000000009', pin: '000000' }).error, 'Incorrect phone number or PIN.');
  assert.equal(api('staff_login', { phone: '9999999999', pin: '999999' }).error, 'Incorrect phone number or PIN.');
  const owner = api('staff_login', { phone: '09000000009', pin: '999999' });
  assert.equal(owner.ok, true);
  assert.equal(owner.staff.role, 'admin');
  assert.deepEqual(owner.master.products, []);
  const A = owner.token;
  ok('admin created in SQL can log in; wrong PIN and unknown phone get the same message');

  assert.equal(apiError('get_master_data', {}, 'not-a-token').hint, 'relogin');
  ok('bad session token → "log in again" (hint relogin)');

  // ---- Master data ------------------------------------------------------------
  const P1 = api('save_product', { name: 'Toned Milk', unit: 'l', price: 52, active: true }, A).productId;
  const P2 = api('save_product', { name: 'Curd', unit: 'pk', price: 40, active: true }, A).productId;
  const P3 = api('save_product', { name: 'Old Butter', unit: 'pk', price: 55, active: false }, A).productId;
  const R1 = api('save_route', { name: 'Route 1', defaultDriver: 'Ramesh', active: true }, A).routeId;
  const R2 = api('save_route', { name: 'Route 2', active: true }, A).routeId;
  assert.match(apiError('save_product', { name: 'X', price: -1 }, A).message, /positive number/);
  let m = api('save_product', { productId: P1, name: 'Toned Milk', unit: 'litre', price: 54, active: true }, A);
  assert.equal(m.products.find((p) => p.ProductId === P1).Price, 54);
  ok('products and routes save; updates return fresh master data');

  // ---- Staff management -------------------------------------------------------
  const newStaff = api('save_staff', { name: 'Ravi', phone: '9000000008', role: 'staff', active: true }, A);
  assert.match(newStaff.pin, /^\d{6}$/);
  assert.ok(!JSON.stringify(newStaff.staff).includes('pin'));
  const S = api('staff_login', { phone: '9000000008', pin: newStaff.pin }).token;
  assert.ok(S);
  assert.match(apiError('save_staff', { name: 'Dup', phone: '9000000008' }, A).message, /already uses/);
  assert.match(apiError('save_staff', { staffId: owner.staff.id, name: 'Owner', phone: '9000000009', role: 'staff' }, A).message, /own admin/);
  ok('admin adds staff (PIN shown once, hashes never returned); duplicate phone and self-demotion blocked');

  assert.match(apiError('save_product', { name: 'Y', price: 1 }, S).message, /Only an admin/);
  assert.match(apiError('save_shop', {}, S).message, /Only an admin/);
  assert.deepEqual(api('get_master_data', {}, S).staff, []);
  ok('non-admin staff cannot manage master data or see the staff list');

  for (let i = 0; i < 5; i++) api('staff_login', { phone: '9000000008', pin: '000000' });
  assert.match(api('staff_login', { phone: '9000000008', pin: newStaff.pin }).error, /Too many wrong PINs/);
  assert.equal(api('staff_login', { phone: '9000000009', pin: '999999' }).ok, true);
  const newPin = api('reset_staff_pin', { staffId: newStaff.staffId }, A).pin;
  const S2 = api('staff_login', { phone: '9000000008', pin: newPin }).token;
  assert.ok(S2);
  assert.equal(apiError('get_master_data', {}, S).hint, 'relogin');
  ok('5 wrong PINs lock only that person; New PIN unlocks and ends their old sessions');

  // ---- Trips --------------------------------------------------------------------
  const d0 = '2026-09-28';
  let trip = api('dispatch_trip', { routeId: R1, date: d0, session: 'Morning', driver: 'Ramesh', vehicle: 'KA01', items: [{ productId: P1, qty: 10 }, { productId: P2, qty: 5 }, { productId: P3, qty: 0 }] }, S2);
  assert.equal(trip.trip.DispatchedTotal, 10 * 54 + 5 * 40);
  assert.equal(trip.trip.DispatchedBy, 'Ravi');
  assert.equal(trip.trip.ReturnedTotal, '');
  assert.equal(trip.items.length, 2);
  const T1 = trip.trip.TripId;
  ok('dispatch records totals at current prices and who dispatched');

  assert.match(apiError('dispatch_trip', { routeId: R1, date: d0, session: 'Morning', items: [{ productId: P1, qty: 1 }] }, S2).message, /already has a Morning trip/);
  assert.match(apiError('dispatch_trip', { routeId: R1, date: '28/09/2026', session: 'Evening', items: [{ productId: P1, qty: 1 }] }, S2).message, /yyyy-MM-dd/);
  assert.match(apiError('dispatch_trip', { routeId: R1, date: d0, session: 'Evening', items: [{ productId: 'nope', qty: 1 }] }, S2).message, /Unknown product/);
  assert.match(apiError('dispatch_trip', { routeId: R1, date: d0, session: 'Evening', items: [] }, S2).message, /At least one product/);
  ok('duplicate trip, bad date, unknown product and empty dispatch rejected');

  assert.match(apiError('save_trip_progress', { tripId: T1, items: [{ productId: P1, qtyReturned: 2 }, { productId: P2, qtyReturned: 99 }], cashHandedOver: 1 }, S2).message, /exceeds/);
  assert.equal(psql(`select sum(qty_returned) from app.trip_items where trip_id = ${lit(T1)}`), '0.000');
  ok('invalid return quantity writes nothing');

  trip = api('settle_trip', { tripId: T1, items: [{ productId: P1, qtyReturned: 2 }], cashHandedOver: 500 }, S2);
  assert.equal(trip.trip.Status, 'Settled');
  assert.equal(trip.trip.AmountDue, 740 - 108);
  assert.equal(trip.trip.Discrepancy, 500 - 632);
  assert.equal(trip.trip.SettledBy, 'Ravi');
  assert.match(apiError('settle_trip', { tripId: T1, items: [], cashHandedOver: 0 }, S2).message, /already settled/);
  ok('settle computes amount due and discrepancy, records who settled, and can\'t run twice');

  assert.match(apiError('reopen_trip', { tripId: T1 }, S2).message, /Only an admin/);
  trip = api('reopen_trip', { tripId: T1 }, A);
  assert.equal(trip.trip.Status, 'Dispatched');
  assert.equal(trip.trip.ReopenedBy, 'Owner');
  assert.equal(trip.trip.CashHandedOver, 500);
  api('settle_trip', { tripId: T1, items: [{ productId: P1, qtyReturned: 2 }], cashHandedOver: 632 }, S2);
  ok('only admins reopen; figures kept; can be settled again');

  const T2 = api('dispatch_trip', { routeId: R1, date: d0, session: 'Evening', items: [{ productId: P1, qty: 4 }] }, S2).trip.TripId;
  let day = api('get_route_day', { routeId: R1, date: d0, fallbackSession: 'Morning' }, S2);
  assert.equal(day.session, 'Evening');
  assert.equal(day.trips.length, 2);
  assert.ok(day.trips.every((t) => t.items.length > 0));
  assert.equal(api('get_route_day', { routeId: R1, date: d0, session: 'Morning', fallbackSession: 'Evening' }, S2).session, 'Morning');
  assert.equal(api('get_route_day', { routeId: R2, date: d0, fallbackSession: 'Evening' }, S2).session, 'Evening');
  ok('route day returns both sessions with items and opens the one awaiting return');

  assert.equal(api('get_last_trip', { routeId: R1, session: 'Morning', beforeDate: '2026-09-29' }, S2).trip.TripId, T1);
  assert.equal(api('get_last_trip', { routeId: R1, session: 'Morning', beforeDate: d0 }, S2), null);
  const list = api('list_trips', { dateFrom: d0, dateTo: d0 }, S2);
  assert.equal(list.length, 2);
  assert.equal(list[0].RouteName, 'Route 1');
  const an = api('get_analytics_data', { dateFrom: d0, dateTo: d0 }, S2);
  assert.equal(an.trips.length, 1); // only settled
  assert.equal(an.items.length, 2);
  assert.equal(an.routeNames[R1], 'Route 1');
  api('settle_trip', { tripId: T2, items: [], cashHandedOver: 216 }, S2);
  ok('last trip, trip list and analytics data (settled trips only)');

  // ---- Shops ----------------------------------------------------------------------
  const shop1 = api('save_shop', { name: 'Lakshmi Stores', ownerName: 'Ravi', phone: '+91 98480-12345', routeId: R1, active: true }, A);
  assert.match(shop1.pin, /^\d{6}$/);
  assert.equal(shop1.shops[0].Phone, '9848012345');
  assert.equal(shop1.shops[0].HasPin, true);
  assert.ok(!JSON.stringify(shop1).includes('$2'));
  assert.match(apiError('save_shop', { name: 'Other', phone: '09848012345', routeId: R2 }, A).message, /already uses/);
  const shop2 = api('save_shop', { name: 'Sri Sai', phone: '9000000002', routeId: R1, active: true }, A);
  api('save_shop', { name: 'Far Shop', phone: '9000000003', routeId: R2, active: true }, A);
  ok('admin adds shops; PIN shown once; duplicate phone blocked');

  setClock('2026-09-28 08:00');
  const login = api('shop_login', { phone: '98480 12345', pin: shop1.pin });
  assert.equal(login.ok, true);
  const SH = login.token;
  assert.deepEqual(login.home.slots.map((s) => `${s.date} ${s.session}`), ['2026-09-28 Evening', '2026-09-29 Morning', '2026-09-29 Evening']);
  assert.equal(login.home.products.length, 2); // inactive product hidden
  ok('shop login at 08:00: today Evening, tomorrow Morning + Evening open; inactive products hidden');

  assert.equal(apiError('get_master_data', {}, SH).hint, 'relogin');
  assert.equal(apiError('dispatch_trip', {}, SH).hint, 'relogin');
  ok('a shop session cannot call staff functions');

  let home = api('shop_save_order', { date: '2026-09-29', session: 'Morning', items: [{ productId: P1, qty: 20 }, { productId: P2, qty: 5 }] }, SH);
  assert.equal(home.slots.find((s) => s.session === 'Morning').order.total, 20 * 54 + 5 * 40);
  api('shop_save_order', { date: '2026-09-29', session: 'Morning', items: [{ productId: P1, qty: 25 }] }, SH);
  assert.equal(psql(`select count(*) from app.indents`), '1');
  assert.match(apiError('shop_save_order', { date: '2026-09-29', session: 'Morning', items: [{ productId: P3, qty: 1 }] }, SH).message, /no longer available/);
  ok('shop order saved with total; re-saving updates the same order; inactive products rejected');

  const SH2 = api('shop_login', { phone: '9000000002', pin: shop2.pin }).token;
  api('shop_save_order', { date: '2026-09-29', session: 'Morning', items: [{ productId: P2, qty: 3 }] }, SH2);
  day = api('get_route_day', { routeId: R1, date: '2026-09-29', fallbackSession: 'Morning' }, S2);
  assert.equal(day.indents.length, 2);
  const dash = api('get_dashboard', { date: '2026-09-29' }, S2);
  const r1m = dash.orders.find((o) => o.routeId === R1 && o.session === 'Morning');
  assert.equal(r1m.ordered, 2);
  assert.equal(r1m.shops, 2);
  ok('route day and dashboard see the shop orders');

  setClock('2026-09-28 21:30');
  assert.match(apiError('shop_save_order', { date: '2026-09-29', session: 'Morning', items: [{ productId: P1, qty: 1 }] }, SH).message, /closed/);
  assert.deepEqual(api('shop_home', {}, SH).slots.map((s) => `${s.date} ${s.session}`), ['2026-09-29 Evening', '2026-09-30 Morning']);
  setClock('2026-09-29 12:01');
  assert.match(apiError('shop_save_order', { date: '2026-09-29', session: 'Evening', items: [{ productId: P1, qty: 1 }] }, SH).message, /closed/);
  assert.equal(api('shop_home', {}, SH).lastOrder.date, '2026-09-29');
  ok('cutoffs: Morning closes 9 PM the night before, Evening at noon; last order found');

  for (let i = 0; i < 5; i++) api('shop_login', { phone: '9000000002', pin: '000000' });
  assert.match(api('shop_login', { phone: '9000000002', pin: shop2.pin }).error, /Too many wrong PINs/);
  assert.equal(api('shop_login', { phone: '9848012345', pin: shop1.pin }).ok, true);
  const shop2pin = api('reset_shop_pin', { shopId: shop2.shopId }, A).pin;
  assert.equal(apiError('shop_home', {}, SH2).hint, 'relogin');
  assert.equal(api('shop_login', { phone: '9000000002', pin: shop2pin }).ok, true);
  ok('shop lock-out is per phone; New PIN unlocks and ends old sessions');

  api('save_shop', { shopId: shop1.shopId, name: 'Lakshmi Stores', phone: '9848012345', routeId: R1, active: false }, A);
  assert.equal(apiError('shop_home', {}, SH).hint, 'relogin');
  assert.equal(api('shop_login', { phone: '9848012345', pin: shop1.pin }).ok, false);
  ok('deactivating a shop logs it out and blocks login');

  // ---- Import from the Google Sheet -------------------------------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milk-import-'));
  const csv = (rows) => rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
  const salt = crypto.randomUUID();
  const legacyHash = crypto.createHash('sha256').update(`${salt}:246810`).digest('base64');
  fs.writeFileSync(path.join(dir, 'Products.csv'), csv([['ProductId', 'Name', 'Unit', 'Price', 'Active'], ['PX1', 'Buffalo Milk', 'litre', '1,080.50', 'TRUE'], ['PX2', 'Ghee', 'jar', '₹300', 'FALSE']]));
  fs.writeFileSync(path.join(dir, 'Routes.csv'), csv([['RouteId', 'Name', 'Villages', 'DefaultVehicle', 'DefaultDriver', 'Active'], ['RX1', 'Route X', 'A, B', 'AP01', 'Suresh', 'TRUE']]));
  fs.writeFileSync(path.join(dir, 'Shops.csv'), csv([['ShopId', 'Name', 'OwnerName', 'Phone', 'RouteId', 'Active', 'PinHash', 'PinSalt', 'CreatedAt'], ['SX1', 'Old Shop', 'Anil', '9111111111', 'RX1', 'TRUE', legacyHash, salt, '15/09/2026 10:00:00']]));
  fs.writeFileSync(path.join(dir, 'Trips.csv'), csv([
    ['TripId', 'Date', 'Session', 'RouteId', 'Driver', 'Vehicle', 'Status', 'DispatchedTotal', 'ReturnedTotal', 'AmountDue', 'CashHandedOver', 'Discrepancy', 'CreatedAt', 'SettledAt', 'DispatchedBy', 'SettledBy', 'ReopenedBy', 'ReopenedAt'],
    ['TX1', '27/09/2026', 'Morning', 'RX1', 'Suresh', 'AP01', 'Settled', '2161', '1080.5', '1080.5', '1000', '-80.5', '27/09/2026 05:10:00', '27/09/2026 19:00:00', 'Asha', 'Babu', '', ''],
    ['TX2', '28/09/2026', 'Morning', 'RX1', 'Suresh', 'AP01', 'Dispatched', '1080.5', '', '', '', '', '28/09/2026 05:10:00', '', 'Asha', '', '', ''],
    ['TX3', '28/09/2026', 'Morning', 'RX1', 'Dup', '', 'Dispatched', '1', '', '', '', '', '', '', '', '', '', ''],
  ]));
  fs.writeFileSync(path.join(dir, 'TripItems.csv'), csv([
    ['TripItemId', 'TripId', 'ProductId', 'Price', 'QtyDispatched', 'QtyReturned', 'DispatchedValue', 'ReturnedValue'],
    ['IX1', 'TX1', 'PX1', '1080.5', '2', '1', '2161', '1080.5'],
    ['IX2', 'TX2', 'PX1', '1080.5', '1', '0', '1080.5', '0'],
    ['IX3', 'TX9', 'PX1', '1', '1', '0', '1', '0'],
  ]));
  fs.writeFileSync(path.join(dir, 'Indents.csv'), csv([['IndentId', 'Date', 'Session', 'ShopId', 'RouteId', 'Items', 'Summary', 'Total', 'UpdatedAt'], ['IDX1', '28/09/2026', 'Evening', 'SX1', 'RX1', JSON.stringify([{ productId: 'PX1', qty: 3 }]), 'Buffalo Milk × 3', '3241.5', '27/09/2026 20:00:00']]));
  const imp = sh('node', [path.join(root, 'scripts/import-from-sheets.mjs'), dir]);
  assert.equal(imp.status, 0, imp.stderr);
  assert.match(imp.stdout, /1 routes, 1 shops, 2 trips, 2 trip items, 1 shop orders/);
  assert.match(imp.stdout, /duplicate Morning trip/);
  assert.match(imp.stdout, /trip TX9 not imported/);
  const importSql = fs.readFileSync(path.join(dir, 'import.sql'), 'utf8');
  psql(importSql);
  psql(importSql); // re-running is harmless
  assert.equal(psql(`select count(*) from app.trips where id like 'TX%'`), '2');
  assert.equal(psql(`select price from app.products where id = 'PX1'`), '1080.50');
  assert.equal(psql(`select to_char(date, 'YYYY-MM-DD') || ' ' || discrepancy from app.trips where id = 'TX1'`), '2026-09-27 -80.50');
  ok('Sheet import: day-first dates, ₹ and commas, bad rows skipped with warnings, safe to re-run');

  const legacy = api('shop_login', { phone: '9111111111', pin: '246810' });
  assert.equal(legacy.ok, true);
  assert.equal(psql(`select (pin_hash like '$2%')::text || ' ' || (legacy_pin_hash is null)::text from app.shops where id = 'SX1'`), 'true true');
  assert.equal(api('shop_login', { phone: '9111111111', pin: '246810' }).ok, true);
  ok('imported shop logs in with its old PIN, which is then upgraded to bcrypt');

  const imported = api('get_route_day', { routeId: 'RX1', date: '2026-09-28', fallbackSession: 'Morning' }, A);
  assert.equal(imported.trips[0].trip.TripId, 'TX2');
  assert.equal(imported.indents.length, 1);
  ok('imported trips and orders appear in the app');

  console.log(`\nAll ${passed} tests passed.`);
} catch (e) {
  console.error(`\nFAILED after ${passed} passing tests:\n`, e);
  process.exitCode = 1;
} finally {
  if (!process.env.KEEP_DB) sh('docker', ['rm', '-f', CONTAINER]);
}

function apiErrorSql(sqlText) {
  try {
    psql(sqlText, { asAnon: true });
  } catch (e) {
    return e.message;
  }
  return 'no error';
}
