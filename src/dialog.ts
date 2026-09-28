// In-page replacements for window.confirm / alert / prompt. The browser's own
// pop-ups are silently blocked in some places this app is used — notably the
// in-app browsers of WhatsApp and similar apps (where shop owners open their
// order link) — and a blocked confirm() reads as "Cancel", so buttons just
// appeared to do nothing.

import { escapeHtml } from './util';

interface DialogOptions {
  title: string;
  message?: string; // plain text; newlines kept
  confirmLabel?: string;
  cancelLabel?: string | null; // null = no cancel button (alert)
  danger?: boolean;
  copyText?: string; // shows a selectable text box with a Copy button
}

function open(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">${escapeHtml(opts.title)}</h2>
        ${opts.message ? `<p class="dialog-message">${escapeHtml(opts.message)}</p>` : ''}
        ${opts.copyText !== undefined ? `<textarea class="dialog-copy" readonly rows="6">${escapeHtml(opts.copyText)}</textarea>` : ''}
        <div class="dialog-actions">
          ${opts.cancelLabel === null ? '' : `<button type="button" class="secondary" data-answer="no">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>`}
          <button type="button" class="${opts.danger ? 'danger' : ''}" data-answer="yes">${escapeHtml(opts.confirmLabel ?? 'OK')}</button>
        </div>
      </div>
    `;

    function close(answer: boolean) {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      previousFocus?.focus?.();
      resolve(answer);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false); // tap outside = cancel
      const answer = (e.target as HTMLElement).closest<HTMLElement>('[data-answer]')?.dataset.answer;
      if (answer) close(answer === 'yes');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);

    const copyBox = overlay.querySelector<HTMLTextAreaElement>('.dialog-copy');
    if (copyBox) {
      copyBox.focus();
      copyBox.select();
    } else {
      overlay.querySelector<HTMLButtonElement>('[data-answer="yes"]')!.focus();
    }
  });
}

/** Resolves true if the user confirms, false if they cancel. */
export function confirmDialog(opts: Omit<DialogOptions, 'copyText'>): Promise<boolean> {
  return open(opts);
}

export async function alertDialog(title: string, message?: string): Promise<void> {
  await open({ title, message, confirmLabel: 'OK', cancelLabel: null });
}

/** Shows text the user can select and copy, when the clipboard API isn't available. */
export async function copyDialog(title: string, text: string): Promise<void> {
  await open({ title, message: 'Select the text below and copy it.', copyText: text, confirmLabel: 'Done', cancelLabel: null });
}
