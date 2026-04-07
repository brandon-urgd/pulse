// SessionTimeoutModal — presentational warning modal for session expiration
// Requirements: 4.4, 4.5, 4.6, 4.7

import { useId } from 'react';
import { labels } from '../config/labels-registry';
import styles from './SessionTimeoutModal.module.css';

export interface SessionTimeoutModalProps {
  remainingSeconds: number;
  onExtend: () => void;
  onSignOut: () => void;
}

export default function SessionTimeoutModal({
  remainingSeconds,
  onExtend,
  onSignOut,
}: SessionTimeoutModalProps) {
  const headingId = useId();
  const t = labels.sessionTimeout;

  return (
    <div
      className={styles.overlay}
      aria-modal="true"
      role="dialog"
      aria-labelledby={headingId}
    >
      <div className={styles.modal}>
        <h2 id={headingId} className={styles.heading}>
          {t.heading}
        </h2>

        <p className={styles.body}>{t.body}</p>

        <p className={styles.countdown} aria-live="polite" aria-atomic="true">
          {t.countdown.replace('{seconds}', String(Math.max(0, remainingSeconds)))}
        </p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.extendBtn}
            onClick={onExtend}
          >
            {t.extendButton}
          </button>
          <button
            type="button"
            className={styles.signOutBtn}
            onClick={onSignOut}
          >
            {t.signOutButton}
          </button>
        </div>
      </div>
    </div>
  );
}
