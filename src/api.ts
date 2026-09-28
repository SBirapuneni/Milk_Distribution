import type {
  Analytics,
  DashboardData,
  MasterData,
  RouteDay,
  Session,
  ShopHome,
  StaffUser,
  Trip,
  TripItem,
  TripWithItems,
} from './types';
import { computeAnalytics } from './analytics-compute';
import * as mock from './mock';

// The backend is a set of Postgres functions on Supabase, called over HTTP as
// POST {SUPABASE_URL}/rest/v1/rpc/<function>. The key is the project's
// public ("publishable"/anon) key: it can only call those functions, and
// each function checks the caller's session token itself.
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || '';

// Without Supabase settings, fall back to an in-memory demo backend so the
// app can be tried out. Demo data resets on page reload.
export const DEMO_MODE = !SUPABASE_URL || !SUPABASE_KEY;
export const DEMO_STAFF = mock.DEMO_STAFF;
export const DEMO_SHOPS = mock.DEMO_SHOPS;

// ---- Transport -------------------------------------------------------------

let onSessionExpired: () => void = () => {};

/** Called when the server says the staff session is no longer valid. */
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly relogin: boolean,
  ) {
    super(message);
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your internet connection.', false);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page
  }
  if (!res.ok) {
    const body = (json ?? {}) as { message?: string; hint?: string };
    throw new ApiError(body.message || `Request failed (${res.status})`, body.hint === 'relogin');
  }
  return json as T;
}

// ---- Staff session -----------------------------------------------------------
// Each staff member logs in with their own phone + PIN. The session token is
// kept on the device (7 days, extended as the app is used) until Log out.

const SESSION_KEY = 'milk_staff_session';

interface StaffSession {
  token: string;
  staff: StaffUser;
}

function readSession(): StaffSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StaffSession) : null;
  } catch {
    return null;
  }
}

let session: StaffSession | null = readSession();

export function currentStaff(): StaffUser | null {
  return session?.staff ?? null;
}

export function isAdmin(): boolean {
  return session?.staff.role === 'admin';
}

function saveSession(s: StaffSession | null) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage blocked: the session lasts until the page is closed
  }
}

export async function staffLogin(phone: string, pin: string): Promise<void> {
  const result = DEMO_MODE
    ? await mock.staffLogin(phone, pin)
    : await rpc<{ ok: boolean; error?: string; token?: string; staff?: StaffUser; master?: MasterData }>('staff_login', {
        p: { phone, pin },
      });
  if (!result.ok || !result.token || !result.staff) throw new Error(result.error || 'Login failed');
  saveSession({ token: result.token, staff: result.staff });
  if (result.master) writeMasterCache(result.master);
}

export async function logout() {
  const token = session?.token;
  saveSession(null);
  clearMasterCache();
  if (token && !DEMO_MODE) await rpc('logout', { p_token: token }).catch(() => {});
}

/** Staff API call with the current session; an expired session sends the user back to login. */
async function call<T>(fn: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!session) {
    onSessionExpired();
    throw new Error('Please log in again.');
  }
  try {
    return await rpc<T>(fn, { p_token: session.token, p: payload });
  } catch (err) {
    if (err instanceof ApiError && err.relogin) {
      saveSession(null);
      clearMasterCache();
      onSessionExpired();
    }
    throw err;
  }
}

function demoUser(): string {
  return session?.staff.name ?? 'Demo';
}

// ---- Master data cache ----------------------------------------------------
// Products, routes, shops (and, for admins, staff) change rarely but are
// needed on most screens. Keep them for the session and refresh from every
// response that carries them (login, Route screen, saves), with a time limit
// so edits made on another phone show up.

const MASTER_KEY = 'milk_app_master';
const MASTER_TTL_MS = 5 * 60 * 1000;

function readMasterCache(): MasterData | null {
  try {
    const raw = sessionStorage.getItem(MASTER_KEY);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw) as { at: number; data: MasterData };
    return Date.now() - at < MASTER_TTL_MS && Array.isArray(data.shops) && Array.isArray(data.staff) ? data : null;
  } catch {
    return null;
  }
}

function writeMasterCache(data: MasterData) {
  try {
    const { products, routes, shops, staff } = data;
    sessionStorage.setItem(MASTER_KEY, JSON.stringify({ at: Date.now(), data: { products, routes, shops, staff } }));
  } catch {
    // Storage full/blocked: we just refetch next time.
  }
}

function clearMasterCache() {
  try {
    sessionStorage.removeItem(MASTER_KEY);
  } catch {
    // ignore
  }
}

async function withMaster<T extends MasterData>(p: Promise<T>): Promise<T> {
  const data = await p;
  writeMasterCache(data);
  return data;
}

export async function getMasterData(): Promise<MasterData> {
  const cached = readMasterCache();
  if (cached) return cached;
  return withMaster(DEMO_MODE ? mock.getMasterData(isAdmin()) : call<MasterData>('get_master_data'));
}

// ---- Products & routes (admin) -------------------------------------------------

export function saveProduct(payload: {
  productId?: string;
  name: string;
  unit: string;
  price: number;
  active: boolean;
}): Promise<{ productId: string } & MasterData> {
  return withMaster(DEMO_MODE ? mock.saveProduct(payload) : call('save_product', payload));
}

export function saveRoute(payload: {
  routeId?: string;
  name: string;
  villages: string;
  defaultVehicle: string;
  defaultDriver: string;
  active: boolean;
}): Promise<{ routeId: string } & MasterData> {
  return withMaster(DEMO_MODE ? mock.saveRoute(payload) : call('save_route', payload));
}

// ---- Staff (admin) ------------------------------------------------------------

export function saveStaff(payload: {
  staffId?: string;
  name: string;
  phone: string;
  role: 'admin' | 'staff';
  active: boolean;
}): Promise<{ staffId: string; pin: string | null } & MasterData> {
  return withMaster(DEMO_MODE ? mock.saveStaff(payload, session?.staff.id ?? '') : call('save_staff', payload));
}

export function resetStaffPin(staffId: string): Promise<{ staffId: string; pin: string }> {
  return DEMO_MODE ? mock.resetStaffPin(staffId) : call('reset_staff_pin', { staffId });
}

// ---- Trips ----------------------------------------------------------------------

export function getRouteDay(payload: {
  routeId: string;
  date: string;
  session?: Session;
  fallbackSession: Session;
}): Promise<RouteDay> {
  return withMaster(DEMO_MODE ? mock.getRouteDay(payload, isAdmin()) : call('get_route_day', payload));
}

export function getLastTrip(routeId: string, session: Session, beforeDate: string): Promise<TripWithItems | null> {
  return DEMO_MODE ? mock.getLastTrip(routeId, session, beforeDate) : call('get_last_trip', { routeId, session, beforeDate });
}

export function dispatchTrip(payload: {
  routeId: string;
  date: string;
  session: Session;
  driver: string;
  vehicle: string;
  items: { productId: string; qty: number }[];
}): Promise<TripWithItems> {
  return DEMO_MODE ? mock.dispatchTrip(payload, demoUser()) : call('dispatch_trip', payload);
}

export function saveTripProgress(payload: {
  tripId: string;
  items: { productId: string; qtyReturned: number }[];
  cashHandedOver: number;
}): Promise<TripWithItems> {
  return DEMO_MODE ? mock.saveTripProgress(payload) : call('save_trip_progress', payload);
}

export function settleTrip(payload: {
  tripId: string;
  items: { productId: string; qtyReturned: number }[];
  cashHandedOver: number;
}): Promise<TripWithItems> {
  return DEMO_MODE ? mock.settleTrip(payload, demoUser()) : call('settle_trip', payload);
}

/** Admins only. */
export function reopenTrip(tripId: string): Promise<TripWithItems> {
  return DEMO_MODE ? mock.reopenTrip({ tripId }, demoUser(), isAdmin()) : call('reopen_trip', { tripId });
}

export function listTrips(
  payload: { routeId?: string; dateFrom?: string; dateTo?: string } = {},
): Promise<Trip[]> {
  return DEMO_MODE ? mock.listTrips(payload) : call('list_trips', payload);
}

export function getDashboard(date: string): Promise<DashboardData> {
  return DEMO_MODE ? mock.getDashboard(date) : call('get_dashboard', { date });
}

// The server returns raw settled trips for the whole span (selected range
// plus the comparison range); the numbers are computed here, with the same
// code demo mode uses.
export async function getAnalytics(payload: {
  dateFrom: string;
  dateTo: string;
  previous?: { dateFrom: string; dateTo: string };
}): Promise<Analytics> {
  if (DEMO_MODE) return mock.getAnalytics(payload);
  const from = payload.previous && payload.previous.dateFrom < payload.dateFrom ? payload.previous.dateFrom : payload.dateFrom;
  const raw = await call<{
    trips: Trip[];
    items: TripItem[];
    routeNames: Record<string, string>;
    productNames: Record<string, string>;
  }>('get_analytics_data', { dateFrom: from, dateTo: payload.dateTo });
  const result = computeAnalytics(raw, payload);
  if (payload.previous) result.previous = computeAnalytics(raw, payload.previous);
  return result;
}

// ---- Shops (admin) ----------------------------------------------------------

export function saveShop(payload: {
  shopId?: string;
  name: string;
  ownerName: string;
  phone: string;
  routeId: string;
  active: boolean;
}): Promise<{ shopId: string; pin: string | null } & MasterData> {
  return withMaster(DEMO_MODE ? mock.saveShop(payload) : call('save_shop', payload));
}

export function resetShopPin(shopId: string): Promise<{ shopId: string; pin: string }> {
  return DEMO_MODE ? mock.resetShopPin(shopId) : call('reset_shop_pin', { shopId });
}

// ---- Shop owner portal --------------------------------------------------------
// Shop owners log in with phone + PIN; the session (30 days, extended as it's
// used) is kept on the device, separately from any staff session.

const SHOP_SESSION_KEY = 'milk_shop_session';

interface ShopSession {
  token: string;
  phone: string;
}

function readShopSession(): ShopSession | null {
  try {
    const raw = localStorage.getItem(SHOP_SESSION_KEY);
    return raw ? (JSON.parse(raw) as ShopSession) : null;
  } catch {
    return null;
  }
}

export function lastShopPhone(): string {
  try {
    return readShopSession()?.phone || localStorage.getItem('milk_shop_phone') || '';
  } catch {
    return '';
  }
}

export function hasShopSession(): boolean {
  return !!readShopSession()?.token;
}

export function shopLogout() {
  const s = readShopSession();
  try {
    localStorage.removeItem(SHOP_SESSION_KEY);
    if (s) localStorage.setItem('milk_shop_phone', s.phone);
  } catch {
    // ignore
  }
  if (s && !DEMO_MODE) rpc('logout', { p_token: s.token }).catch(() => {});
}

export async function shopLogin(phone: string, pin: string): Promise<ShopHome> {
  const result = DEMO_MODE
    ? await mock.shopLogin(phone, pin)
    : await rpc<{ ok: boolean; error?: string; token?: string; home?: ShopHome }>('shop_login', { p: { phone, pin } });
  if (!result.ok || !result.token || !result.home) throw new Error(result.error || 'Login failed');
  try {
    localStorage.setItem(SHOP_SESSION_KEY, JSON.stringify({ token: result.token, phone }));
  } catch {
    // ignore
  }
  return result.home;
}

async function shopCall<T>(fn: string, payload: Record<string, unknown> = {}): Promise<T> {
  const s = readShopSession();
  if (!s) throw new ApiError('Please log in again.', true);
  try {
    return DEMO_MODE
      ? ((await mock.shopCall(s.token, fn, payload)) as T)
      : await rpc<T>(fn, { p_token: s.token, p: payload });
  } catch (err) {
    if ((err instanceof ApiError && err.relogin) || /log in again/i.test((err as Error).message)) shopLogout();
    throw err;
  }
}

export function shopHome(): Promise<ShopHome> {
  return shopCall<ShopHome>('shop_home');
}

export function shopSaveOrder(payload: {
  date: string;
  session: Session;
  items: { productId: string; qty: number }[];
}): Promise<ShopHome> {
  return shopCall<ShopHome>('shop_save_order', payload);
}
