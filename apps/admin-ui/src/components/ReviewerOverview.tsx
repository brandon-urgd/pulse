import { useState } from 'react';
import type { ReviewerColumn } from './SignalMatrix';
import styles from './ReviewerOverview.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewerOverviewProps {
  reviewers: ReviewerColumn[];
  sessionCount: number;
  /** Optional completion dates keyed by reviewerId */
  completionDates?: Record<string, string>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Collapsible reviewer overview panel — lists each reviewer with name,
 * status, completion date, and one-line verdict.
 * Collapsed by default. Keyboard accessible.
 * Requirements: 6B.8
 */
export default function ReviewerOverview({ reviewers, sessionCount, completionDates }: ReviewerOverviewProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section className={styles.panel} aria-label="Reviewer overview">
      <button
        type="button"
        className={styles.toggleButton}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="reviewer-overview-list"
      >
        <span>Reviewers ({sessionCount})</span>
        <span
          className={`${styles.toggleIcon} ${expanded ? styles.toggleIconExpanded : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {expanded && (
        <ul id="reviewer-overview-list" className={styles.reviewerList} role="list">
          {reviewers.map((reviewer) => {
            const completedAt = completionDates?.[reviewer.reviewerId];
            const dateStr = completedAt
              ? new Date(completedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })
              : '—';

            return (
              <li key={reviewer.reviewerId} className={styles.reviewerRow}>
                <span className={styles.reviewerName}>{reviewer.name}</span>
                <span className={styles.reviewerStatus}>Completed</span>
                <span className={styles.reviewerDate}>{dateStr}</span>
                <span className={styles.reviewerVerdict} title={reviewer.verdict}>
                  {reviewer.verdict}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
