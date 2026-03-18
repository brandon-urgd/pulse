import { useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';

const PAGE_TITLES: Record<string, string> = {
  '/admin/items': 'Items — Pulse',
  '/admin/settings': 'Settings — Pulse',
  '/admin/pulse-check': 'Pulse Check — Pulse',
};

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
        {/* ur/gd logo + pulse wordmark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginRight: 'var(--space-4)' }}>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', letterSpacing: '0.05em' }}>
            {labels.layout.logoAlt}
          </span>
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
        </div>

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
    </div>
  );
}
