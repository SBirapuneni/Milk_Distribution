import { navHtml, wireNav } from '../components/nav';
import { currentStaff, getMasterData, resetStaffPin, saveStaff } from '../api';
import type { MasterData, Staff } from '../types';
import { escapeHtml } from '../util';

function appLink(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function shareMessage(person: { Name: string; Phone: string }, pin: string): string {
  return [`Hello ${person.Name},`, '', 'Your login for the milk distribution app:', appLink(), '', `Phone: ${person.Phone}`, `PIN: ${pin}`].join(
    '\n',
  );
}

export async function renderStaffAdmin(container: HTMLElement) {
  container.innerHTML =
    navHtml('staff') +
    `<main class="page">
      <h1>Staff</h1>
      <p class="muted">Everyone logs in with their own phone number and PIN. <strong>Admins</strong> can also manage products, routes, shops and staff, and reopen settled trips.</p>
      <div id="pin-box"></div>
      <div id="content">Loading...</div>
    </main>`;
  wireNav(container);

  const content = container.querySelector<HTMLDivElement>('#content')!;
  const pinBox = container.querySelector<HTMLDivElement>('#pin-box')!;
  const myId = currentStaff()?.id;

  function render(master: MasterData) {
    const people = [...master.staff].sort((a, b) => Number(b.Active) - Number(a.Active) || a.Name.localeCompare(b.Name));
    content.innerHTML = `
      <div class="table-scroll">
      <table class="line-items">
        <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${people
            .map(
              (p) => `
            <tr>
              <td>${escapeHtml(p.Name)}${p.StaffId === myId ? ' <span class="muted">(you)</span>' : ''}</td>
              <td class="nowrap">${escapeHtml(p.Phone)}</td>
              <td>${p.Role === 'admin' ? 'Admin' : 'Staff'}</td>
              <td>${p.Active ? 'Active' : '<span class="muted">Inactive</span>'}</td>
              <td class="nowrap">
                <button type="button" class="secondary edit-btn" data-id="${escapeHtml(p.StaffId)}">Edit</button>
                <button type="button" class="secondary pin-btn" data-id="${escapeHtml(p.StaffId)}">New PIN</button>
              </td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      </div>
      <div id="form-container">${renderForm()}</div>
    `;

    content.querySelectorAll<HTMLButtonElement>('.edit-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        const person = master.staff.find((s) => s.StaffId === btn.dataset.id);
        content.querySelector('#form-container')!.innerHTML = renderForm(person);
        wireForm(master);
        content.querySelector('#form-container')!.scrollIntoView({ behavior: 'smooth' });
      }),
    );

    content.querySelectorAll<HTMLButtonElement>('.pin-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const person = master.staff.find((s) => s.StaffId === btn.dataset.id)!;
        if (!window.confirm(`Create a new PIN for ${person.Name}? Their current PIN stops working and they'll be logged out on other phones.`)) return;
        btn.disabled = true;
        try {
          const { pin } = await resetStaffPin(person.StaffId);
          showPin(person, pin);
        } catch (err) {
          window.alert((err as Error).message);
        } finally {
          btn.disabled = false;
        }
      }),
    );

    wireForm(master);
  }

  function renderForm(editing?: Staff): string {
    const isMe = editing?.StaffId === myId;
    return `
      <h2>${editing ? `Edit ${escapeHtml(editing.Name)}` : 'Add a person'}</h2>
      <form id="staff-form">
        <input type="hidden" name="staffId" value="${escapeHtml(editing?.StaffId)}" />
        <div class="field-row">
          <label>Name <input type="text" name="name" value="${escapeHtml(editing?.Name)}" required /></label>
          <label>Phone (WhatsApp) <input type="tel" name="phone" inputmode="numeric" value="${escapeHtml(editing?.Phone)}" required /></label>
          <label>Role
            <select name="role" ${isMe ? 'disabled' : ''}>
              <option value="staff" ${editing?.Role === 'admin' ? '' : 'selected'}>Staff</option>
              <option value="admin" ${editing?.Role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          </label>
          <label><input type="checkbox" name="active" ${editing && !editing.Active ? '' : 'checked'} ${isMe ? 'disabled' : ''} /> Active</label>
        </div>
        ${isMe ? '<p class="muted">You can\'t change your own role or deactivate yourself — ask another admin.</p>' : ''}
        <div class="field-row">
          <button type="submit">${editing ? 'Save changes' : 'Add and create PIN'}</button>
          ${editing ? '<button type="button" id="cancel-edit" class="secondary">Cancel</button>' : ''}
        </div>
        <p id="staff-error" class="error"></p>
      </form>
    `;
  }

  function wireForm(master: MasterData) {
    const form = content.querySelector<HTMLFormElement>('#staff-form')!;
    const errorEl = content.querySelector<HTMLParagraphElement>('#staff-error')!;
    form.querySelector('#cancel-edit')?.addEventListener('click', () => render(master));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.textContent = '';
      const fd = new FormData(form);
      const staffId = String(fd.get('staffId') || '') || undefined;
      const isMe = staffId === myId;
      const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      submitBtn.disabled = true;
      try {
        const result = await saveStaff({
          staffId,
          name: String(fd.get('name')),
          phone: String(fd.get('phone')),
          // Disabled fields aren't submitted; keep your own role/status as is.
          role: isMe ? 'admin' : (String(fd.get('role')) as 'admin' | 'staff'),
          active: isMe ? true : fd.get('active') === 'on',
        });
        render(result);
        if (result.pin) showPin(result.staff.find((s) => s.StaffId === result.staffId)!, result.pin);
      } catch (err) {
        errorEl.textContent = (err as Error).message;
        submitBtn.disabled = false;
      }
    });
  }

  // The PIN exists in readable form only in this response (the server keeps
  // a hash), so show it prominently with ways to pass it on right away.
  function showPin(person: Staff, pin: string) {
    const message = shareMessage(person, pin);
    const wa = `https://wa.me/91${encodeURIComponent(person.Phone)}?text=${encodeURIComponent(message)}`;
    pinBox.innerHTML = `
      <div class="callout pin-callout">
        <p>PIN for <strong>${escapeHtml(person.Name)}</strong>: <span class="pin">${escapeHtml(pin)}</span></p>
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
        window.prompt('Copy this message:', message);
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
