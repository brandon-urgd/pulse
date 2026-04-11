import { useState } from 'react';
import type { ThemeRow, ReviewerColumn } from './SignalMatrix';
import type { SignalType } from './SignalBadge';
import { labels } from '../config/labels-registry';
import styles from './SignalSummary.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SignalSummaryProps {
  themes: ThemeRow[];
  reviewers: ReviewerColumn[];
  sessionCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aggregateSignals(signals: Record<string, { signal: SignalType; quote: string }>, reviewerCount: number) {
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
    flaggedCount: Object.keys(signals).length,
  };
}

function getTopQuotes(signals: Record<string, { signal: SignalType; quote: string }>, max: number): string[] {
  return Object.values(signals)
    .map((s) => s.quote)
    .filter(Boolean)
    .slice(0, max);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InlineQuotePreview({ quote }: { quote: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = quote.length > 60;
  const preview = needsTruncation ? quote.slice(0, 60) + '…' : quote;

  return (
    <span
      onClick={() => needsTruncation && setExpanded(!expanded)}
      onKeyDown={needsTruncation ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } } : undefined}
      role={needsTruncation ? 'button' : undefined}
      tabIndex={needsTruncation ? 0 : undefined}
      aria-expanded={needsTruncation ? expanded : undefined}
    >
      {expanded ? quote : preview}
    </span>
  );
}

function SentimentBar({ signals, reviewerCount }: { signals: Record<string, { signal: SignalType; quote: string }>; reviewerCount: number }) {
  const agg = aggregateSignals(signals, reviewerCount);
  const { counts } = agg;

  return (
    <div>
      <div className={styles.sentimentBar} role="img" aria-label={`Conviction ${counts.conviction}, Tension ${counts.tension}, Uncertainty ${counts.uncertainty}`}>
        {agg.conviction > 0 && <div className={styles.barConviction} style={{ width: `${agg.conviction}%` }} />}
        {agg.tension > 0 && <div className={styles.barTension} style={{ width: `${agg.tension}%` }} />}
        {agg.uncertainty > 0 && <div className={styles.barUncertainty} style={{ width: `${agg.uncertainty}%` }} />}
      </div>
      <div className={styles.sentimentLegend}>
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
 * Signal Summary — aggregated theme cards for items with 8+ sessions.
 * Replaces SignalMatrix when session count reaches Tier 2 (medium group).
 * Each card shows: theme name, flagged count, sentiment bar, top 3 quotes.
 * Responsive: stacked on mobile, two-column grid on desktop.
 * Requirements: 6B.7, 6B.12
 */
export default function SignalSummary({ themes, reviewers, sessionCount }: SignalSummaryProps) {
  const reviewerCount = reviewers.length;

  return (
    <div className={styles.grid} role="list" aria-label="Signal summary — themes">
      {themes.map((theme) => {
        const agg = aggregateSignals(theme.signals, reviewerCount);
        const topQuotes = getTopQuotes(theme.signals, 3);

        return (
          <article
            key={theme.themeId}
            className={styles.themeCard}
            role="listitem"
          >
            <div className={styles.themeCardHeader}>
              <h3 className={styles.themeName}>{theme.theme}</h3>
              <p className={styles.themeCount}>
                {agg.flaggedCount} of {sessionCount} reviewers flagged this
              </p>
              <SentimentBar signals={theme.signals} reviewerCount={reviewerCount} />
            </div>
            {topQuotes.length > 0 && (
              <div className={styles.themeCardBody}>
                <p className={styles.quotesHeading}>{labels.pulseCheck.topQuotesHeading}</p>
                <ul className={styles.quoteList}>
                  {topQuotes.map((quote, i) => (
                    <li key={i} className={styles.quoteItem}>
                      <InlineQuotePreview quote={quote} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
