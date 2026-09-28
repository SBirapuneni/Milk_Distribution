import { navHtml, wireNav } from '../components/nav';
import { getMasterData, resetShopPin, saveShop } from '../api';
import type { MasterData, Shop } from '../types';
import { escapeHtml } from '../util';
import { alertDialog, confirmDialog, copyDialog } from '../dialog';

function isActive(value: boolean): boolean {
  return value !== false && String(value).toUpperCase() !== 'FALSE';
}

function orderLink(): string {
  return `${window.location.origin}${window.location.pathname}#/order`;
}

function shareMessage(shop: { Name: string; OwnerName: string; Phone: string }, pin: string): string {
  return [
    `Hello ${shop.OwnerName || shop.Name},`,
    '',
    'You can now place your daily milk order online:',
    orderLink(),
    '',
    `Phone: ${shop.Phone}`,
    `PIN: ${pin}`,
    '',
    'Morning delivery: order by 9 PM the night before.',
    'Evening delivery: order by 12 noon the same day.',
  ].join('\n');
}

export async function renderShopsAdmin(container: HTMLElement) {
  container.innerHTML =
    navHtml('shops') +
    '<main class="page"><h1>Shops</h1><div id="pin-box"></div><div id="content">Loading...</div></main>';
  wireNav(container);

  const content = container.querySelector<HTMLDivElement>('#content')!;
  const pinBox = container.querySelector<HTMLDivElement>('#pin-box')!;

  function render(master: MasterData) {
    const routeName = new Map(master.routes.map((r) => [r.RouteId, r.Name]));
    const byRoute = new Map<string, Shop[]>();
    master.shops.forEach((s) => byRoute.set(s.RouteId, [...(byRoute.get(s.RouteId) ?? []), s]));

    const list = master.shops.length
      ? Array.from(byRoute.entries())
          .sort((a, b) => (routeName.get(a[0]) ?? '').localeCompare(routeName.get(b[0]) ?? ''))
          .map(
            ([routeId, shops]) => `
          <h2>${escapeHtml(routeName.get(routeId) ?? 'Unknown route')} <span class="muted">· ${shops.length} shop${shops.length === 1 ? '' : 's'}</span></h2>
          <div class="table-scroll">
          <table class="line-items">
            <thead><tr><th>Shop</th><th>Owner</th><th>Phone</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${shops
                .map(
                  (s) => `
                <tr>
                  <td>${escapeHtml(s.Name)}</td>
                  <td>${escapeHtml(s.OwnerName)}</td>
                  <td class="nowrap">${escapeHtml(s.Phone)}</td>
                  <td>${isActive(s.Active) ? 'Active' : '<span class="muted">Inactive</span>'}</td>
                  <td class="nowrap">
                    <button type="button" class="secondary edit-btn" data-id="${escapeHtml(s.ShopId)}">Edit</button>
                    <button type="button" class="secondary pin-btn" data-id="${escapeHtml(s.ShopId)}">New PIN</button>
                  </td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
          </div>`,
          )
          .join('')
      : '<p>No shops yet. Add the first one below — it gets a PIN you can share on WhatsApp.</p>';

    content.innerHTML = `${list}<div id="form-container">${renderForm(master)}</div>`;

    content.querySelectorAll<HTMLButtonElement>('.edit-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        const shop = master.shops.find((s) => s.ShopId === btn.dataset.id);
        content.querySelector('#form-container')!.innerHTML = renderForm(master, shop);
        wireForm(master);
        content.querySelector('#form-container')!.scrollIntoView({ behavior: 'smooth' });
      }),
    );

    content.querySelectorAll<HTMLButtonElement>('.pin-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const shop = master.shops.find((s) => s.ShopId === btn.dataset.id)!;
        const ok = await confirmDialog({
          title: `Create a new PIN for ${shop.Name}?`,
          message: 'Their current PIN will stop working.',
          confirmLabel: 'Create new PIN',
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const { pin } = await resetShopPin(shop.ShopId);
          showPin(shop, pin);
        } catch (err) {
          await alertDialog('Could not create a new PIN', (err as Error).message);
        } finally {
          btn.disabled = false;
        }
      }),
    );

    wireForm(master);
  }

  function renderForm(master: MasterData, editing?: Shop): string {
    const activeRoutes = master.routes.filter((r) => isActive(r.Active) || r.RouteId === editing?.RouteId);
    return `
      <h2>${editing ? `Edit ${escapeHtml(editing.Name)}` : 'Add shop'}</h2>
      <form id="shop-form">
        <input type="hidden" name="shopId" value="${escapeHtml(editing?.ShopId)}" />
        <div class="field-row">
          <label>Shop name <input type="text" name="name" value="${escapeHtml(editing?.Name)}" required /></label>
          <label>Owner name <input type="text" name="ownerName" value="${escapeHtml(editing?.OwnerName)}" /></label>
          <label>Phone (WhatsApp) <input type="tel" name="phone" inputmode="numeric" value="${escapeHtml(editing?.Phone)}" required /></label>
          <label>Route
            <select name="routeId" required>
              <option value="">Pick a route</option>
              ${activeRoutes
                .map((r) => `<option value="${escapeHtml(r.RouteId)}" ${r.RouteId === editing?.RouteId ? 'selected' : ''}>${escapeHtml(r.Name)}</option>`)
                .join('')}
            </select>
          </label>
          <label><input type="checkbox" name="active" ${editing && !isActive(editing.Active) ? '' : 'checked'} /> Active</label>
        </div>
        <div class="field-row">
          <button type="submit">${editing ? 'Save changes' : 'Add shop and create PIN'}</button>
          ${editing ? '<button type="button" id="cancel-edit" class="secondary">Cancel</button>' : ''}
        </div>
        <p id="shop-error" class="error"></p>
      </form>
    `;
  }

  function wireForm(master: MasterData) {
    const form = content.querySelector<HTMLFormElement>('#shop-form')!;
    const errorEl = content.querySelector<HTMLParagraphElement>('#shop-error')!;
    form.querySelector('#cancel-edit')?.addEventListener('click', () => render(master));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      const fd = new FormData(form);
      const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submitBtn.disabled = true;
      try {
        const result = await saveShop({
          shopId: String(fd.get('shopId') || '') || undefined,
          name: String(fd.get('name')),
          ownerName: String(fd.get('ownerName')),
          phone: String(fd.get('phone')),
          routeId: String(fd.get('routeId')),
          active: fd.get('active') === 'on',
        });
        render(result);
        if (result.pin) showPin(result.shops.find((s) => s.ShopId === result.shopId)!, result.pin);
      } catch (err) {
        errorEl.textContent = (err as Error).message;
        submitBtn.disabled = false;
      }
    });
  }

  // The PIN exists in readable form only in this response: the server keeps
  // just a hash. So show it prominently with ways to pass it on right away.
  function showPin(shop: Shop, pin: string) {
    const message = shareMessage(shop, pin);
    const wa = `https://wa.me/91${encodeURIComponent(shop.Phone)}?text=${encodeURIComponent(message)}`;
    pinBox.innerHTML = `
      <div class="callout pin-callout">
        <p>PIN for <strong>${escapeHtml(shop.Name)}</strong>: <span class="pin">${escapeHtml(pin)}</span></p>
        <p class="muted">This PIN is shown only once. Share it now — if it's lost, just create a new one.</p>
        <div class="field-row">
          <a class="button-link" href="${escapeHtml(wa)}" target="_blank" rel="noopener">Share on WhatsApp</a>
          <button type="button" id="copy-msg" class="secondary">Copy message</button>
          <button type="button" id="dismiss-pin" class="secondary">Done</button>
        </div>
      </div>
    `;
    pinBox.querySelector('#copy-msg')!.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(message);
        btn.textContent = 'Copied ✓';
      } catch {
        await copyDialog('Copy this message', message);
      }
    });
    pinBox.querySelector('#dismiss-pin')!.addEventListener('click', () => (pinBox.innerHTML = ''));
    pinBox.scrollIntoView({ behavior: 'smooth' });
  }

  try {
    render(await getMasterData());
  } catch (err) {
    content.innerHTML = `<p class="error">Failed to load: ${escapeHtml((err as Error).message)}</p>`;
  }
}
