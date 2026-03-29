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
  const maxItems = enriched.maxActiveItems?.limit ?? 1;
  const maxSessions = enriched.monthlySessionsTotal?.limit ?? 5;
  const showUpgrade = tier !== 'enterprise' && tier !== 'admin';

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

      {/* ── Usage ── */}
      <section className={styles.section}>
        <h2 className={styles.sectionHeading}>{labels.plan?.usageHeading ?? 'Usage'}</h2>
        {isLoading ? (
          <div className={styles.usageGrid}>
            <div className={`${styles.skeleton} ${styles.skeletonWide}`} />
            <div className={`${styles.skeleton} ${styles.skeletonWide}`} />
          </div>
        ) : (
          <div className={styles.usageGrid}>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>Items</span>
                <span className={styles.usageCount}>{itemCount} of {maxItems}</span>
              </div>
              <UsageBar used={itemCount} max={maxItems} />
            </div>
            <div className={styles.usageRow}>
              <div className={styles.usageHeader}>
                <span className={styles.usageLabel}>Sessions</span>
                <span className={styles.usageCount}>{sessionCount} of {maxSessions}</span>
              </div>
              <UsageBar used={sessionCount} max={maxSessions} />
            </div>
          </div>
        )}
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
        ) : (
          <div className={styles.featureList}>
            {Object.entries(enriched).map(([flag, feature]) => (
              <div key={flag} className={styles.featureRow}>
                <span className={styles.featureName}>{FEATURE_LABELS[flag] ?? flag}</span>
                <div className={styles.featureRight}>
                  {feature.limit !== null && (
                    <span className={styles.featureLimit}>{feature.limit}</span>
                  )}
                  <FeatureStatus feature={feature} />
                </div>
              </div>
            ))}
          </div>
        )}
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
