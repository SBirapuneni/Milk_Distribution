import { DEMO_MODE, DEMO_STAFF, staffLogin } from '../api';

// Staff login: each person has their own phone + PIN, created by an admin on
// the Staff page.
export function renderPasscode(container: HTMLElement, onSuccess: () => void, message = '') {
  container.innerHTML = `
    <div class="passcode-screen">
      <h1>Milk Distribution</h1>
      <p class="muted">Staff login</p>
      <form id="login-form" class="stacked-form">
        <input type="tel" id="phone-input" placeholder="Phone number" inputmode="numeric" autocomplete="tel" required />
        <input type="password" id="pin-input" placeholder="6-digit PIN" inputmode="numeric" autocomplete="current-password" maxlength="6" pattern="\\d{6}" required />
        <button type="submit">Log in</button>
      </form>
      <p id="login-error" class="error"></p>
      <a href="#/order" class="small-link">Shop owner? Place your order here &rarr;</a>
      ${
        DEMO_MODE
          ? `<p class="hint">Demo mode — no database connected; data resets on reload. Admin: ${DEMO_STAFF[0].phone} / PIN ${DEMO_STAFF[0].pin}. Staff: ${DEMO_STAFF[1].phone} / PIN ${DEMO_STAFF[1].pin}.</p>`
          : ''
      }
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>('#login-form')!;
  const phoneInput = container.querySelector<HTMLInputElement>('#phone-input')!;
  const pinInput = container.querySelector<HTMLInputElement>('#pin-input')!;
  const errorEl = container.querySelector<HTMLParagraphElement>('#login-error')!;
  const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  errorEl.textContent = message;
  phoneInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submitBtn.disabled = true;
    try {
      await staffLogin(phoneInput.value.trim(), pinInput.value.trim());
      onSuccess();
    } catch (err) {
      errorEl.textContent = (err as Error).message;
      submitBtn.disabled = false;
    }
  });
}
