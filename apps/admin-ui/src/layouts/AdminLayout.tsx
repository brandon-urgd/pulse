import { useEffect, useRef, useState } from 'react';
import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';

const PAGE_TITLES: Record<string, string> = {
  '/admin/items': 'Items — Pulse',
  '/admin/settings': 'Settings — Pulse',
  '/admin/pulse-check': 'Pulse Check — Pulse',
};

const logoUrl = `${window.location.origin}/logo.svg`;

const NAV_LINKS = [
  { to: '/admin/items', label: () => labels.layout.navItems },
  { to: '/admin/pulse-check', label: () => labels.layout.navPulseCheck },
  { to: '/admin/settings', label: () => labels.layout.navSettings },
];

/**
 * Persistent admin shell — top bar with logo, wordmark, nav, theme toggle, avatar.
 * On mobile: hamburger menu replaces tab nav. No horizontal scroll.
 */
export default function AdminLayout() {
  const { theme, setTheme } = useTheme();
  const { user, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const title = PAGE_TITLES[location.pathname];
    if (title) document.title = title;
  }, [location.pathname]);

  // Close menu on route change
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  // Close menu on Escape
  useEffect(() => {
    if (!menuOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [menuOpen]);

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  async function handleSignOut() {
    await signOut();
    navigate('/admin/login', { replace: true });
  }

  const navLinkStyle = (isActive: boolean): React.CSSProperties => ({
    padding: 'var(--space-2) var(--space-3)',
    textDecoration: 'none',
    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
    fontWeight: isActive ? 600 : 400,
    borderBottom: isActive ? '2px solid var(--color-accent-pulse)' : '2px solid transparent',
    paddingBottom: 'calc(var(--space-2) - 2px)',
    whiteSpace: 'nowrap' as const,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', overflowX: 'hidden' }}>
      {/* Top bar */}
      <header
        style={{
          height: 'var(--topbar-height)',
          borderBottom: '1px solid var(--color-border)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 var(--space-4)',
          gap: 'var(--space-3)',
          background: 'var(--color-surface)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
          boxSizing: 'border-box',
          width: '100%',
        }}
      >
        {/* Logo + wordmark */}
        <Link
          to="/admin/items"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', textDecoration: 'none', flexShrink: 0 }}
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

        {/* Desktop tab nav */}
        <nav className="desktop-nav" style={{ display: 'flex', gap: 'var(--space-1)', flex: 1 }}>
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink key={to} to={to} style={({ isActive }) => navLinkStyle(isActive)}>
              {label()}
            </NavLink>
          ))}
        </nav>

        {/* Spacer for mobile (pushes controls right) */}
        <div className="mobile-spacer" style={{ flex: 1 }} />

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
            flexShrink: 0,
          }}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

        {/* Avatar — desktop only, links to settings */}
        <Link
          to="/admin/settings"
          aria-label="Go to settings"
          className="desktop-avatar"
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
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          {user?.email?.charAt(0).toUpperCase() ?? '?'}
        </Link>

        {/* Hamburger — mobile only */}
        <div ref={menuRef} className="mobile-menu-wrap" style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-haspopup="true"
            onClick={() => setMenuOpen(o => !o)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 'var(--space-2)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              justifyContent: 'center',
              alignItems: 'center',
              width: 36,
              height: 36,
            }}
          >
            {/* Hamburger icon — animates to X when open */}
            <span style={{
              display: 'block', width: 20, height: 2,
              background: 'currentColor', borderRadius: 2,
              transition: 'transform 0.2s, opacity 0.2s',
              transform: menuOpen ? 'translateY(7px) rotate(45deg)' : 'none',
            }} />
            <span style={{
              display: 'block', width: 20, height: 2,
              background: 'currentColor', borderRadius: 2,
              transition: 'opacity 0.2s',
              opacity: menuOpen ? 0 : 1,
            }} />
            <span style={{
              display: 'block', width: 20, height: 2,
              background: 'currentColor', borderRadius: 2,
              transition: 'transform 0.2s, opacity 0.2s',
              transform: menuOpen ? 'translateY(-7px) rotate(-45deg)' : 'none',
            }} />
          </button>

          {/* Dropdown menu */}
          {menuOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + var(--space-2))',
                right: 0,
                minWidth: 200,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                overflow: 'hidden',
                zIndex: 200,
              }}
            >
              {NAV_LINKS.map(({ to, label }) => {
                const isActive = location.pathname === to;
                return (
                  <NavLink
                    key={to}
                    to={to}
                    role="menuitem"
                    style={{
                      display: 'block',
                      padding: 'var(--space-3) var(--space-4)',
                      textDecoration: 'none',
                      color: isActive ? 'var(--color-accent-pulse)' : 'var(--color-text-primary)',
                      fontWeight: isActive ? 600 : 400,
                      fontSize: 'var(--font-size-sm)',
                      borderLeft: isActive ? '3px solid var(--color-accent-pulse)' : '3px solid transparent',
                      background: isActive ? 'var(--color-accent-pulse-subtle)' : 'transparent',
                    }}
                  >
                    {label()}
                  </NavLink>
                );
              })}

              {/* Divider */}
              <div style={{ height: 1, background: 'var(--color-border)', margin: 'var(--space-1) 0' }} />

              {/* Sign out */}
              <button
                type="button"
                role="menuitem"
                onClick={handleSignOut}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: 'var(--space-3) var(--space-4)',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--color-text-secondary)',
                  fontSize: 'var(--font-size-sm)',
                  borderLeft: '3px solid transparent',
                }}
              >
                {labels.settings.signOutButton}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Page content */}
      <main style={{ flex: 1, background: 'var(--color-bg)', minWidth: 0 }}>
        <Outlet />
      </main>

      {/* Footer */}
      <footer
        style={{
          marginTop: 'auto',
          padding: 'var(--space-6) var(--space-4)',
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}
      >
        <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-6)' }}>
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
