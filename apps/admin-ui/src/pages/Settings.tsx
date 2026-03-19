import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { labels } from '../config/labels-registry';
import styles from './Settings.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Settings {
  displayName: string | null;
  email: string | null;
  tier: string;
  usage: { itemCount: number; sessionCount: number };
  features: { maxActiveItems: number; maxSessionsPerItem: number };
  preferences: { theme?: 'light' | 'dark' | 'system' };
}

interface SettingsResponse {
  data: Settings;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function UsageBar({ used, max }: { used: number; max: number }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0;
  const fillClass = pct >= 100
    ? styles.usageFillFull
    : pct >= 80
      ? styles.usageFillWarning
      : styles.usageFill;

  return (
    <div className={styles.usageTrack} role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
      <div className={fillClass} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Settings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { signOut } = useAuth();
  const { theme, setTheme } = useTheme();

  const [themeSaveState, setThemeSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const { data, isLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  const themeMutation = useAuthedMutation<unknown, { preferences: { theme: string } }>(
    '/api/manage/settings',
    'PUT',
    {
      onSuccess: () => {
        setThemeSaveState('saved');
        setTimeout(() => setThemeSaveState('idle'), 1500);
        queryClient.invalidateQueries({ queryKey: ['settings'] });
      },
      onError: () => setThemeSaveState('idle'),
    }
  );

  useEffect(() => {
    document.title = labels.settings.documentTitle;
  }, []);

  async function handleThemeChange(t: 'light' | 'dark' | 'system') {
    setTheme(t);
    setThemeSaveState('saving');
    themeMutation.mutate({ preferences: { theme: t } });
  }

  async function handleSignOut() {
    await signOut();
    navigate('/admin/login', { replace: true });
  }

  const s = data?.data;
  const itemCount    = s?.usage?.itemCount    ?? 0;
  const sessionCount = s?.usage?.sessionCount ?? 0;
  const maxItems     = s?.features?.maxActiveItems    ?? 1;
  const maxSessions  = s?.features?.maxSessionsPerItem ?? 5;

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>{labels.settings.title}</h1>

      {/* ── Account ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.accountSection}</h2>
        <div className={styles.fieldGrid}>
          {isLoading ? (
            <>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.emailLabel}</span>
                <div className={`${styles.skeleton} ${styles.skeletonMed}`} />
              </div>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.tierLabel}</span>
                <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
              </div>
            </>
          ) : (
            <>
              {s?.email && (
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>{labels.settings.emailLabel}</span>
                  <span className={styles.fieldValue}>{s.email}</span>
                </div>
              )}
              {s?.displayName && (
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>{labels.settings.displayNameLabel}</span>
                  <span className={styles.fieldValue}>{s.displayName}</span>
                </div>
              )}
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>{labels.settings.tierLabel}</span>
                <span>
                  <span className={styles.tierBadge}>
                    {s?.tier === 'free' ? labels.settings.tierFree : (s?.tier ?? labels.settings.tierFree)}
                  </span>
                </span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Usage ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.usageSection}</h2>
        {isLoading ? (
          <div className={styles.fieldGrid}>
            <div className={`${styles.skeleton} ${styles.skeletonMed}`} style={{ height: 40 }} />
            <div className={`${styles.skeleton} ${styles.skeletonMed}`} style={{ height: 40 }} />
          </div>
        ) : (
          <div className={styles.fieldGrid}>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>{labels.settings.itemsLabel}</span>
                <span className={styles.usageCount}>
                  {labels.settings.itemsUsage
                    .replace('{used}', String(itemCount))
                    .replace('{max}', String(maxItems))}
                </span>
              </div>
              <UsageBar used={itemCount} max={maxItems} />
            </div>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>{labels.settings.sessionsLabel}</span>
                <span className={styles.usageCount}>
                  {labels.settings.sessionsUsage
                    .replace('{used}', String(sessionCount))
                    .replace('{max}', String(maxSessions))}
                </span>
              </div>
              <UsageBar used={sessionCount} max={maxSessions} />
            </div>
          </div>
        )}
      </section>

      {/* ── Appearance ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.settings.themeSection}</h2>
        <div className={styles.themeGroup} role="group" aria-label={labels.settings.themeLabel}>
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => handleThemeChange(t)}
              aria-pressed={theme === t}
              className={`${styles.themeButton} ${theme === t ? styles.themeButtonActive : ''}`}
            >
              {labels.settings[`theme${t.charAt(0).toUpperCase() + t.slice(1)}` as 'themeLight' | 'themeDark' | 'themeSystem']}
            </button>
          ))}
        </div>
        {themeSaveState !== 'idle' && (
          <p className={styles.themeSaving} aria-live="polite">
            {themeSaveState === 'saving' ? labels.settings.themeSaving : labels.settings.themeSaved}
          </p>
        )}
      </section>

      {/* ── Actions ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Account actions</h2>
        <div className={styles.actionsSection}>
          <button type="button" className={styles.signOutButton} onClick={handleSignOut}>
            {labels.settings.signOutButton}
          </button>
          <button type="button" className={styles.deleteButton} disabled aria-disabled="true">
            {labels.settings.deleteAccountButton}
          </button>
          <p className={styles.deleteHint}>{labels.settings.deleteAccountHint}</p>
        </div>
      </section>
    </div>
  );
}
