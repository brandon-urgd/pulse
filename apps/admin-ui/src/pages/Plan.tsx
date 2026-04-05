import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './Plan.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrichedFeature {
  allowed: boolean;
  reason: string;
  limit: number | null;
}

interface UsageCounter {
  count: number;
  periodStart?: string;
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
  usageCounters?: Record<string, UsageCounter>;
  stripeCustomerId?: string | null;
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

function calculateResetDate(periodStart: string): string {
  const d = new Date(periodStart);
  if (isNaN(d.getTime())) return '';
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

// Monthly counter names that should show reset date info
const MONTHLY_COUNTERS = new Set(['monthlyItemsCreated', 'monthlySessionsTotal', 'monthlyPublicSessionsTotal']);

// ─── Component ────────────────────────────────────────────────────────────────

export default function Plan() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  const checkoutMutation = useAuthedMutation<{ data: { url: string } }, { action: string; priceId?: string }>(
    '/api/manage/checkout',
    'POST'
  );

  // Handle ?upgraded=true return from Stripe Checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('upgraded') === 'true') {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [queryClient]);

  // Invalidate settings cache on page focus (for portal return)
  useEffect(() => {
    const handleFocus = () => queryClient.invalidateQueries({ queryKey: ['settings'] });
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [queryClient]);

  useEffect(() => {
    document.title = labels.plan?.documentTitle ?? 'Plan — Pulse';
  }, []);

  const s = data?.data;
  const tier = s?.tier ?? 'free';
  const enriched = s?.enrichedFeatures ?? {};
  const itemCount = s?.usage?.itemCount ?? 0;
  const stripeCustomerId = s?.stripeCustomerId;
  const showUpgrade = tier !== 'enterprise' && tier !== 'admin';
  const isFree = tier === 'free';
  const isPaying = !isFree && tier !== 'admin';

  const handleUpgrade = async (priceId: 'individual' | 'pro' | 'enterprise') => {
    try {
      const result = await checkoutMutation.mutateAsync({ action: 'checkout', priceId });
      window.location.href = result.data.url;
    } catch {
      // Error handled by mutation state
    }
  };

  const handleManageBilling = async () => {
    try {
      const result = await checkoutMutation.mutateAsync({ action: 'portal' });
      window.location.href = result.data.url;
    } catch {
      // Error handled by mutation state
    }
  };

  // Trackable limits — usage increments over time, show "X of Y" bars
  const TRACKABLE: Set<string> = new Set([
    'maxActiveItems', 'maxSessionsPerItem', 'maxOrgMembers',
    'monthlySessionsTotal', 'monthlyPublicSessionsTotal', 'monthlyItemsCreated',
  ]);

  // Map flags to known usage counts (expand as more tracking is added)
  const usageCounts: Record<string, number> = {
    maxActiveItems: itemCount,
    monthlyItemsCreated: s?.usageCounters?.monthlyItemsCreated?.count ?? 0,
    monthlySessionsTotal: s?.usageCounters?.monthlySessionsTotal?.count ?? 0,
    monthlyPublicSessionsTotal: s?.usageCounters?.monthlyPublicSessionsTotal?.count ?? 0,
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
                const pct = max > 0 ? (used / max) * 100 : 0;
                const isMonthly = MONTHLY_COUNTERS.has(flag);
                const periodStart = isMonthly ? s?.usageCounters?.[flag]?.periodStart : undefined;
                const resetDate = periodStart ? calculateResetDate(periodStart) : '';
                return (
                  <div key={flag} className={styles.usageRow}>
                    <div className={styles.usageHeader}>
                      <span className={styles.usageLabel}>{FEATURE_LABELS[flag] ?? flag}</span>
                      <span className={styles.usageCount}>{used} of {max}</span>
                    </div>
                    <UsageBar used={used} max={max} />
                    {isMonthly && resetDate && (
                      <span className={styles.resetDate}>
                        {pct >= 100
                          ? `${labels.plan.resetDateLabel} ${resetDate}`
                          : `${labels.plan.periodLabel} · ${labels.plan.resetDateLabel} ${resetDate}`}
                      </span>
                    )}
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

      {/* ── Billing CTA ── */}
      {showUpgrade && !isLoading && (
        <section className={styles.section}>
          <div className={styles.upgradeSection}>
            {isFree && stripeCustomerId ? (
              <>
                <p className={styles.upgradeHint}>Unlock more features by upgrading your plan.</p>
                <div className={styles.upgradeButtons}>
                  <button
                    type="button"
                    className={styles.upgradeButton}
                    onClick={() => handleUpgrade('individual')}
                    disabled={checkoutMutation.isPending}
                  >
                    {labels.plan.upgradeToIndividual}
                  </button>
                  <button
                    type="button"
                    className={styles.upgradeButton}
                    onClick={() => handleUpgrade('pro')}
                    disabled={checkoutMutation.isPending}
                  >
                    {labels.plan.upgradeToPro}
                  </button>
                  <button
                    type="button"
                    className={styles.upgradeButton}
                    onClick={() => handleUpgrade('enterprise')}
                    disabled={checkoutMutation.isPending}
                  >
                    {labels.plan.upgradeToEnterprise}
                  </button>
                </div>
              </>
            ) : isFree && !stripeCustomerId ? (
              <>
                <p className={styles.upgradeHint}>{labels.plan.upgradeDisabledNoStripe}</p>
                <button type="button" className={styles.upgradeButton} disabled>
                  {labels.plan?.upgradeButton ?? 'Upgrade'}
                </button>
              </>
            ) : isPaying ? (
              <div className={styles.upgradeButtons}>
                <button
                  type="button"
                  className={styles.upgradeButton}
                  onClick={handleManageBilling}
                  disabled={checkoutMutation.isPending}
                >
                  {labels.plan.manageBilling}
                </button>
                <button
                  type="button"
                  className={styles.upgradeButton}
                  onClick={handleManageBilling}
                  disabled={checkoutMutation.isPending}
                >
                  {labels.plan.changePlan}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
