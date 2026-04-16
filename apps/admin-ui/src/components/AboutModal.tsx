import { useEffect } from 'react';
import { APP_VERSION, ABOUT_CONTENT } from '@pulse/shared';
import { useFocusTrap } from '../hooks/useFocusTrap';
import styles from './AboutModal.module.css';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * About Pulse modal — displays version, description, attribution, and legal links.
 * Requirements: 9.2, 9.3, 9.4, 9.6, 9.7, 15.1, 15.2
 */
export default function AboutModal({ isOpen, onClose }: AboutModalProps) {
  const focusTrapRef = useFocusTrap(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      ref={focusTrapRef}
    >
      <div className={styles.card}>
        <p className={styles.wordmark} id="about-modal-title">{ABOUT_CONTENT.wordmark}</p>
        <p className={styles.version}>Version {APP_VERSION}</p>
        <p className={styles.description}>{ABOUT_CONTENT.descriptionP1}</p>
        <p className={styles.description}>{ABOUT_CONTENT.descriptionP2}</p>
        <p className={styles.attribution}>
          {ABOUT_CONTENT.attribution}{' '}
          <a
            href={ABOUT_CONTENT.attributionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.attributionLink}
          >
            {ABOUT_CONTENT.attributionStudio}
          </a>
          {' | '}{ABOUT_CONTENT.attributionLocation}
        </p>
        <div className={styles.legalLinks}>
          <a
            href={ABOUT_CONTENT.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.legalLink}
          >
            {ABOUT_CONTENT.privacyLabel}
          </a>
          <span className={styles.legalSeparator} aria-hidden="true">·</span>
          <a
            href={ABOUT_CONTENT.termsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.legalLink}
          >
            {ABOUT_CONTENT.termsLabel}
          </a>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
