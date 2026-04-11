import { useState } from 'react';
import { Link } from 'react-router-dom';
import SignalBadge, { type SignalType, type EnergyLevel } from './SignalBadge';
import { labels } from '../config/labels-registry';
import styles from './SignalMatrix.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReviewerSignal {
  signal: SignalType;
  /** Reviewer's own words */
  quote: string;
}

export interface ThemeRow {
  themeId: string;
  theme: string;
  /** Map of reviewerId → signal */
  signals: Record<string, ReviewerSignal>;
}

export interface ReviewerColumn {
  reviewerId: string;
  /** Masked display name */
  name: string;
  verdict: string;
  energy: EnergyLevel;
  /** If provided, reviewer header becomes a link */
  href?: string;
}

interface SignalMatrixProps {
  themes: ThemeRow[];
  reviewers: ReviewerColumn[];
  /** Optional accessible label */
  ariaLabel?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function aggregateSignals(signals: Record<string, ReviewerSignal>, reviewerCount: number) {
  let conviction = 0;
  let tension = 0;
  let uncertainty = 0;

  for (const s of Object.values(signals)) {
    if (s.signal === 'conviction') conviction++;
    else if (s.signal === 'tension') tension++;
    else uncertainty++;
  }

  const total = reviewerCount || 1;
  return {
    conviction: (conviction / total) * 100,
    tension: (tension / total) * 100,
    uncertainty: (uncertainty / total) * 100,
    counts: { conviction, tension, uncertainty },
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SignalCell({ signal }: { signal: ReviewerSignal | undefined }) {
  const [expanded, setExpanded] = useState(false);

  if (!signal) {
    return (
      <td className={styles.signalCell}>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>—</span>
      </td>
    );
  }

  return (
    <td className={styles.signalCell}>
      <div className={styles.signalCellInner}>
        <SignalBadge variant={signal.signal} />
        {signal.quote && (
          <>
            {expanded ? (
              <p className={styles.signalQuote}>{signal.quote}</p>
            ) : null}
            <button
              type="button"
              className={styles.expandToggle}
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
            >
              {expanded ? labels.pulseCheck.matrixHideQuote : labels.pulseCheck.matrixShowQuote}
            </button>
          </>
        )}
      </div>
    </td>
  );
}

function AggregateBar({ signals, reviewerCount }: { signals: Record<string, ReviewerSignal>; reviewerCount: number }) {
  const agg = aggregateSignals(signals, reviewerCount);
  const { counts } = agg;

  return (
    <div>
      <div className={styles.signalBar} role="img" aria-label={`Conviction ${counts.conviction}, Tension ${counts.tension}, Uncertainty ${counts.uncertainty}`}>
        {agg.conviction > 0 && (
          <div className={styles.barConviction} style={{ width: `${agg.conviction}%` }} />
        )}
        {agg.tension > 0 && (
          <div className={styles.barTension} style={{ width: `${agg.tension}%` }} />
        )}
        {agg.uncertainty > 0 && (
          <div className={styles.barUncertainty} style={{ width: `${agg.uncertainty}%` }} />
        )}
      </div>
      <div className={styles.signalBarLegend}>
        {counts.conviction > 0 && (
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.legendDotConviction}`} />
            {counts.conviction}
          </span>
        )}
        {counts.tension > 0 && (
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.legendDotTension}`} />
            {counts.tension}
          </span>
        )}
        {counts.uncertainty > 0 && (
          <span className={styles.legendItem}>
            <span className={`${styles.legendDot} ${styles.legendDotUncertainty}`} />
            {counts.uncertainty}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Cross-reviewer feedback matrix for items with 2+ completed sessions.
 * Rows = themes, Columns = reviewers, Cells = signal badges with expandable quotes.
 * Summary column shows aggregate signal distribution per theme.
 * Collapses to stacked cards on mobile.
 * Requirements: 7.4, 7.6
 */
export default function SignalMatrix({ themes, reviewers, ariaLabel }: SignalMatrixProps) {
  return (
    <div className={styles.wrapper}>
      {/* ── Desktop table ── */}
      <table
        className={styles.table}
        role="table"
        aria-label={ariaLabel ?? 'Feedback signal matrix'}
      >
        <thead>
          <tr>
            {/* Summary column header */}
            <th className={styles.summaryHeader} scope="col">{labels.pulseCheck.matrixSignalDistribution}</th>
            {/* Theme column header */}
            <th scope="col">Theme</th>
            {/* Reviewer columns */}
            {reviewers.map((r) => (
              <th key={r.reviewerId} className={styles.reviewerHeader} scope="col">
                <div className={styles.reviewerHeaderInner}>
                  {r.href ? (
                    <Link to={r.href} className={styles.reviewerHeaderLink}>
                      <span className={styles.reviewerName}>{r.name}</span>
                    </Link>
                  ) : (
                    <span className={styles.reviewerName}>{r.name}</span>
                  )}
                  <SignalBadge variant={r.energy} />
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-primary)', fontStyle: 'italic', maxWidth: 160, textAlign: 'center', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {r.verdict}
                  </span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {themes.map((row) => (
            <tr key={row.themeId}>
              {/* Summary cell */}
              <td className={styles.summaryCell}>
                <AggregateBar signals={row.signals} reviewerCount={reviewers.length} />
              </td>
              {/* Theme name */}
              <td className={styles.themeCell}>{row.theme}</td>
              {/* Per-reviewer signal cells */}
              {reviewers.map((r) => (
                <SignalCell key={r.reviewerId} signal={row.signals[r.reviewerId]} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── Mobile stacked cards ── */}
      <div className={styles.mobileCards} aria-label={ariaLabel ?? 'Feedback signal matrix'}>
        {themes.map((row) => (
          <div key={row.themeId} className={styles.themeCard}>
            <div className={styles.themeCardHeader}>
              <p className={styles.themeCardTitle}>{row.theme}</p>
              <AggregateBar signals={row.signals} reviewerCount={reviewers.length} />
            </div>
            <div className={styles.themeCardBody}>
              {reviewers.map((r) => {
                const signal = row.signals[r.reviewerId];
                return (
                  <div key={r.reviewerId} className={styles.reviewerSignalRow}>
                    <span className={styles.reviewerSignalName}>{r.name}</span>
                    <div className={styles.reviewerSignalContent}>
                      {signal ? (
                        <>
                          <SignalBadge variant={signal.signal} />
                          {signal.quote && (
                            <p className={styles.signalQuote}>{signal.quote}</p>
                          )}
                        </>
                      ) : (
                        <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--font-size-xs)' }}>—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
