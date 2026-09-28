import { currentStaff, isAdmin, logout } from '../api';
import { escapeHtml } from '../util';

// Master-data and people management are admin-only on the server too; the
// links are hidden for other staff so they don't lead to "Only an admin can
// do this" errors.
const links = [
  { href: '#/', label: 'Dashboard', key: 'dashboard', admin: false },
  { href: '#/products', label: 'Products', key: 'products', admin: true },
  { href: '#/routes', label: 'Routes', key: 'routes', admin: true },
  { href: '#/shops', label: 'Shops', key: 'shops', admin: true },
  { href: '#/staff', label: 'Staff', key: 'staff', admin: true },
  { href: '#/history', label: 'History', key: 'history', admin: false },
  { href: '#/analytics', label: 'Analytics', key: 'analytics', admin: false },
];

export function navHtml(active: string): string {
  const admin = isAdmin();
  return `
    <nav class="nav">
      ${links
        .filter((l) => admin || !l.admin)
        .map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`)
        .join('')}
      <span class="nav-user">${escapeHtml(currentStaff()?.name ?? '')}</span>
      <button id="logout-btn" class="link-btn" type="button">Log out</button>
    </nav>
  `;
}

export function wireNav(container: ParentNode) {
  container.querySelector('#logout-btn')?.addEventListener('click', async () => {
    await logout();
    window.location.hash = '#/';
    window.location.reload();
  });
}
