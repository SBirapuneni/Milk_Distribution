import { navHtml, wireNav } from '../components/nav';
import { dispatchTrip, getLastTrip, getRouteDay, isAdmin, reopenTrip, saveTripProgress, settleTrip } from '../api';
import type { Indent, Product, Route, RouteDay, Session, Shop, Trip, TripWithItems } from '../types';
import { escapeHtml, localDateStr, money, shortDate } from '../util';
import { confirmDialog } from '../dialog';

const SESSIONS: Session[] = ['Morning', 'Evening'];

function clockSession(): Session {
  return new Date().getHours() < 15 ? 'Morning' : 'Evening';
}

// Tapping a quantity box selects its contents, so typing replaces the value
// instead of appending to it (no more "05").
function selectOnFocus(root: HTMLElement) {
  root.querySelectorAll<HTMLInputElement>('input[type="number"]').forEach((input) =>
    input.addEventListener('focus', () => input.select()),
  );
}

// Everything on this screen for one date comes from a single getRouteDay
// request (master data + both sessions' trips with items). Switching session
// re-renders from that without another request, and after a dispatch, settle
// or reopen the server's response is used directly instead of reloading.
export async function renderRouteScreen(container: HTMLElement, routeId: string, initialSession?: Session) {
  container.innerHTML = navHtml('dashboard') + '<main class="page"><p>Loading...</p></main>';
  wireNav(container);

  const main = container.querySelector<HTMLElement>('main')!;

  // Holds a save function for whatever settle form is currently on screen, so
  // navigating away (dashboard, other tabs, switching date/session) can flush
  // unsaved return-quantity/cash entries instead of silently discarding them.
  let pendingSave: (() => Promise<void>) | null = null;

  async function flushPendingSave() {
    if (!pendingSave) return;
    const save = pendingSave;
    pendingSave = null;
    try {
      await save();
    } catch {
      // Best-effort: don't block navigation if the save fails.
    }
  }

  container.addEventListener(
    'click',
    (e) => {
      const link = (e.target as HTMLElement).closest('a[href^="#"]') as HTMLAnchorElement | null;
      if (!link || !pendingSave) return;
      e.preventDefault();
      const href = link.getAttribute('href')!;
      flushPendingSave().then(() => {
        window.location.hash = href;
      });
    },
    { capture: true },
  );

  let day: { date: string; data: RouteDay; trips: Map<Session, TripWithItems> } | null = null;

  async function load(date: string, session?: Session) {
    main.innerHTML = '<p>Loading...</p>';
    try {
      const data = await getRouteDay({ routeId, date, session, fallbackSession: clockSession() });
      day = { date, data, trips: new Map(data.trips.map((t) => [t.trip.Session, t])) };
      show(data.session);
    } catch (err) {
      main.innerHTML = `<p class="error">Failed to load: ${escapeHtml((err as Error).message)}</p>`;
    }
  }

  // A mutation returned the trip's new state: store it and re-render.
  function applyTrip(tripData: TripWithItems) {
    if (!day) return;
    day.trips.set(tripData.trip.Session, tripData);
    show(tripData.trip.Session);
  }

  function tabStatus(trip: Trip | undefined): string {
    if (!trip) return '';
    return trip.Status === 'Settled'
      ? '<span class="tab-status">Settled</span>'
      : '<span class="tab-status pending">Awaiting return</span>';
  }

  function show(session: Session) {
    if (!day) return;
    pendingSave = null;
    const { date, data, trips } = day;

    const route = data.routes.find((r) => r.RouteId === routeId);
    if (!route) {
      main.innerHTML = '<p class="error">Route not found.</p>';
      return;
    }
    const activeProducts = data.products.filter((p) => p.Active !== false && String(p.Active).toUpperCase() !== 'FALSE');
    const productMap = new Map(data.products.map((p) => [p.ProductId, p]));
    const tripData = trips.get(session) ?? null;

    // Keep the session in the URL so a refresh or shared link lands on it.
    // replaceState doesn't fire hashchange, so this doesn't re-render.
    history.replaceState(null, '', `#/route/${encodeURIComponent(routeId)}/${session}`);

    const other = SESSIONS.find((s) => s !== session)!;
    const otherAwaiting = trips.get(other)?.trip.Status === 'Dispatched';

    main.innerHTML = `
      <a href="#/" class="back-link">&larr; Back to dashboard</a>
      <h1>${escapeHtml(route.Name)}</h1>
      <p class="villages">${escapeHtml(route.Villages)}</p>
      <div class="field-row">
        <label>Date <input type="date" id="date-input" value="${escapeHtml(date)}" /></label>
      </div>
      <div class="session-tabs">
        ${SESSIONS.map(
          (s) =>
            `<button type="button" class="session-tab ${session === s ? 'active' : ''}" data-session="${s}">${s}${tabStatus(trips.get(s)?.trip)}</button>`,
        ).join('')}
      </div>
      ${
        otherAwaiting
          ? `<div class="banner">The <strong>${other}</strong> trip for ${shortDate(date)} is still awaiting its return and cash. <button type="button" class="link-btn" data-session="${other}">Open ${other} &rarr;</button></div>`
          : ''
      }
      <div id="trip-body"></div>
    `;

    main.querySelector<HTMLInputElement>('#date-input')!.addEventListener('change', async (e) => {
      const newDate = (e.target as HTMLInputElement).value;
      await flushPendingSave();
      load(newDate);
    });

    main.querySelectorAll<HTMLButtonElement>('.session-tab, .banner [data-session]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await flushPendingSave();
        show(btn.dataset.session as Session);
      });
    });

    const tripBody = main.querySelector<HTMLDivElement>('#trip-body')!;

    if (!tripData) {
      const orders = data.indents.filter((o) => o.session === session);
      const routeShops = (data.shops ?? []).filter((s) => s.RouteId === routeId && s.Active !== false && String(s.Active).toUpperCase() !== 'FALSE');
      tripBody.innerHTML = renderShopOrders(orders, routeShops, productMap) + renderDispatchForm(route, activeProducts, session, orders.length > 0);
      wireDispatchForm(tripBody, routeId, date, session, applyTrip, orderTotals(orders));
    } else if (tripData.trip.Status === 'Dispatched') {
      tripBody.innerHTML = renderSettleForm(tripData, productMap);
      pendingSave = wireSettleForm(tripBody, tripData, applyTrip, (saved) => trips.set(session, saved));
    } else {
      tripBody.innerHTML = renderSettled(tripData, productMap);
      wireReopen(tripBody, tripData, applyTrip);
    }
  }

  await load(localDateStr(), initialSession);
}

// Total quantity per product across the shops' orders for this trip.
function orderTotals(orders: Indent[]): Map<string, number> {
  const totals = new Map<string, number>();
  orders.forEach((o) => o.items.forEach((i) => totals.set(i.productId, (totals.get(i.productId) ?? 0) + i.qty)));
  return totals;
}

function orderSummary(items: { productId: string; qty: number }[], productMap: Map<string, Product>): string {
  return items.map((i) => `${productMap.get(i.productId)?.Name ?? i.productId} × ${i.qty}`).join(', ');
}

function renderShopOrders(orders: Indent[], routeShops: Shop[], productMap: Map<string, Product>): string {
  if (routeShops.length === 0) return '';
  const shopName = new Map(routeShops.map((s) => [s.ShopId, s.Name]));
  const orderedIds = new Set(orders.map((o) => o.shopId));
  const notOrdered = routeShops.filter((s) => !orderedIds.has(s.ShopId));
  const totals = Array.from(orderTotals(orders).entries()).map(([productId, qty]) => ({ productId, qty }));

  return `
    <details class="shop-orders" ${orders.length ? 'open' : ''}>
      <summary><strong>Shop orders</strong> · ${orders.length} of ${routeShops.length} shop${routeShops.length === 1 ? '' : 's'} ordered</summary>
      ${
        orders.length
          ? `<div class="table-scroll"><table class="line-items">
              <thead><tr><th>Shop</th><th>Order</th><th class="num">Value</th></tr></thead>
              <tbody>
                ${orders
                  .map(
                    (o) => `<tr>
                      <td class="nowrap">${escapeHtml(shopName.get(o.shopId) ?? o.shopId)}</td>
                      <td>${escapeHtml(orderSummary(o.items, productMap))}</td>
                      <td class="num">${money(o.total)}</td>
                    </tr>`,
                  )
                  .join('')}
              </tbody>
              <tfoot><tr><td>Total</td><td>${escapeHtml(orderSummary(totals, productMap))}</td><td class="num">${money(orders.reduce((s, o) => s + o.total, 0))}</td></tr></tfoot>
            </table></div>`
          : ''
      }
      ${notOrdered.length ? `<p class="muted">Not ordered: ${notOrdered.map((s) => escapeHtml(s.Name)).join(', ')}</p>` : ''}
    </details>
  `;
}

function renderAuditTrail(trip: Trip): string {
  const parts: string[] = [];
  if (trip.DispatchedBy) parts.push(`Dispatched by ${escapeHtml(trip.DispatchedBy)}`);
  if (trip.ReopenedBy) parts.push(`reopened by ${escapeHtml(trip.ReopenedBy)}`);
  if (trip.SettledBy) parts.push(`settled by ${escapeHtml(trip.SettledBy)}`);
  return parts.length ? `<p class="muted audit">${parts.join(' · ')}</p>` : '';
}

function renderDispatchForm(route: Route, products: Product[], session: Session, hasOrders: boolean): string {
  if (products.length === 0) {
    return '<p>No active products. Add some on the Products page before dispatching.</p>';
  }

  return `
    <form id="dispatch-form">
      <div class="field-row">
        <label>Driver <input type="text" name="driver" value="${escapeHtml(route.DefaultDriver)}" required /></label>
        <label>Vehicle <input type="text" name="vehicle" value="${escapeHtml(route.DefaultVehicle)}" required /></label>
      </div>
      <div class="field-row">
        ${hasOrders ? '<button type="button" id="fill-orders-btn" class="secondary">Fill from shop orders</button>' : ''}
        <button type="button" id="copy-last-btn" class="secondary">Same as last ${session} trip</button>
        <span id="copy-last-status" class="muted"></span>
      </div>
      <table class="line-items">
        <thead><tr><th>Product</th><th>Price</th><th>Qty dispatched</th><th>Value</th></tr></thead>
        <tbody>
          ${products
            .map(
              (p) => `
            <tr data-product-id="${escapeHtml(p.ProductId)}" data-price="${escapeHtml(p.Price)}">
              <td>${escapeHtml(p.Name)} <span class="unit">(${escapeHtml(p.Unit)})</span></td>
              <td>${money(p.Price)}</td>
              <td><input type="number" min="0" step="any" inputmode="decimal" class="qty-input" placeholder="0" /></td>
              <td class="line-total">₹0</td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
      </table>
      <p class="grand-total">Total: <span id="dispatch-total">₹0</span></p>
      <button type="submit">Dispatch</button>
      <p id="dispatch-error" class="error"></p>
    </form>
  `;
}

function wireDispatchForm(
  container: HTMLElement,
  routeId: string,
  date: string,
  session: Session,
  onDone: (tripData: TripWithItems) => void,
  shopTotals: Map<string, number>,
) {
  const form = container.querySelector<HTMLFormElement>('#dispatch-form');
  if (!form) return;

  const rows = Array.from(form.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  const totalEl = form.querySelector<HTMLSpanElement>('#dispatch-total')!;
  const errorEl = form.querySelector<HTMLParagraphElement>('#dispatch-error')!;

  function recalc() {
    let total = 0;
    rows.forEach((row) => {
      const price = Number(row.dataset.price);
      const qty = Number(row.querySelector<HTMLInputElement>('.qty-input')!.value) || 0;
      const value = price * qty;
      row.querySelector<HTMLTableCellElement>('.line-total')!.textContent = money(value);
      total += value;
    });
    totalEl.textContent = money(total);
  }

  rows.forEach((row) => row.querySelector('.qty-input')!.addEventListener('input', recalc));
  selectOnFocus(form);
  recalc();

  const copyBtn = form.querySelector<HTMLButtonElement>('#copy-last-btn')!;
  const copyStatus = form.querySelector<HTMLSpanElement>('#copy-last-status')!;

  // Start from what the shops ordered; staff add extra for walk-in sales and
  // shops that didn't order.
  function fillFromOrders() {
    rows.forEach((row) => {
      const qty = shopTotals.get(row.dataset.productId!);
      row.querySelector<HTMLInputElement>('.qty-input')!.value = qty ? String(qty) : '';
    });
    recalc();
    copyStatus.textContent = 'Filled with the shop order totals — add extra for shops that didn\'t order.';
  }
  if (shopTotals.size > 0) fillFromOrders();
  form.querySelector('#fill-orders-btn')?.addEventListener('click', fillFromOrders);
  copyBtn.addEventListener('click', async () => {
    copyBtn.disabled = true;
    copyStatus.textContent = 'Loading...';
    try {
      const last = await getLastTrip(routeId, session, date);
      if (!last) {
        copyStatus.textContent = `No earlier ${session} trip for this route.`;
        return;
      }
      const qtyByProduct = new Map(last.items.map((i) => [i.ProductId, Number(i.QtyDispatched) || 0]));
      rows.forEach((row) => {
        const qty = qtyByProduct.get(row.dataset.productId!);
        row.querySelector<HTMLInputElement>('.qty-input')!.value = qty ? String(qty) : '';
      });
      recalc();
      copyStatus.textContent = `Filled from the ${shortDate(last.trip.Date)} trip — adjust as needed.`;
    } catch (err) {
      copyStatus.textContent = (err as Error).message;
    } finally {
      copyBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';

    const driver = (form.querySelector('[name="driver"]') as HTMLInputElement).value;
    const vehicle = (form.querySelector('[name="vehicle"]') as HTMLInputElement).value;
    const items = rows
      .map((row) => ({
        productId: row.dataset.productId!,
        qty: Number(row.querySelector<HTMLInputElement>('.qty-input')!.value) || 0,
      }))
      .filter((i) => i.qty > 0);

    if (items.length === 0) {
      errorEl.textContent = 'Enter a quantity for at least one product.';
      return;
    }

    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitBtn.disabled = true;
    try {
      onDone(await dispatchTrip({ routeId, date, session, driver, vehicle, items }));
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      submitBtn.disabled = false;
    }
  });
}

function renderSettleForm(tripData: TripWithItems, productMap: Map<string, Product>): string {
  const { trip, items } = tripData;
  return `
    <div class="trip-summary">
      <p>Driver: ${escapeHtml(trip.Driver)} · Vehicle: ${escapeHtml(trip.Vehicle)}</p>
      <p>Dispatched total: ${money(trip.DispatchedTotal)}</p>
      ${renderAuditTrail(trip)}
    </div>
    <form id="settle-form">
      <div class="table-scroll">
      <table class="line-items">
        <thead>
          <tr>
            <th>Product</th><th class="num">Price</th>
            <th class="num">Dispatched</th><th class="num">Value</th>
            <th>Returned</th><th class="num">Returned value</th>
            <th class="num">Net due</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (i) => `
            <tr data-product-id="${escapeHtml(i.ProductId)}" data-price="${escapeHtml(i.Price)}" data-dispatched-value="${escapeHtml(i.DispatchedValue)}">
              <td>${escapeHtml(productMap.get(i.ProductId)?.Name ?? i.ProductId)}</td>
              <td class="num">${money(i.Price)}</td>
              <td class="num">${escapeHtml(Number(i.QtyDispatched))}</td>
              <td class="num">${money(i.DispatchedValue)}</td>
              <td><input type="number" min="0" max="${escapeHtml(i.QtyDispatched)}" step="any" inputmode="decimal" class="qty-returned" placeholder="0" value="${Number(i.QtyReturned) ? escapeHtml(i.QtyReturned) : ''}" /></td>
              <td class="num return-value">₹0</td>
              <td class="num net-due"><strong>₹0</strong></td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
      </table>
      </div>
      <p>Returned total: <span id="returned-total">₹0</span></p>
      <p>Amount due: <span id="amount-due">${money(trip.DispatchedTotal)}</span></p>
      <div class="field-row">
        <label>Cash handed over <input type="number" min="0" step="0.01" inputmode="decimal" id="cash-input" placeholder="0" value="${Number(trip.CashHandedOver) ? escapeHtml(trip.CashHandedOver) : ''}" /></label>
      </div>
      <p>Discrepancy: <span id="discrepancy">₹0</span></p>
      <div class="field-row">
        <button type="button" id="save-progress-btn">Save</button>
        <button type="submit">Settle</button>
      </div>
      <p id="settle-status"></p>
    </form>
  `;
}

function wireSettleForm(
  container: HTMLElement,
  tripData: TripWithItems,
  onDone: (tripData: TripWithItems) => void,
  onSaved: (tripData: TripWithItems) => void,
): () => Promise<void> {
  const form = container.querySelector<HTMLFormElement>('#settle-form');
  if (!form) return async () => {};

  const rows = Array.from(form.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  const returnedTotalEl = form.querySelector<HTMLSpanElement>('#returned-total')!;
  const amountDueEl = form.querySelector<HTMLSpanElement>('#amount-due')!;
  const discrepancyEl = form.querySelector<HTMLSpanElement>('#discrepancy')!;
  const cashInput = form.querySelector<HTMLInputElement>('#cash-input')!;
  const statusEl = form.querySelector<HTMLParagraphElement>('#settle-status')!;
  const saveBtn = form.querySelector<HTMLButtonElement>('#save-progress-btn')!;
  const settleBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const dispatchedTotal = Number(tripData.trip.DispatchedTotal);

  function currentInputs() {
    const items = rows.map((row) => ({
      productId: row.dataset.productId!,
      qtyReturned: Number(row.querySelector<HTMLInputElement>('.qty-returned')!.value) || 0,
    }));
    const cashHandedOver = Number(cashInput.value) || 0;
    return { items, cashHandedOver };
  }

  function recalc() {
    let returnedTotal = 0;
    rows.forEach((row) => {
      const price = Number(row.dataset.price);
      const qty = Number(row.querySelector<HTMLInputElement>('.qty-returned')!.value) || 0;
      const value = price * qty;
      row.querySelector<HTMLTableCellElement>('.return-value')!.textContent = money(value);
      row.querySelector<HTMLTableCellElement>('.net-due strong')!.textContent = money(Number(row.dataset.dispatchedValue) - value);
      returnedTotal += value;
    });
    const amountDue = dispatchedTotal - returnedTotal;
    const cash = Number(cashInput.value) || 0;
    const discrepancy = cash - amountDue;
    returnedTotalEl.textContent = money(returnedTotal);
    amountDueEl.textContent = money(amountDue);
    discrepancyEl.textContent =
      discrepancy < 0 ? `${money(-discrepancy)} short` : discrepancy > 0 ? `${money(discrepancy)} excess` : '₹0';
    discrepancyEl.className = discrepancy < 0 ? 'warn' : '';
    return { amountDue, cash };
  }

  // Only entries changed since the last save are worth a request.
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    recalc();
  };
  rows.forEach((row) => row.querySelector('.qty-returned')!.addEventListener('input', markDirty));
  cashInput.addEventListener('input', markDirty);
  selectOnFocus(form);
  recalc();

  async function saveCurrent(): Promise<void> {
    if (!dirty) return;
    const { items, cashHandedOver } = currentInputs();
    onSaved(await saveTripProgress({ tripId: tripData.trip.TripId, items, cashHandedOver }));
    dirty = false;
  }

  saveBtn.addEventListener('click', async () => {
    statusEl.textContent = '';
    statusEl.className = '';
    saveBtn.disabled = true;
    settleBtn.disabled = true;
    try {
      dirty = true; // an explicit Save always saves
      await saveCurrent();
      statusEl.textContent = 'Progress saved.';
      statusEl.className = 'ok';
    } catch (err) {
      statusEl.textContent = (err as Error).message;
      statusEl.className = 'error';
    } finally {
      saveBtn.disabled = false;
      settleBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.textContent = '';
    statusEl.className = '';

    const { items, cashHandedOver } = currentInputs();
    if (!(await confirmSettle(recalc()))) return;

    saveBtn.disabled = true;
    settleBtn.disabled = true;
    try {
      onDone(await settleTrip({ tripId: tripData.trip.TripId, items, cashHandedOver }));
    } catch (err) {
      statusEl.textContent = (err as Error).message;
      statusEl.className = 'error';
      saveBtn.disabled = false;
      settleBtn.disabled = false;
    }
  });

  return saveCurrent;
}

function confirmSettle({ amountDue, cash }: { amountDue: number; cash: number }): Promise<boolean> {
  const discrepancy = cash - amountDue;
  const discLabel =
    discrepancy === 0 ? 'none' : discrepancy < 0 ? `${money(-discrepancy)} SHORT` : `${money(discrepancy)} excess`;
  const lines = [
    `Amount due: ${money(amountDue)}`,
    `Cash handed over: ${money(cash)}`,
    `Discrepancy: ${discLabel}`,
    '',
    'Once settled, only an admin can reopen this trip.',
  ];
  if (cash === 0 && amountDue > 0) {
    lines.unshift('No cash has been entered!', '');
  }
  return confirmDialog({
    title: cash === 0 && amountDue > 0 ? 'Settle with no cash entered?' : 'Settle this trip?',
    message: lines.join('\n'),
    confirmLabel: 'Settle',
    danger: cash === 0 && amountDue > 0,
  });
}

function renderSettled(tripData: TripWithItems, productMap: Map<string, Product>): string {
  const { trip, items } = tripData;
  return `
    <div class="trip-summary settled">
      <p>Driver: ${escapeHtml(trip.Driver)} · Vehicle: ${escapeHtml(trip.Vehicle)}</p>
      <div class="table-scroll">
      <table class="line-items">
        <thead>
          <tr>
            <th>Product</th><th class="num">Price</th>
            <th class="num">Dispatched</th><th class="num">Value</th>
            <th class="num">Returned</th><th class="num">Returned value</th>
            <th class="num">Net due</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (i) => `
            <tr>
              <td>${escapeHtml(productMap.get(i.ProductId)?.Name ?? i.ProductId)}</td>
              <td class="num">${money(i.Price)}</td>
              <td class="num">${escapeHtml(Number(i.QtyDispatched))}</td>
              <td class="num">${money(i.DispatchedValue)}</td>
              <td class="num">${escapeHtml(Number(i.QtyReturned))}</td>
              <td class="num">${money(i.ReturnedValue)}</td>
              <td class="num"><strong>${money(Number(i.DispatchedValue) - Number(i.ReturnedValue))}</strong></td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="2">Total</td>
            <td class="num">${escapeHtml(items.reduce((s, i) => s + Number(i.QtyDispatched), 0))}</td>
            <td class="num">${money(trip.DispatchedTotal)}</td>
            <td class="num">${escapeHtml(items.reduce((s, i) => s + Number(i.QtyReturned), 0))}</td>
            <td class="num">${money(trip.ReturnedTotal)}</td>
            <td class="num">${money(trip.AmountDue)}</td>
          </tr>
        </tfoot>
      </table>
      </div>
      <p>Dispatched total: ${money(trip.DispatchedTotal)}</p>
      <p>Returned total: ${money(trip.ReturnedTotal)}</p>
      <p>Amount due: ${money(trip.AmountDue)}</p>
      <p>Cash handed over: ${money(trip.CashHandedOver)}</p>
      <p class="${Number(trip.Discrepancy) < 0 ? 'warn' : 'ok'}">Discrepancy: ${
        Number(trip.Discrepancy) < 0
          ? `${money(-Number(trip.Discrepancy))} short`
          : Number(trip.Discrepancy) > 0
            ? `${money(trip.Discrepancy)} excess`
            : 'none'
      }</p>
      ${renderAuditTrail(trip)}
    </div>
    ${
      isAdmin()
        ? `<div class="reopen">
            <button type="button" id="reopen-btn" class="secondary">Made a mistake? Reopen this trip</button>
            <p id="reopen-error" class="error"></p>
          </div>`
        : '<p class="muted reopen">Made a mistake? Ask an admin to reopen this trip.</p>'
    }
  `;
}

// Admins only (the server checks the role too). No confirmation: reopening
// keeps all the figures, and the trip is simply settled again.
function wireReopen(container: HTMLElement, tripData: TripWithItems, onDone: (tripData: TripWithItems) => void) {
  const btn = container.querySelector<HTMLButtonElement>('#reopen-btn');
  if (!btn) return;
  const errorEl = container.querySelector<HTMLParagraphElement>('#reopen-error')!;
  btn.addEventListener('click', async () => {
    errorEl.textContent = '';
    btn.disabled = true;
    try {
      onDone(await reopenTrip(tripData.trip.TripId));
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      btn.disabled = false;
    }
  });
}
