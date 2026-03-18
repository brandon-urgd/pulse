import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuth } from '../hooks/useAuth';
import { labels } from '../config/labels-registry';
import { useTheme } from '../hooks/useTheme';

interface Settings {
  displayName: string;
  email: string;
  tier: string;
  usage: { itemCount: number; sessionCount: number };
  features: { maxActiveItems: number; maxSessionsPerItem: number };
  preferences: { theme: 'light' | 'dark' | 'system' };
  onboardingComplete: boolean;
}

interface SettingsResponse {
  data: Settings;
}

/**
 * Settings page — account info, tier, usage, theme toggle, sign out.
 * Requirements: 3.20, 3.21
 */
export default function Settings() {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { data, isLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  useEffect(() => {
    document.title = labels.settings.documentTitle;
  }, []);

  async function handleSignOut() {
    await signOut();
    navigate('/admin/login', { replace: true });
  }

  const settings = data?.data;

  return (
    <main style={{ maxWidth: 600, margin: '0 auto', padding: 'var(--space-8)' }}>
      <h1 style={{ fontSize: 'var(--font-size-2xl)', marginBottom: 'var(--space-8)' }}>
        {labels.settings.title}
      </h1>

      {/* Account section */}
      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-4)' }}>
          {labels.settings.accountSection}
        </h2>
        {isLoading ? (
          <p>Loading…</p>
        ) : (
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-2)' }}>
            <dt style={{ color: 'var(--color-text-secondary)' }}>{labels.settings.tierLabel}</dt>
            <dd style={{ margin: 0 }}>
              {settings?.tier === 'free' ? labels.settings.tierFree : settings?.tier}
            </dd>
          </dl>
        )}
      </section>

      {/* Usage section */}
      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-4)' }}>
          {labels.settings.usageSection}
        </h2>
        {isLoading ? (
          <p>Loading…</p>
        ) : (
          <dl style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 'var(--space-2)' }}>
            <dt style={{ color: 'var(--color-text-secondary)' }}>Items</dt>
            <dd style={{ margin: 0 }}>
              {labels.settings.itemsUsage
                .replace('{used}', String(settings?.usage?.itemCount ?? 0))
                .replace('{max}', String(settings?.features?.maxActiveItems ?? 1))}
            </dd>
            <dt style={{ color: 'var(--color-text-secondary)' }}>Sessions</dt>
            <dd style={{ margin: 0 }}>
              {labels.settings.sessionsUsage
                .replace('{used}', String(settings?.usage?.sessionCount ?? 0))
                .replace('{max}', String(settings?.features?.maxSessionsPerItem ?? 5))}
            </dd>
          </dl>
        )}
      </section>

      {/* Theme section */}
      <section style={{ marginBottom: 'var(--space-8)' }}>
        <h2 style={{ fontSize: 'var(--font-size-lg)', marginBottom: 'var(--space-4)' }}>
          {labels.settings.themeSection}
        </h2>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              aria-pressed={theme === t}
              style={{
                padding: 'var(--space-2) var(--space-4)',
                borderRadius: 'var(--radius-md)',
                fontWeight: theme === t ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {labels.settings[`theme${t.charAt(0).toUpperCase() + t.slice(1)}` as 'themeLight' | 'themeDark' | 'themeSystem']}
            </button>
          ))}
        </div>
      </section>

      {/* Actions */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <button
          type="button"
          onClick={handleSignOut}
          style={{ padding: 'var(--space-3) var(--space-6)', cursor: 'pointer', alignSelf: 'flex-start' }}
        >
          {labels.settings.signOutButton}
        </button>

        <div style={{ position: 'relative', display: 'inline-block', alignSelf: 'flex-start' }}>
          <button
            type="button"
            disabled
            aria-describedby="delete-account-tooltip"
            style={{ padding: 'var(--space-3) var(--space-6)', cursor: 'not-allowed', opacity: 0.5 }}
          >
            {labels.settings.deleteAccountButton}
          </button>
          <span
            id="delete-account-tooltip"
            role="tooltip"
            style={{
              display: 'none',
              position: 'absolute',
              left: 0,
              top: 'calc(100% + 4px)',
              background: 'var(--color-text-primary)',
              color: 'var(--color-text-inverse)',
              fontSize: 'var(--font-size-sm)',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              whiteSpace: 'nowrap',
              zIndex: 10,
            }}
          >
            {labels.settings.deleteAccountTooltip}
          </span>
        </div>
      </section>
    </main>
  );
}
