/**
 * Milk Distribution — Apps Script backend.
 * Bind this script to the Google Sheet that stores the app's data
 * (Extensions > Apps Script from within the Sheet), paste this file in,
 * then run setup() once and deploy as a Web App.
 */

const SHEET_NAMES = {
  PRODUCTS: 'Products',
  ROUTES: 'Routes',
  TRIPS: 'Trips',
  TRIP_ITEMS: 'TripItems',
  SHOPS: 'Shops',
  INDENTS: 'Indents',
};

const HEADERS = {
  PRODUCTS: ['ProductId', 'Name', 'Unit', 'Price', 'Active'],
  ROUTES: ['RouteId', 'Name', 'Villages', 'DefaultVehicle', 'DefaultDriver', 'Active'],
  TRIPS: [
    'TripId', 'Date', 'Session', 'RouteId', 'Driver', 'Vehicle', 'Status',
    'DispatchedTotal', 'ReturnedTotal', 'AmountDue', 'CashHandedOver', 'Discrepancy',
    'CreatedAt', 'SettledAt', 'DispatchedBy', 'SettledBy', 'ReopenedBy', 'ReopenedAt',
  ],
  TRIP_ITEMS: [
    'TripItemId', 'TripId', 'ProductId', 'Price', 'QtyDispatched', 'QtyReturned', 'DispatchedValue', 'ReturnedValue',
  ],
  SHOPS: ['ShopId', 'Name', 'OwnerName', 'Phone', 'RouteId', 'Active', 'PinHash', 'PinSalt', 'CreatedAt'],
  // One row per shop per delivery (date + session). Items is JSON
  // ([{productId, qty}]) so an order is updated in place; Summary is the same
  // order in readable form for anyone looking at the Sheet.
  INDENTS: ['IndentId', 'Date', 'Session', 'ShopId', 'RouteId', 'Items', 'Summary', 'Total', 'UpdatedAt'],
};

const MIN_PASSCODE_LENGTH = 12;

// Global (not per-client — Apps Script can't see caller IPs) brute-force
// throttle: once this many wrong passcodes arrive within the window, every
// request is refused until the window passes. High enough that staff typos
// never trip it, low enough to make guessing a 12+ character passcode hopeless.
const MAX_FAILED_AUTH = 100;
const FAILED_AUTH_WINDOW_SECONDS = 600;

// Shop owners log in with phone number + PIN. Each phone gets its own
// lock-out, so guessing one shop's PIN can't lock out the others (or staff).
const SHOP_PIN_LENGTH = 6;
const MAX_FAILED_SHOP_LOGINS = 5;
const SHOP_LOCKOUT_SECONDS = 900;

// Order cutoffs, in the spreadsheet's timezone: Morning delivery on day D
// closes at 21:00 on D-1; Evening delivery on D closes at 12:00 on D.
const CUTOFFS = {
  Morning: { dayOffset: -1, time: '21:00' },
  Evening: { dayOffset: 0, time: '12:00' },
};

// Actions a logged-in shop owner may call. Everything else needs the staff
// passcode; a shop PIN can never reach them.
const SHOP_ACTIONS = {
  shopLogin: true,
  shopSaveOrder: true,
};

const WRITE_ACTIONS = {
  shopSaveOrder: true,
  saveShop: true,
  resetShopPin: true,
  saveProduct: true,
  saveRoute: true,
  dispatchTrip: true,
  saveTripProgress: true,
  settleTrip: true,
  reopenTrip: true,
};

// ---- One-time setup -------------------------------------------------

// Safe to re-run: creates missing tabs and appends any missing header
// columns (e.g. after upgrading this script) without touching existing data.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_NAMES.PRODUCTS, HEADERS.PRODUCTS);
  ensureSheet_(ss, SHEET_NAMES.ROUTES, HEADERS.ROUTES);
  ensureSheet_(ss, SHEET_NAMES.TRIPS, HEADERS.TRIPS);
  ensureSheet_(ss, SHEET_NAMES.TRIP_ITEMS, HEADERS.TRIP_ITEMS);
  ensureSheet_(ss, SHEET_NAMES.SHOPS, HEADERS.SHOPS);
  ensureSheet_(ss, SHEET_NAMES.INDENTS, HEADERS.INDENTS);
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }
  const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missing = headers.filter((h) => existing.indexOf(h) === -1);
  if (missing.length > 0) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
}

// Edit the token below, then run this function once (Run menu) to store
// your shared passcode. It never needs to be committed to source control.
function setAppToken() {
  const token = 'REPLACE_WITH_YOUR_PASSCODE';
  if (token === 'REPLACE_WITH_YOUR_PASSCODE' || token.length < MIN_PASSCODE_LENGTH) {
    throw new Error('Pick a passcode of at least ' + MIN_PASSCODE_LENGTH + ' characters (a few words works well).');
  }
  PropertiesService.getScriptProperties().setProperty('APP_TOKEN', token);
}

// Separate passcode, known only to the owner, required to reopen a settled
// trip. Reopening stays disabled until this has been run.
function setAdminToken() {
  const token = 'REPLACE_WITH_YOUR_ADMIN_PASSCODE';
  if (token === 'REPLACE_WITH_YOUR_ADMIN_PASSCODE' || token.length < MIN_PASSCODE_LENGTH) {
    throw new Error('Pick an admin passcode of at least ' + MIN_PASSCODE_LENGTH + ' characters.');
  }
  PropertiesService.getScriptProperties().setProperty('ADMIN_TOKEN', token);
}

// ---- HTTP entry points -----------------------------------------------

function doGet() {
  return ContentService.createTextOutput('Milk Distribution API is running.');
}

function doPost(e) {
  let response;
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const payload = body.payload || {};
    const ctx = { user: String(body.user || '').trim().slice(0, 50) };

    let handlers;
    if (SHOP_ACTIONS[action]) {
      ctx.shop = checkShopLogin_(body.shop);
      ctx.user = 'Shop: ' + ctx.shop.Name;
      handlers = { shopLogin: shopLogin, shopSaveOrder: shopSaveOrder };
    } else {
      checkAppToken_(body.token);
      handlers = staffHandlers_();
    }

    if (!handlers[action]) {
      throw new Error('Unknown action: ' + action);
    }

    if (WRITE_ACTIONS[action]) {
      if (!ctx.user) throw new Error('Your name is required. Log out and log back in with your name.');
      // Serialize writes: without this, two phones dispatching the same route
      // at once can both pass the "trip already exists" check.
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(30000)) throw new Error('Server busy, please try again.');
      try {
        response = { ok: true, data: handlers[action](payload, ctx) };
        SpreadsheetApp.flush();
      } finally {
        lock.releaseLock();
      }
    } else {
      response = { ok: true, data: handlers[action](payload, ctx) };
    }
  } catch (err) {
    response = { ok: false, error: err.message };
  }

  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function staffHandlers_() {
  return {
    getMasterData: getMasterData,
    saveProduct: saveProduct,
    saveRoute: saveRoute,
    getTrip: getTrip,
    getRouteDay: getRouteDay,
    getLastTrip: getLastTrip,
    dispatchTrip: dispatchTrip,
    saveTripProgress: saveTripProgress,
    settleTrip: settleTrip,
    reopenTrip: reopenTrip,
    listTrips: listTrips,
    getTodayStatus: getTodayStatus,
    getAnalytics: getAnalytics,
    getDashboard: getDashboard,
    saveShop: saveShop,
    resetShopPin: resetShopPin,
  };
}

// ---- Auth ------------------------------------------------------------

function checkAppToken_(token) {
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get('failedAuth') || 0);
  if (failures >= MAX_FAILED_AUTH) {
    throw new Error('Too many failed passcode attempts. Try again in 10 minutes.');
  }
  const expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!expected || token !== expected) {
    recordAuthFailure_(cache, failures);
    throw new Error('Unauthorized');
  }
}

function checkAdminToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!expected) throw new Error('Reopening is disabled: no admin passcode set. Run setAdminToken() in Apps Script.');
  if (token !== expected) {
    const cache = CacheService.getScriptCache();
    recordAuthFailure_(cache, Number(cache.get('failedAuth') || 0));
    throw new Error('Incorrect admin passcode');
  }
}

// Phone numbers are compared as their last 10 digits, so "+91 98480 12345",
// "098480-12345" and "9848012345" are the same shop.
function normalizePhone_(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function hashPin_(pin, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin);
  return Utilities.base64Encode(bytes);
}

function checkShopLogin_(creds) {
  const phone = normalizePhone_(creds && creds.phone);
  const pin = String((creds && creds.pin) || '');
  if (!phone) throw new Error('Enter your 10-digit phone number.');

  const cache = CacheService.getScriptCache();
  const key = 'shopFail:' + phone;
  const failures = Number(cache.get(key) || 0);
  if (failures >= MAX_FAILED_SHOP_LOGINS) {
    throw new Error('Too many wrong PINs. Try again in 15 minutes, or ask the distributor to reset your PIN.');
  }

  const shop = readAllIfExists_(SHEET_NAMES.SHOPS).filter((s) => normalizePhone_(s.Phone) === phone)[0];
  const ok = shop && isActive_(shop.Active) && shop.PinHash && hashPin_(pin, shop.PinSalt) === shop.PinHash;
  if (!ok) {
    // Same message whether the phone is unknown or the PIN is wrong, so the
    // login can't be used to discover which numbers are registered.
    cache.put(key, String(failures + 1), SHOP_LOCKOUT_SECONDS);
    throw new Error('Incorrect phone number or PIN.');
  }
  if (failures > 0) cache.remove(key);
  return shop;
}

function recordAuthFailure_(cache, failures) {
  cache.put('failedAuth', String(failures + 1), FAILED_AUTH_WINDOW_SECONDS);
}

// ---- Sheet helpers -----------------------------------------------------

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name + '. Run setup() in Apps Script to add it.');
  return sheet;
}

function readAll_(sheetName) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row.join('') === '') continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    obj.__row = i + 1;
    rows.push(obj);
  }
  return rows;
}

// For the shop tabs, which only exist once setup() has been re-run after
// upgrading: treat a missing tab as empty instead of breaking every screen.
function readAllIfExists_(sheetName) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName) ? readAll_(sheetName) : [];
}

function appendObject_(sheetName, obj) {
  const sheet = getSheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map((h) => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
}

// Only the keys present in obj are changed; every other column keeps its
// current value.
function updateObjectByRow_(sheetName, rowNumber, obj) {
  const sheet = getSheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const range = sheet.getRange(rowNumber, 1, 1, headers.length);
  const existing = range.getValues()[0];
  const row = headers.map((h, j) => (obj[h] !== undefined ? obj[h] : existing[j]));
  range.setValues([row]);
}

function stripRow_(obj) {
  const copy = {};
  for (const k in obj) {
    if (k !== '__row') copy[k] = obj[k];
  }
  return copy;
}

function newId_(prefix) {
  return prefix + new Date().getTime() + Math.floor(Math.random() * 1000);
}

let spreadsheetTimeZone_ = null;

// Sheets turns a 'yyyy-MM-dd' string into a Date at midnight in the
// *spreadsheet's* timezone, so it must be formatted back in that same
// timezone (not the script's) or dates can shift by a day.
function formatDate_(d) {
  if (Object.prototype.toString.call(d) === '[object Date]') {
    if (!spreadsheetTimeZone_) {
      spreadsheetTimeZone_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    }
    return Utilities.formatDate(d, spreadsheetTimeZone_, 'yyyy-MM-dd');
  }
  return String(d);
}

function isActive_(value) {
  return value !== false && String(value).toUpperCase() !== 'FALSE';
}

// ---- Master data ---------------------------------------------------------

function getMasterData() {
  return {
    products: readAll_(SHEET_NAMES.PRODUCTS).map(stripRow_),
    routes: readAll_(SHEET_NAMES.ROUTES).map(stripRow_),
    shops: readAllIfExists_(SHEET_NAMES.SHOPS).map(publicShop_),
  };
}

// A shop row without its PIN hash/salt — the only form that leaves the server.
function publicShop_(s) {
  return {
    ShopId: s.ShopId,
    Name: s.Name,
    OwnerName: s.OwnerName,
    Phone: String(s.Phone).replace(/^'/, ''),
    RouteId: s.RouteId,
    Active: s.Active,
    HasPin: !!s.PinHash,
  };
}

function saveProduct(payload) {
  const name = payload.name;
  const unit = payload.unit;
  const price = Number(payload.price);
  const active = payload.active !== false;

  if (!name) throw new Error('Product name is required');
  if (isNaN(price) || price < 0) throw new Error('Price must be a positive number');

  if (payload.productId) {
    const products = readAll_(SHEET_NAMES.PRODUCTS);
    const existing = products.filter((p) => p.ProductId === payload.productId)[0];
    if (!existing) throw new Error('Product not found');
    updateObjectByRow_(SHEET_NAMES.PRODUCTS, existing.__row, {
      Name: name, Unit: unit, Price: price, Active: active,
    });
    return Object.assign({ productId: existing.ProductId }, getMasterData());
  }

  const id = newId_('P');
  appendObject_(SHEET_NAMES.PRODUCTS, { ProductId: id, Name: name, Unit: unit, Price: price, Active: active });
  return Object.assign({ productId: id }, getMasterData());
}

function saveRoute(payload) {
  const name = payload.name;
  if (!name) throw new Error('Route name is required');

  const fields = {
    Name: name,
    Villages: payload.villages || '',
    DefaultVehicle: payload.defaultVehicle || '',
    DefaultDriver: payload.defaultDriver || '',
    Active: payload.active !== false,
  };

  if (payload.routeId) {
    const routes = readAll_(SHEET_NAMES.ROUTES);
    const existing = routes.filter((r) => r.RouteId === payload.routeId)[0];
    if (!existing) throw new Error('Route not found');
    updateObjectByRow_(SHEET_NAMES.ROUTES, existing.__row, fields);
    return Object.assign({ routeId: existing.RouteId }, getMasterData());
  }

  const id = newId_('R');
  appendObject_(SHEET_NAMES.ROUTES, Object.assign({ RouteId: id }, fields));
  return Object.assign({ routeId: id }, getMasterData());
}

// ---- Shops (staff) -----------------------------------------------------------

function newPin_() {
  // Digits taken from a random UUID: better randomness than Math.random().
  const hex = Utilities.getUuid().replace(/-/g, '');
  let pin = '';
  for (let i = 0; pin.length < SHOP_PIN_LENGTH && i < hex.length; i++) {
    const d = parseInt(hex[i], 16);
    if (d < 10) pin += d;
  }
  while (pin.length < SHOP_PIN_LENGTH) pin += Math.floor(Math.random() * 10);
  return pin;
}

function pinFields_() {
  const pin = newPin_();
  const salt = Utilities.getUuid();
  return { pin: pin, fields: { PinHash: hashPin_(pin, salt), PinSalt: salt } };
}

// Creates or updates a shop. A new shop gets a PIN, returned once in the
// response (only its hash is stored) so the admin can share it.
function saveShop(payload) {
  const name = String(payload.name || '').trim();
  const phone = normalizePhone_(payload.phone);
  if (!name) throw new Error('Shop name is required');
  if (!phone) throw new Error('Enter a 10-digit phone number');
  if (!payload.routeId) throw new Error('Pick the route that serves this shop');

  const shops = readAll_(SHEET_NAMES.SHOPS);
  const clash = shops.filter((s) => normalizePhone_(s.Phone) === phone && s.ShopId !== payload.shopId)[0];
  if (clash) throw new Error('Another shop (' + clash.Name + ') already uses this phone number');

  // Stored with a leading apostrophe so Sheets keeps it as text (no lost
  // leading zeros, no scientific notation).
  const fields = {
    Name: name,
    OwnerName: String(payload.ownerName || '').trim(),
    Phone: "'" + phone,
    RouteId: payload.routeId,
    Active: payload.active !== false,
  };

  let pin = null;
  let shopId = payload.shopId;
  if (shopId) {
    const existing = shops.filter((s) => s.ShopId === shopId)[0];
    if (!existing) throw new Error('Shop not found');
    updateObjectByRow_(SHEET_NAMES.SHOPS, existing.__row, fields);
  } else {
    shopId = newId_('S');
    const generated = pinFields_();
    pin = generated.pin;
    appendObject_(SHEET_NAMES.SHOPS, Object.assign({ ShopId: shopId, CreatedAt: new Date() }, fields, generated.fields));
  }
  return Object.assign({ shopId: shopId, pin: pin }, getMasterData());
}

function resetShopPin(payload) {
  const shop = readAll_(SHEET_NAMES.SHOPS).filter((s) => s.ShopId === payload.shopId)[0];
  if (!shop) throw new Error('Shop not found');
  const generated = pinFields_();
  updateObjectByRow_(SHEET_NAMES.SHOPS, shop.__row, generated.fields);
  CacheService.getScriptCache().remove('shopFail:' + normalizePhone_(shop.Phone));
  return { shopId: shop.ShopId, pin: generated.pin };
}

// ---- Shop orders (indents) ---------------------------------------------------

function tz_() {
  if (!spreadsheetTimeZone_) spreadsheetTimeZone_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return spreadsheetTimeZone_;
}

/** 'yyyy-MM-dd HH:mm' now, in the spreadsheet's timezone. */
function nowStamp_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
}

function addDaysStr_(date, n) {
  const parts = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}

/** When ordering for this delivery closes, as 'yyyy-MM-dd HH:mm'. */
function cutoffFor_(date, session) {
  const c = CUTOFFS[session];
  return addDaysStr_(date, c.dayOffset) + ' ' + c.time;
}

// Deliveries a shop can still order for: cutoff not yet passed and at most
// 24 hours away (stretched to always include tomorrow's Evening). In the
// morning that's today's Evening, tomorrow's Morning and tomorrow's Evening;
// late at night it's tomorrow's Evening and the next day's Morning.
function openSlots_() {
  const now = nowStamp_();
  const today = now.slice(0, 10);
  const horizon = addDaysStr_(today, 1) + ' ' + now.slice(11);
  const horizonEnd = horizon < addDaysStr_(today, 1) + ' 12:00' ? addDaysStr_(today, 1) + ' 12:00' : horizon;
  const slots = [];
  [0, 1, 2].forEach((offset) => {
    const date = addDaysStr_(today, offset);
    ['Morning', 'Evening'].forEach((session) => {
      const cutoff = cutoffFor_(date, session);
      if (cutoff > now && cutoff <= horizonEnd) slots.push({ date: date, session: session, cutoff: cutoff });
    });
  });
  return slots;
}

function parseItems_(json) {
  try {
    const items = JSON.parse(json || '[]');
    return Array.isArray(items) ? items : [];
  } catch (e) {
    return [];
  }
}

function indentView_(row) {
  return {
    indentId: row.IndentId,
    date: formatDate_(row.Date),
    session: row.Session,
    shopId: row.ShopId,
    routeId: row.RouteId,
    items: parseItems_(row.Items),
    total: Number(row.Total) || 0,
    updatedAt: row.UpdatedAt ? Utilities.formatDate(new Date(row.UpdatedAt), tz_(), 'yyyy-MM-dd HH:mm') : '',
  };
}

function shopLogin(payload, ctx) {
  const shop = ctx.shop;
  const route = readAll_(SHEET_NAMES.ROUTES).filter((r) => r.RouteId === shop.RouteId)[0];
  const products = readAll_(SHEET_NAMES.PRODUCTS)
    .filter((p) => isActive_(p.Active))
    .map((p) => ({ ProductId: p.ProductId, Name: p.Name, Unit: p.Unit, Price: Number(p.Price) || 0 }));

  const mine = readAll_(SHEET_NAMES.INDENTS).filter((r) => r.ShopId === shop.ShopId).map(indentView_);
  const slots = openSlots_().map((slot) => {
    const existing = mine.filter((o) => o.date === slot.date && o.session === slot.session)[0];
    return Object.assign({}, slot, { order: existing || null });
  });
  // Most recent non-empty order before the first open slot, for "same as last order".
  const firstOpen = slots.length ? slots[0].date + ' ' + slots[0].session : '9999';
  const last = mine
    .filter((o) => o.items.length && o.date + ' ' + o.session < firstOpen)
    .sort((a, b) => (b.date + b.session).localeCompare(a.date + a.session))[0];

  return {
    shop: { name: shop.Name, ownerName: shop.OwnerName, routeName: route ? route.Name : '' },
    products: products,
    slots: slots,
    lastOrder: last || null,
    now: nowStamp_(),
  };
}

function shopSaveOrder(payload, ctx) {
  const shop = ctx.shop;
  const session = payload.session;
  if (session !== 'Morning' && session !== 'Evening') throw new Error('Pick Morning or Evening');
  const slot = openSlots_().filter((s) => s.date === payload.date && s.session === session)[0];
  if (!slot) throw new Error('Ordering for this delivery has closed.');

  const products = {};
  readAll_(SHEET_NAMES.PRODUCTS).filter((p) => isActive_(p.Active)).forEach((p) => { products[p.ProductId] = p; });

  const items = [];
  const summary = [];
  let total = 0;
  (payload.items || []).forEach((i) => {
    const qty = Number(i.qty) || 0;
    if (qty <= 0) return;
    if (qty > 10000) throw new Error('Quantity too large');
    const p = products[i.productId];
    if (!p) throw new Error('This product is no longer available. Refresh and try again.');
    items.push({ productId: i.productId, qty: qty });
    summary.push(p.Name + ' × ' + qty);
    total += qty * (Number(p.Price) || 0);
  });

  const fields = {
    Date: payload.date,
    Session: session,
    ShopId: shop.ShopId,
    RouteId: shop.RouteId,
    Items: JSON.stringify(items),
    Summary: summary.join(', '),
    Total: total,
    UpdatedAt: new Date(),
  };
  const existing = readAll_(SHEET_NAMES.INDENTS).filter(
    (r) => r.ShopId === shop.ShopId && formatDate_(r.Date) === payload.date && r.Session === session,
  )[0];
  if (existing) {
    updateObjectByRow_(SHEET_NAMES.INDENTS, existing.__row, fields);
  } else {
    appendObject_(SHEET_NAMES.INDENTS, Object.assign({ IndentId: newId_('I') }, fields));
  }
  return shopLogin(payload, ctx);
}

/** Shop orders for a date (optionally one route), non-empty only. */
function indentsFor_(date, routeId) {
  return readAllIfExists_(SHEET_NAMES.INDENTS)
    .filter((r) => formatDate_(r.Date) === date && (!routeId || r.RouteId === routeId))
    .map(indentView_)
    .filter((o) => o.items.length > 0);
}

// Dashboard in one request: today's trips plus shop-order counts per route
// and session.
function getDashboard(payload) {
  const trips = getTodayStatus(payload);
  const indents = indentsFor_(payload.date);
  const shops = readAllIfExists_(SHEET_NAMES.SHOPS).filter((s) => isActive_(s.Active));
  const orders = {};
  shops.forEach((s) => {
    ['Morning', 'Evening'].forEach((session) => {
      const key = s.RouteId + '|' + session;
      if (!orders[key]) orders[key] = { routeId: s.RouteId, session: session, shops: 0, ordered: 0 };
      orders[key].shops += 1;
    });
  });
  indents.forEach((o) => {
    const key = o.routeId + '|' + o.session;
    if (orders[key]) orders[key].ordered += 1;
  });
  return { trips: trips, orders: Object.keys(orders).map((k) => orders[k]) };
}

// ---- Trips -----------------------------------------------------------

function getTrip(payload) {
  const trips = readAll_(SHEET_NAMES.TRIPS);
  const trip = trips.filter(
    (t) => t.RouteId === payload.routeId && formatDate_(t.Date) === payload.date && t.Session === payload.session,
  )[0];
  if (!trip) return null;

  const items = readAll_(SHEET_NAMES.TRIP_ITEMS).filter((i) => i.TripId === trip.TripId);
  const strippedTrip = stripRow_(trip);
  strippedTrip.Date = formatDate_(trip.Date);
  return { trip: strippedTrip, items: items.map(stripRow_) };
}

function dispatchTrip(payload, ctx) {
  if (payload.session !== 'Morning' && payload.session !== 'Evening') {
    throw new Error('Session must be Morning or Evening');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) {
    throw new Error('Date must be in yyyy-MM-dd format');
  }
  const existing = getTrip({ routeId: payload.routeId, date: payload.date, session: payload.session });
  if (existing) throw new Error('This route already has a ' + payload.session + ' trip for ' + payload.date);

  const products = readAll_(SHEET_NAMES.PRODUCTS);
  const productMap = {};
  products.forEach((p) => { productMap[p.ProductId] = p; });

  const tripId = newId_('T');
  let dispatchedTotal = 0;
  const itemsToWrite = [];

  (payload.items || []).forEach((item) => {
    const qty = Number(item.qty) || 0;
    if (qty <= 0) return;
    const product = productMap[item.productId];
    if (!product) throw new Error('Unknown product: ' + item.productId);
    const price = Number(product.Price) || 0;
    const value = qty * price;
    dispatchedTotal += value;
    itemsToWrite.push({
      TripItemId: newId_('TI'),
      TripId: tripId,
      ProductId: item.productId,
      Price: price,
      QtyDispatched: qty,
      QtyReturned: 0,
      DispatchedValue: value,
      ReturnedValue: 0,
    });
  });

  if (itemsToWrite.length === 0) throw new Error('At least one product with quantity is required');

  appendObject_(SHEET_NAMES.TRIPS, {
    TripId: tripId,
    Date: payload.date,
    Session: payload.session,
    RouteId: payload.routeId,
    Driver: payload.driver || '',
    Vehicle: payload.vehicle || '',
    Status: 'Dispatched',
    DispatchedTotal: dispatchedTotal,
    ReturnedTotal: '',
    AmountDue: '',
    CashHandedOver: '',
    Discrepancy: '',
    CreatedAt: new Date(),
    SettledAt: '',
    DispatchedBy: ctx.user,
  });

  itemsToWrite.forEach((item) => appendObject_(SHEET_NAMES.TRIP_ITEMS, item));

  return getTrip({ routeId: payload.routeId, date: payload.date, session: payload.session });
}

function applyReturns_(trip, payload, finalize, ctx) {
  const tripItems = readAll_(SHEET_NAMES.TRIP_ITEMS).filter((i) => i.TripId === trip.TripId);
  const returnMap = {};
  (payload.items || []).forEach((i) => { returnMap[i.productId] = Number(i.qtyReturned) || 0; });

  // Validate everything before writing anything, so a bad row can't leave
  // the trip half-updated.
  tripItems.forEach((item) => {
    const qtyReturned = returnMap[item.ProductId] || 0;
    if (qtyReturned < 0) throw new Error('Returned qty cannot be negative for product ' + item.ProductId);
    if (qtyReturned > Number(item.QtyDispatched)) {
      throw new Error('Returned qty exceeds dispatched qty for product ' + item.ProductId);
    }
  });

  let returnedTotal = 0;
  tripItems.forEach((item) => {
    const qtyReturned = returnMap[item.ProductId] || 0;
    const returnedValue = qtyReturned * Number(item.Price);
    returnedTotal += returnedValue;
    updateObjectByRow_(SHEET_NAMES.TRIP_ITEMS, item.__row, {
      QtyReturned: qtyReturned,
      ReturnedValue: returnedValue,
    });
  });

  const dispatchedTotal = Number(trip.DispatchedTotal);
  const amountDue = dispatchedTotal - returnedTotal;
  const cashHandedOver = Number(payload.cashHandedOver) || 0;
  const discrepancy = cashHandedOver - amountDue;

  updateObjectByRow_(SHEET_NAMES.TRIPS, trip.__row, {
    Status: finalize ? 'Settled' : 'Dispatched',
    ReturnedTotal: returnedTotal,
    AmountDue: amountDue,
    CashHandedOver: cashHandedOver,
    Discrepancy: discrepancy,
    SettledAt: finalize ? new Date() : '',
    SettledBy: finalize ? ctx.user : '',
  });

  return getTrip({ routeId: trip.RouteId, date: formatDate_(trip.Date), session: trip.Session });
}

function findTrip_(tripId) {
  const trip = readAll_(SHEET_NAMES.TRIPS).filter((t) => t.TripId === tripId)[0];
  if (!trip) throw new Error('Trip not found');
  return trip;
}

function saveTripProgress(payload, ctx) {
  const trip = findTrip_(payload.tripId);
  if (trip.Status === 'Settled') throw new Error('Trip already settled');
  return applyReturns_(trip, payload, false, ctx);
}

function settleTrip(payload, ctx) {
  const trip = findTrip_(payload.tripId);
  if (trip.Status === 'Settled') throw new Error('Trip already settled');
  return applyReturns_(trip, payload, true, ctx);
}

// Puts a settled trip back to Dispatched (keeping its return quantities and
// cash) so a mistake can be corrected and the trip settled again.
function reopenTrip(payload, ctx) {
  checkAdminToken_(payload.adminToken);
  const trip = findTrip_(payload.tripId);
  if (trip.Status !== 'Settled') throw new Error('Trip is not settled');
  updateObjectByRow_(SHEET_NAMES.TRIPS, trip.__row, {
    Status: 'Dispatched',
    SettledAt: '',
    SettledBy: '',
    ReopenedBy: ctx.user,
    ReopenedAt: new Date(),
  });
  return getTrip({ routeId: trip.RouteId, date: formatDate_(trip.Date), session: trip.Session });
}

// Everything the Route screen needs in one request: master data plus this
// route's trips on the date — both sessions, with their items (at most two
// trips), so switching Morning/Evening needs no further request. The session
// to open is the one asked for, else whichever is still awaiting its return,
// else the caller's clock-based default.
function getRouteDay(payload) {
  const trips = readAll_(SHEET_NAMES.TRIPS).filter(
    (t) => t.RouteId === payload.routeId && formatDate_(t.Date) === payload.date,
  );
  const tripIds = {};
  trips.forEach((t) => { tripIds[t.TripId] = true; });
  const items = trips.length ? readAll_(SHEET_NAMES.TRIP_ITEMS).filter((i) => tripIds[i.TripId]) : [];

  const days = trips.map((t) => {
    const trip = stripRow_(t);
    trip.Date = formatDate_(t.Date);
    return { trip: trip, items: items.filter((i) => i.TripId === t.TripId).map(stripRow_) };
  });

  let session = payload.session;
  if (session !== 'Morning' && session !== 'Evening') {
    const awaiting = ['Morning', 'Evening'].filter((s) =>
      days.some((d) => d.trip.Session === s && d.trip.Status === 'Dispatched'),
    )[0];
    session = awaiting || (payload.fallbackSession === 'Evening' ? 'Evening' : 'Morning');
  }

  const master = getMasterData();
  return {
    products: master.products,
    routes: master.routes,
    shops: master.shops,
    session: session,
    trips: days,
    indents: indentsFor_(payload.date, payload.routeId),
  };
}

// The most recent earlier trip for this route and session — used to pre-fill
// the dispatch form, since quantities barely change day to day.
function getLastTrip(payload) {
  const before = String(payload.beforeDate || '');
  const candidates = readAll_(SHEET_NAMES.TRIPS).filter(
    (t) => t.RouteId === payload.routeId && t.Session === payload.session && formatDate_(t.Date) < before,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => formatDate_(b.Date).localeCompare(formatDate_(a.Date)));
  const trip = candidates[0];
  const items = readAll_(SHEET_NAMES.TRIP_ITEMS).filter((i) => i.TripId === trip.TripId);
  const strippedTrip = stripRow_(trip);
  strippedTrip.Date = formatDate_(trip.Date);
  return { trip: strippedTrip, items: items.map(stripRow_) };
}

function listTrips(payload) {
  const trips = readAll_(SHEET_NAMES.TRIPS);
  const routes = readAll_(SHEET_NAMES.ROUTES);
  const routeMap = {};
  routes.forEach((r) => { routeMap[r.RouteId] = r.Name; });

  const filtered = trips.filter((t) => {
    const d = formatDate_(t.Date);
    if (payload.routeId && t.RouteId !== payload.routeId) return false;
    if (payload.dateFrom && d < payload.dateFrom) return false;
    if (payload.dateTo && d > payload.dateTo) return false;
    return true;
  });

  filtered.sort((a, b) => formatDate_(b.Date).localeCompare(formatDate_(a.Date)));

  return filtered.map((t) => {
    const obj = stripRow_(t);
    obj.Date = formatDate_(t.Date);
    obj.RouteName = routeMap[t.RouteId] || t.RouteId;
    return obj;
  });
}

// One call for the whole Dashboard instead of two getTrip calls per route —
// the Dashboard used to make 2xN requests (Morning + Evening per route), each
// with real Apps Script overhead; this collapses it to a single request.
function getTodayStatus(payload) {
  const trips = readAll_(SHEET_NAMES.TRIPS).filter((t) => formatDate_(t.Date) === payload.date);
  return trips.map((t) => {
    const obj = stripRow_(t);
    obj.Date = formatDate_(t.Date);
    return obj;
  });
}

// ---- Analytics -----------------------------------------------------------
// Only settled trips are counted: DispatchedTotal/ReturnedTotal/etc. on a
// still-open trip aren't final, so they'd distort revenue and return-rate
// numbers used for business decisions.
//
// Discrepancies are reported as shortage (cash short, a positive number) and
// excess separately, never just netted: one driver ₹500 short and another
// ₹500 over must not show up as ₹0.

function getAnalytics(payload) {
  // Read each sheet once, then compute the requested range and, if asked,
  // the comparison range from the same data — one request instead of two.
  const settled = readAll_(SHEET_NAMES.TRIPS).filter((t) => t.Status === 'Settled');

  const routeMap = {};
  readAll_(SHEET_NAMES.ROUTES).forEach((r) => { routeMap[r.RouteId] = r.Name; });

  const productMap = {};
  readAll_(SHEET_NAMES.PRODUCTS).forEach((p) => { productMap[p.ProductId] = p.Name; });

  const allItems = readAll_(SHEET_NAMES.TRIP_ITEMS);

  const result = computeAnalytics_(settled, allItems, routeMap, productMap, payload);
  if (payload.previous) {
    result.previous = computeAnalytics_(settled, allItems, routeMap, productMap, payload.previous);
  }
  return result;
}

function computeAnalytics_(settled, allItems, routeMap, productMap, range) {
  const filtered = settled.filter((t) => {
    const d = formatDate_(t.Date);
    if (range.dateFrom && d < range.dateFrom) return false;
    if (range.dateTo && d > range.dateTo) return false;
    return true;
  });

  const tripIds = {};
  filtered.forEach((t) => { tripIds[t.TripId] = true; });
  const items = allItems.filter((i) => tripIds[i.TripId]);

  let totalDispatched = 0;
  let totalReturned = 0;
  let totalCash = 0;
  let totalDiscrepancy = 0;
  let totalShortage = 0;
  let totalExcess = 0;

  const byDateMap = {};
  const byRouteMap = {};
  const byDriverMap = {};
  const bySessionMap = {
    Morning: { session: 'Morning', dispatched: 0, returned: 0, tripCount: 0 },
    Evening: { session: 'Evening', dispatched: 0, returned: 0, tripCount: 0 },
  };

  filtered.forEach((t) => {
    const dispatched = Number(t.DispatchedTotal) || 0;
    const returned = Number(t.ReturnedTotal) || 0;
    const discrepancy = Number(t.Discrepancy) || 0;
    const cash = Number(t.CashHandedOver) || 0;
    const shortage = discrepancy < 0 ? -discrepancy : 0;
    const excess = discrepancy > 0 ? discrepancy : 0;

    totalDispatched += dispatched;
    totalReturned += returned;
    totalCash += cash;
    totalDiscrepancy += discrepancy;
    totalShortage += shortage;
    totalExcess += excess;

    const d = formatDate_(t.Date);
    if (!byDateMap[d]) byDateMap[d] = { date: d, dispatched: 0, returned: 0, cash: 0, discrepancy: 0, shortage: 0, tripCount: 0 };
    byDateMap[d].dispatched += dispatched;
    byDateMap[d].returned += returned;
    byDateMap[d].discrepancy += discrepancy;
    byDateMap[d].shortage += shortage;
    byDateMap[d].cash += cash;
    byDateMap[d].tripCount += 1;

    if (!byRouteMap[t.RouteId]) {
      byRouteMap[t.RouteId] = {
        routeId: t.RouteId,
        routeName: routeMap[t.RouteId] || t.RouteId,
        dispatched: 0,
        returned: 0,
        discrepancy: 0,
        shortage: 0,
        excess: 0,
        tripCount: 0,
      };
    }
    const r = byRouteMap[t.RouteId];
    r.dispatched += dispatched;
    r.returned += returned;
    r.discrepancy += discrepancy;
    r.shortage += shortage;
    r.excess += excess;
    r.tripCount += 1;

    const driver = String(t.Driver || '').trim() || '(no driver)';
    if (!byDriverMap[driver]) {
      byDriverMap[driver] = { driver: driver, tripCount: 0, shortTrips: 0, shortage: 0, excess: 0, discrepancy: 0 };
    }
    const dr = byDriverMap[driver];
    dr.tripCount += 1;
    if (shortage > 0) dr.shortTrips += 1;
    dr.shortage += shortage;
    dr.excess += excess;
    dr.discrepancy += discrepancy;

    if (bySessionMap[t.Session]) {
      bySessionMap[t.Session].dispatched += dispatched;
      bySessionMap[t.Session].returned += returned;
      bySessionMap[t.Session].tripCount += 1;
    }
  });

  const byProductMap = {};
  items.forEach((i) => {
    if (!byProductMap[i.ProductId]) {
      byProductMap[i.ProductId] = {
        productId: i.ProductId,
        productName: productMap[i.ProductId] || i.ProductId,
        qtyDispatched: 0,
        qtyReturned: 0,
        dispatchedValue: 0,
        returnedValue: 0,
      };
    }
    const p = byProductMap[i.ProductId];
    p.qtyDispatched += Number(i.QtyDispatched) || 0;
    p.qtyReturned += Number(i.QtyReturned) || 0;
    p.dispatchedValue += Number(i.DispatchedValue) || 0;
    p.returnedValue += Number(i.ReturnedValue) || 0;
  });

  const byDate = Object.keys(byDateMap)
    .map((d) => byDateMap[d])
    .map((r) => Object.assign({ revenue: r.dispatched - r.returned }, r))
    .sort((a, b) => a.date.localeCompare(b.date));

  const byRoute = Object.keys(byRouteMap)
    .map((k) => byRouteMap[k])
    .map((r) => Object.assign({ revenue: r.dispatched - r.returned }, r))
    .sort((a, b) => b.revenue - a.revenue);

  const byDriver = Object.keys(byDriverMap)
    .map((k) => byDriverMap[k])
    .sort((a, b) => b.shortage - a.shortage || b.excess - a.excess);

  const bySession = Object.keys(bySessionMap)
    .map((k) => bySessionMap[k])
    .map((r) => Object.assign({ revenue: r.dispatched - r.returned }, r));

  const byProduct = Object.keys(byProductMap)
    .map((k) => byProductMap[k])
    .map((p) =>
      Object.assign(
        {
          revenue: p.dispatchedValue - p.returnedValue,
          returnRate: p.qtyDispatched > 0 ? p.qtyReturned / p.qtyDispatched : 0,
        },
        p,
      ),
    )
    .sort((a, b) => b.revenue - a.revenue);

  return {
    summary: {
      totalDispatched: totalDispatched,
      totalReturned: totalReturned,
      totalRevenue: totalDispatched - totalReturned,
      totalCash: totalCash,
      totalDiscrepancy: totalDiscrepancy,
      totalShortage: totalShortage,
      totalExcess: totalExcess,
      tripCount: filtered.length,
    },
    byDate: byDate,
    byRoute: byRoute,
    byDriver: byDriver,
    bySession: bySession,
    byProduct: byProduct,
  };
}
