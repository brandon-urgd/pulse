import styles from './FeedbackActionPills.module.css';

export type FeedbackAction = 'accept' | 'adjust' | 'dismiss' | null;

const NOTE_MAX_LENGTH = 500;

interface FeedbackActionPillsProps {
  /** Currently selected action, or null for none */
  value: FeedbackAction;
  onChange: (action: FeedbackAction) => void;
  disabled?: boolean;
  /** Accessible label for the group (e.g. the theme name) */
  ariaLabel?: string;
  /** Current tenant note text (controlled) */
  noteValue?: string;
  /** Called when the tenant edits the adjustment note */
  onNoteChange?: (note: string) => void;
}

const PILLS: { action: Exclude<FeedbackAction, null>; label: string }[] = [
  { action: 'accept', label: 'Accept' },
  { action: 'adjust', label: 'Adjust' },
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
  noteValue,
  onNoteChange,
}: FeedbackActionPillsProps) {
  const showTextarea = value === 'adjust' && onNoteChange != null;
  const noteLength = noteValue?.length ?? 0;

  return (
    <>
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
      {showTextarea && (
        <div className={styles.noteContainer}>
          <textarea
            className={styles.noteTextarea}
            value={noteValue ?? ''}
            onChange={(e) => onNoteChange(e.target.value)}
            maxLength={NOTE_MAX_LENGTH}
            placeholder="How should this feedback be adjusted?"
            aria-label="Adjustment guidance"
            disabled={disabled}
          />
          <span className={styles.charCount}>
            {noteLength}/{NOTE_MAX_LENGTH}
          </span>
        </div>
      )}
    </>
  );
}
