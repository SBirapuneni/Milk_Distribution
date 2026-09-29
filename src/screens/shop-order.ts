import { DEMO_MODE, DEMO_SHOPS, hasShopSession, lastShopPhone, shopHome, shopLogin, shopLogout, shopSaveOrder } from '../api';
import type { Session, ShopHome, ShopSlot } from '../types';
import { addDays, escapeHtml, money } from '../util';
import { confirmDialog } from '../dialog';

// The shop owner's side of the app (#/order): log in with phone + PIN, then
// place or change orders for the upcoming deliveries until their cutoff. It
// never shows the staff navigation or any other shop's data.

export async function renderShopPortal(container: HTMLElement) {
  if (!hasShopSession()) {
    renderLogin(container, lastShopPhone());
    return;
  }
  container.innerHTML = '<main class="page"><p>Loading...</p></main>';
  try {
    renderOrders(container, await shopHome());
  } catch (err) {
    if (!hasShopSession()) renderLogin(container, lastShopPhone(), (err as Error).message);
    else container.innerHTML = `<main class="page"><p class="error">${escapeHtml((err as Error).message)}</p><p><a href="#/order" onclick="location.reload()">Try again</a></p></main>`;
  }
}

function renderLogin(container: HTMLElement, phone: string, error = '') {
  container.innerHTML = `
    <div class="passcode-screen">
      <h1>Place your order</h1>
      <p class="muted">Log in with the phone number and PIN your distributor gave you.</p>
      <form id="shop-login-form" class="stacked-form">
        <input type="tel" id="shop-phone" placeholder="Phone number" inputmode="numeric" autocomplete="tel" value="${escapeHtml(phone)}" required />
        <input type="password" id="shop-pin" placeholder="6-digit PIN" inputmode="numeric" autocomplete="off" maxlength="6" pattern="\\d{6}" required />
        <button type="submit">Log in</button>
      </form>
      <p id="shop-login-error" class="error">${escapeHtml(error)}</p>
      ${
        DEMO_MODE
          ? `<p class="hint">Demo mode — try phone ${DEMO_SHOPS[0].phone} with PIN ${DEMO_SHOPS[0].pin}.</p>`
          : ''
      }
      <a href="#/" class="muted small-link">Staff login</a>
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>('#shop-login-form')!;
  const phoneInput = container.querySelector<HTMLInputElement>('#shop-phone')!;
  const pinInput = container.querySelector<HTMLInputElement>('#shop-pin')!;
  const errorEl = container.querySelector<HTMLParagraphElement>('#shop-login-error')!;
  const submitBtn = form.querySelector<HTMLButtonElement>('button')!;
  (phoneInput.value ? pinInput : phoneInput).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      renderOrders(container, await shopLogin(phoneInput.value.trim(), pinInput.value.trim()));
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      submitBtn.disabled = false;
    }
  });
}

// ---- Labels ---------------------------------------------------------------

function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
}

function slotLabel(slot: ShopSlot, today: string): string {
  return `${dayLabel(slot.date, today)} ${slot.session === 'Morning' ? 'morning' : 'evening'}`;
}

/** '2026-09-29' → 'Tue, 29 Sep' (or 'Tuesday, 29 Sep' with long). */
function dateLabel(date: string, long = false): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: long ? 'long' : 'short', day: 'numeric', month: 'short' });
}

/** 'yyyy-MM-dd HH:mm' → '9:00 PM today (Mon, 28 Sep)'. */
function cutoffLabel(cutoff: string, today: string): string {
  const [date, time] = cutoff.split(' ');
  const [h, min] = time.split(':').map(Number);
  const clock = `${((h + 11) % 12) + 1}:${String(min).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  const day = dayLabel(date, today);
  return day === 'Today' || day === 'Tomorrow' ? `${clock} ${day.toLowerCase()} (${dateLabel(date)})` : `${clock}, ${dateLabel(date)}`;
}

// ---- Order screen ------------------------------------------------------------

function renderOrders(container: HTMLElement, home: ShopHome, selected?: { date: string; session: Session }, status = '') {
  const today = home.now.slice(0, 10);
  const slot =
    home.slots.find((s) => selected && s.date === selected.date && s.session === selected.session) ??
    home.slots.find((s) => !s.order) ??
    home.slots[0];

  container.innerHTML = `
    <main class="page shop-page">
      <div class="shop-header">
        <div>
          <h1>${escapeHtml(home.shop.name)}</h1>
          <p class="muted">${escapeHtml(home.shop.routeName)}</p>
        </div>
        <button type="button" id="shop-logout" class="secondary">Log out</button>
      </div>
      ${slot ? '' : '<p>No deliveries are open for ordering right now. Please check back later.</p>'}
      <div id="slot-area"></div>
    </main>
  `;

  container.querySelector('#shop-logout')!.addEventListener('click', () => {
    shopLogout();
    renderLogin(container, lastShopPhone());
  });

  if (!slot) return;
  const area = container.querySelector<HTMLDivElement>('#slot-area')!;
  const qtyFor = (productId: string) => slot.order?.items.find((i) => i.productId === productId)?.qty ?? 0;

  area.innerHTML = `
    <div class="session-tabs slot-tabs">
      ${home.slots
        .map(
          (s) => `<button type="button" class="session-tab ${s === slot ? 'active' : ''}" data-session="${s.session}" data-date="${s.date}">
            ${escapeHtml(slotLabel(s, today))}
            <span class="tab-date">${escapeHtml(dateLabel(s.date))}</span>
            <span class="tab-status ${s.order && s.order.items.length ? '' : 'pending'}">${s.order && s.order.items.length ? 'Ordered ✓' : 'Not ordered'}</span>
          </button>`,
        )
        .join('')}
    </div>
    <h2 class="delivery-heading">${slot.session === 'Morning' ? '☀️ Morning' : '🌙 Evening'} delivery · ${escapeHtml(dateLabel(slot.date, true))}</h2>
    <p class="cutoff">Place or change this order until <strong>${escapeHtml(cutoffLabel(slot.cutoff, today))}</strong>.</p>
    <form id="order-form">
      <div class="table-scroll">
      <table class="line-items">
        <thead><tr><th>Product</th><th class="num">Price</th><th>Quantity</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${home.products
            .map((p) => {
              const qty = qtyFor(p.ProductId);
              return `
            <tr data-product-id="${escapeHtml(p.ProductId)}" data-price="${escapeHtml(p.Price)}">
              <td>${escapeHtml(p.Name)} <span class="unit">(${escapeHtml(p.Unit)})</span></td>
              <td class="num">${money(p.Price)}</td>
              <td><input type="number" min="0" step="1" inputmode="numeric" class="qty-input" placeholder="0" value="${qty ? escapeHtml(qty) : ''}" /></td>
              <td class="num line-total">₹0</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
      </div>
      <p class="grand-total">Total: <span id="order-total">₹0</span></p>
      <div class="field-row">
        <button type="submit">Save order</button>
        ${home.lastOrder ? '<button type="button" id="copy-last" class="secondary">Same as last order</button>' : ''}
        <button type="button" id="clear-order" class="secondary">Clear</button>
      </div>
      <p id="order-status" class="${status ? 'ok' : ''}">${escapeHtml(status)}</p>
    </form>
  `;

  const form = area.querySelector<HTMLFormElement>('#order-form')!;
  const rows = Array.from(form.querySelectorAll<HTMLTableRowElement>('tbody tr'));
  const totalEl = form.querySelector<HTMLSpanElement>('#order-total')!;
  const statusEl = form.querySelector<HTMLParagraphElement>('#order-status')!;
  const inputOf = (row: HTMLTableRowElement) => row.querySelector<HTMLInputElement>('.qty-input')!;
  let dirty = false;

  function recalc() {
    let total = 0;
    rows.forEach((row) => {
      const value = (Number(inputOf(row).value) || 0) * Number(row.dataset.price);
      row.querySelector('.line-total')!.textContent = money(value);
      total += value;
    });
    totalEl.textContent = money(total);
  }

  rows.forEach((row) => {
    const input = inputOf(row);
    input.addEventListener('input', () => {
      dirty = true;
      statusEl.textContent = '';
      recalc();
    });
    input.addEventListener('focus', () => input.select());
  });
  recalc();

  area.querySelectorAll<HTMLButtonElement>('.slot-tabs .session-tab').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (dirty && !(await confirmDialog({ title: 'Discard your changes?', message: 'You have changes that are not saved yet.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true }))) return;
      renderOrders(container, home, { date: btn.dataset.date!, session: btn.dataset.session as Session });
    }),
  );

  form.querySelector('#copy-last')?.addEventListener('click', () => {
    const last = new Map(home.lastOrder!.items.map((i) => [i.productId, i.qty]));
    rows.forEach((row) => {
      const qty = last.get(row.dataset.productId!);
      inputOf(row).value = qty ? String(qty) : '';
    });
    dirty = true;
    recalc();
    statusEl.className = 'muted';
    statusEl.textContent = 'Filled from your last order — check and tap Save order.';
  });

  form.querySelector('#clear-order')!.addEventListener('click', () => {
    rows.forEach((row) => (inputOf(row).value = ''));
    dirty = true;
    recalc();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = rows
      .map((row) => ({ productId: row.dataset.productId!, qty: Number(inputOf(row).value) || 0 }))
      .filter((i) => i.qty > 0);
    if (items.length === 0 && !slot.order?.items.length) {
      statusEl.className = 'error';
      statusEl.textContent = 'Enter a quantity for at least one product.';
      return;
    }
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submitBtn.disabled = true;
    statusEl.className = 'muted';
    statusEl.textContent = 'Saving...';
    try {
      const updated = await shopSaveOrder({ date: slot.date, session: slot.session, items });
      const message = items.length
        ? `Order saved ✓ You can change it until ${cutoffLabel(slot.cutoff, today)}.`
        : 'Order cancelled.';
      renderOrders(container, updated, { date: slot.date, session: slot.session }, message);
    } catch (err) {
      const message = (err as Error).message;
      if (!hasShopSession()) {
        renderLogin(container, lastShopPhone(), message);
        return;
      }
      statusEl.className = 'error';
      statusEl.textContent = message;
      submitBtn.disabled = false;
    }
  });
}
