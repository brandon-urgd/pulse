import { useEffect } from 'react';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { labels } from '../config/labels-registry';
import styles from './Plan.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrichedFeature {
  allowed: boolean;
  reason: string;
  limit: number | null;
}

interface SettingsData {
  tenantId: string;
  displayName: string | null;
  email: string | null;
  tier: string;
  features: Record<string, unknown>;
  enrichedFeatures: Record<string, EnrichedFeature>;
  usage: { itemCount: number; sessionCount: number };
  onboardingComplete: boolean;
  preferences: Record<string, unknown>;
}

interface SettingsResponse {
  data: SettingsData;
}

// ─── Feature display labels ───────────────────────────────────────────────────

const FEATURE_LABELS: Record<string, string> = {
  maxActiveItems: 'Active items',
  maxSessionsPerItem: 'Sessions per item',
  sessionTimeLimitMinutes: 'Session time limit',
  maxUploadSizeMb: 'Upload size',
  maxPhotoSizeMb: 'Photo size',
  maxDocumentPages: 'Document pages',
  publicSessions: 'Public sessions',
  selfReview: 'Self review',
  pulseCheck: 'Pulse Check',
  aiReports: 'AI reports',
  itemRevisionLoop: 'Revision loop',
  emailReminders: 'Email reminders',
  organizationsEnabled: 'Organizations',
  maxOrgMembers: 'Organization members',
  monthlySessionsTotal: 'Monthly sessions',
  monthlyPublicSessionsTotal: 'Monthly public sessions',
  monthlyItemsCreated: 'Monthly items created',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'free': return styles.tierFree;
    case 'individual': return styles.tierIndividual;
    case 'pro': return styles.tierPro;
    case 'enterprise': return styles.tierEnterprise;
    case 'admin': return styles.tierAdmin;
    default: return styles.tierFree;
  }
}

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

function FeatureStatus({ feature }: { feature: EnrichedFeature }) {
  if (feature.reason === 'maintenance') {
    return <span className={styles.statusMaintenance}>{labels.plan?.featureMaintenance ?? 'Maintenance'}</span>;
  }
  if (!feature.allowed) {
    return <span className={styles.statusLocked}>{labels.plan?.featureLocked ?? 'Locked'}</span>;
  }
  return <span className={styles.statusAllowed}>{labels.plan?.featureAllowed ?? 'Included'}</span>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Plan() {
  const { data, isLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  useEffect(() => {
    document.title = labels.plan?.documentTitle ?? 'Plan — Pulse';
  }, []);

  const s = data?.data;
  const tier = s?.tier ?? 'free';
  const enriched = s?.enrichedFeatures ?? {};
  const itemCount = s?.usage?.itemCount ?? 0;
  const sessionCount = s?.usage?.sessionCount ?? 0;
  const showUpgrade = tier !== 'enterprise' && tier !== 'admin';

  // Trackable limits — usage increments over time, show "X of Y" bars
  const TRACKABLE: Set<string> = new Set([
    'maxActiveItems', 'maxSessionsPerItem', 'maxOrgMembers',
    'monthlySessionsTotal', 'monthlyPublicSessionsTotal', 'monthlyItemsCreated',
  ]);

  // Map flags to known usage counts (expand as more tracking is added)
  const usageCounts: Record<string, number> = {
    maxActiveItems: itemCount,
    monthlySessionsTotal: sessionCount,
  };

  // Per-action caps — just display the value with units, no bar
  const UNIT_SUFFIX: Record<string, string> = {
    maxUploadSizeMb: ' MB',
    maxPhotoSizeMb: ' MB',
    sessionTimeLimitMinutes: ' min',
    maxDocumentPages: ' pages',
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>{labels.plan?.title ?? 'Plan'}</h1>

      {/* ── Tier ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.plan?.tierLabel ?? 'Current plan'}</h2>
        {isLoading ? (
          <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
        ) : (
          <div className={styles.tierRow}>
            <span className={`${styles.tierBadge} ${tierBadgeClass(tier)}`}>{tier}</span>
          </div>
        )}
      </section>

      {/* ── Limits ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>Limits</h2>
        {isLoading ? (
          <div className={styles.usageGrid}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className={`${styles.skeleton} ${styles.skeletonWide}`} />
            ))}
          </div>
        ) : (() => {
          const trackable = Object.entries(enriched)
            .filter(([flag, f]) => f.limit !== null && TRACKABLE.has(flag))
            .sort(([a], [b]) => (FEATURE_LABELS[a] ?? a).localeCompare(FEATURE_LABELS[b] ?? b));

          const caps = Object.entries(enriched)
            .filter(([flag, f]) => f.limit !== null && !TRACKABLE.has(flag))
            .sort(([a], [b]) => (FEATURE_LABELS[a] ?? a).localeCompare(FEATURE_LABELS[b] ?? b));

          return (
            <div className={styles.usageGrid}>
              {trackable.map(([flag, feature]) => {
                const max = feature.limit ?? 0;
                const used = usageCounts[flag] ?? 0;
                return (
                  <div key={flag} className={styles.usageRow}>
                    <div className={styles.usageHeader}>
                      <span className={styles.usageLabel}>{FEATURE_LABELS[flag] ?? flag}</span>
                      <span className={styles.usageCount}>{used} of {max}</span>
                    </div>
                    <UsageBar used={used} max={max} />
                  </div>
                );
              })}
              {caps.length > 0 && <hr className={styles.featureDivider} />}
              {caps.map(([flag, feature]) => (
                <div key={flag} className={styles.featureRow}>
                  <span className={styles.featureName}>{FEATURE_LABELS[flag] ?? flag}</span>
                  <span className={styles.featureLimit}>{feature.limit}{UNIT_SUFFIX[flag] ?? ''}</span>
                </div>
              ))}
            </div>
          );
        })()}
      </section>

      {/* ── Features ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.plan?.featuresHeading ?? 'Features'}</h2>
        {isLoading ? (
          <div className={styles.featureList}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className={`${styles.skeleton} ${styles.skeletonMed}`} />
            ))}
          </div>
        ) : (() => {
          const boolean_ = Object.entries(enriched)
            .filter(([, f]) => f.limit === null)
            .sort(([a], [b]) => (FEATURE_LABELS[a] ?? a).localeCompare(FEATURE_LABELS[b] ?? b));

          return (
            <div className={styles.featureList}>
              {boolean_.map(([flag, feature]) => (
                <div key={flag} className={styles.featureRow}>
                  <span className={styles.featureName}>{FEATURE_LABELS[flag] ?? flag}</span>
                  <div className={styles.featureRight}>
                    <FeatureStatus feature={feature} />
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </section>

      {/* ── Upgrade CTA ── */}
      {showUpgrade && (
        <section className={styles.section}>
          <div className={styles.upgradeSection}>
            <p className={styles.upgradeHint}>Unlock more features by upgrading your plan.</p>
            <button type="button" className={styles.upgradeButton} disabled>
              {labels.plan?.upgradeButton ?? 'Upgrade'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
