import { useState } from 'react';
import styles from './RevisionGroups.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type RevisionType = 'structural' | 'line-edit' | 'conceptual' | 'feature';

interface ProposedRevision {
  revisionId: string;
  proposal: string;
  rationale: string;
  revisionType?: RevisionType;
  sourceThemeIds: string[];
}

interface RevisionGroupsProps {
  revisions: ProposedRevision[];
  decisions: Record<string, string | null>;
  onDecisionChange: (revisionId: string, action: string | null) => void;
  onBatchAccept: (type: string) => void;
  onBatchDismiss: (type: string) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  structural: 'Structural',
  'line-edit': 'Line Edits',
  conceptual: 'Conceptual',
  feature: 'Features',
  other: 'Other',
};

const GROUP_ORDER: string[] = ['structural', 'conceptual', 'feature', 'line-edit', 'other'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function groupRevisions(revisions: ProposedRevision[]): Record<string, ProposedRevision[]> {
  const groups: Record<string, ProposedRevision[]> = {};
  for (const rev of revisions) {
    const type = rev.revisionType ?? 'other';
    const key = GROUP_ORDER.includes(type) ? type : 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(rev);
  }
  return groups;
}

// ─── Sub-component ────────────────────────────────────────────────────────────

function RevisionGroup({
  type,
  revisions,
  onBatchAccept,
  onBatchDismiss,
}: {
  type: string;
  revisions: ProposedRevision[];
  onBatchAccept: (type: string) => void;
  onBatchDismiss: (type: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const label = TYPE_LABELS[type] ?? type;
  const groupId = `revision-group-${type}`;

  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.groupHeader}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={groupId}
      >
        <span className={styles.groupHeaderLeft}>
          <span>{label}</span>
          <span className={styles.groupCount}>({revisions.length})</span>
        </span>
        <span
          className={`${styles.toggleIcon} ${expanded ? styles.toggleIconExpanded : ''}`}
          aria-hidden="true"
        >
          ▸
        </span>
      </button>
      {expanded && (
        <>
          {revisions.length > 1 && (
            <div className={styles.batchActions}>
              <button
                type="button"
                className={styles.batchButton}
                onClick={() => onBatchAccept(type)}
              >
                Accept All
              </button>
              <button
                type="button"
                className={styles.batchButton}
                onClick={() => onBatchDismiss(type)}
              >
                Dismiss All
              </button>
            </div>
          )}
          <ul id={groupId} className={styles.revisionList} role="list">
            {revisions.map((rev) => (
              <li key={rev.revisionId} className={styles.revisionItem}>
                <p className={styles.revisionProposal}>{rev.proposal}</p>
                <p className={styles.revisionRationale}>{rev.rationale}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Groups proposed revisions by type (structural, line-edit, conceptual, feature).
 * Each group is collapsible with batch accept/dismiss controls.
 * Revisions without a type fall into "Other".
 * Requirements: 6B.9
 */
export default function RevisionGroups({
  revisions,
  decisions,
  onDecisionChange,
  onBatchAccept,
  onBatchDismiss,
}: RevisionGroupsProps) {
  const groups = groupRevisions(revisions);

  return (
    <div className={styles.wrapper} role="region" aria-label="Proposed revisions grouped by type">
      {GROUP_ORDER.map((type) => {
        const group = groups[type];
        if (!group || group.length === 0) return null;
        return (
          <RevisionGroup
            key={type}
            type={type}
            revisions={group}
            onBatchAccept={onBatchAccept}
            onBatchDismiss={onBatchDismiss}
          />
        );
      })}
    </div>
  );
}
