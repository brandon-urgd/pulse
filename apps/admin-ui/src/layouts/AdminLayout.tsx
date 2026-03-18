import { useEffect } from 'react';
import { Outlet, NavLink, Link, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';

const PAGE_TITLES: Record<string, string> = {
  '/admin/items': 'Items — Pulse',
  '/admin/settings': 'Settings — Pulse',
  '/admin/pulse-check': 'Pulse Check — Pulse',
};

const logoUrl = `${window.location.origin}/logo.svg`;

/**
 * Persistent admin shell — top bar with logo, wordmark, nav, theme toggle, avatar.
 * Requirements: 3.22, 11.8
 */
export default function AdminLayout() {
  const { theme, setTheme } = useTheme();
  const { user } = useAuth();
  const location = useLocation();

  useEffect(() => {
    const title = PAGE_TITLES[location.pathname];
    if (title) document.title = title;
  }, [location.pathname]);

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Top bar */}
      <header
        style={{
          height: 'var(--topbar-height)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 var(--space-6)',
          gap: 'var(--space-4)',
          background: 'var(--color-surface)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        {/* ur/gd logo + pulse wordmark — links to /admin/items */}
        <Link
          to="/admin/items"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginRight: 'var(--space-4)', textDecoration: 'none' }}
          aria-label="ur/gd pulse — go to items"
        >
          <img
            src={logoUrl}
            alt="ur/gd Studios logo"
            style={{
              height: 'clamp(2.5rem, 2rem + 2vw, 3rem)',
              width: 'auto',
              objectFit: 'contain',
              marginTop: 'clamp(-1.25rem, -1rem + -1vw, -1.5rem)',
              marginBottom: 'clamp(-1.25rem, -1rem + -1vw, -1.5rem)',
              flexShrink: 0,
            }}
          />
          {/* Pulse wordmark — sage accent, branding only */}
          <span
            style={{
              color: 'var(--color-accent-pulse)',
              fontWeight: 600,
              fontSize: 'var(--font-size-base)',
              letterSpacing: '0.02em',
            }}
          >
            {labels.layout.wordmark}
          </span>
        </Link>

        {/* Tab navigation */}
        <nav style={{ display: 'flex', gap: 'var(--space-1)', flex: 1 }}>
          <NavLink
            to="/admin/items"
            style={({ isActive }) => ({
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              fontWeight: isActive ? 600 : 400,
              background: isActive ? 'var(--color-interactive-subtle)' : 'transparent',
            })}
          >
            {labels.layout.navItems}
          </NavLink>
          <NavLink
            to="/admin/settings"
            style={({ isActive }) => ({
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              textDecoration: 'none',
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              fontWeight: isActive ? 600 : 400,
              background: isActive ? 'var(--color-interactive-subtle)' : 'transparent',
            })}
          >
            {labels.layout.navSettings}
          </NavLink>
        </nav>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
          aria-label={isDark ? labels.layout.themeToggleLight : labels.layout.themeToggleDark}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '1.2rem',
            padding: 'var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

        {/* Avatar */}
        <div
          aria-label={labels.layout.avatarAlt}
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-accent-pulse-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            color: 'var(--color-accent-pulse)',
            cursor: 'default',
          }}
        >
          {user?.email?.charAt(0).toUpperCase() ?? '?'}
        </div>
      </header>

      {/* Page content */}
      <main style={{ flex: 1, background: 'var(--color-bg)' }}>
        <Outlet />
      </main>

      {/* Footer */}
      <footer
        style={{
          marginTop: 'auto',
          padding: 'var(--space-8) var(--space-6)',
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-6)' }}>
          <div
            role="img"
            aria-label="ur/gd Studios logo"
            style={{
              height: 'clamp(8.4375rem, 15.8203125vw, 12.65625rem)',
              width: 'clamp(8.4375rem, 15.8203125vw, 12.65625rem)',
              backgroundImage: `url(${logoUrl})`,
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
              marginTop: '-5rem',
              marginBottom: '-6rem',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            <p style={{ margin: 0 }}>
              Quietly powerful, by{' '}
              <a href="https://www.urgdstudios.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent-pulse)', textDecoration: 'none' }}>
                ur/gd Studios
              </a>
            </p>
            <p style={{ margin: 0 }}>
              &copy; {new Date().getFullYear()}{' '}
              <a href="https://www.urgdstudios.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                ur/gd Studios LLC
              </a>
              {' · '}Seattle, WA
            </p>
            <p style={{ margin: 0, display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
              <a href="https://www.urgdstudios.com/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                Privacy Policy
              </a>
              <span aria-hidden="true"> · </span>
              <a href="https://www.urgdstudios.com/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                Terms
              </a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
