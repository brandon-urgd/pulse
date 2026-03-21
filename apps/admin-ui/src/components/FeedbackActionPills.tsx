import styles from './FeedbackActionPills.module.css';

export type FeedbackAction = 'accept' | 'revise' | 'dismiss' | null;

interface FeedbackActionPillsProps {
  /** Currently selected action, or null for none */
  value: FeedbackAction;
  onChange: (action: FeedbackAction) => void;
  disabled?: boolean;
  /** Accessible label for the group (e.g. the theme name) */
  ariaLabel?: string;
}

const PILLS: { action: Exclude<FeedbackAction, null>; label: string }[] = [
  { action: 'accept', label: 'Accept' },
  { action: 'revise', label: 'Revise' },
  { action: 'dismiss', label: 'Dismiss' },
];

/**
 * Three-state toggle pills for feedback decisions.
 * Only one pill can be selected at a time per theme.
 * Clicking the active pill deselects it (returns null).
 * Requirements: 7.7
 */
export default function FeedbackActionPills({
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: FeedbackActionPillsProps) {
  return (
    <div
      className={styles.group}
      role="group"
      aria-label={ariaLabel ?? 'Feedback action'}
    >
      {PILLS.map(({ action, label }) => {
        const isActive = value === action;
        return (
          <button
            key={action}
            type="button"
            className={`${styles.pill} ${styles[action]} ${isActive ? styles.active : ''}`}
            aria-pressed={isActive}
            disabled={disabled}
            onClick={() => onChange(isActive ? null : action)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
