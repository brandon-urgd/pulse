import { useEffect } from 'react';
import { labels } from '../config/labels-registry';
import { APP_VERSION } from '../config/version';
import { useFocusTrap } from '../hooks/useFocusTrap';
import styles from './AboutModal.module.css';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * About Pulse modal — displays version, description, attribution, and legal links.
 * Requirements: 9.2, 9.3, 9.4, 9.6, 9.7
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

  const a = labels.about;

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
        <p className={styles.wordmark} id="about-modal-title">pulse</p>
        <p className={styles.version}>{a.version.replace('{version}', APP_VERSION)}</p>
        <p className={styles.description}>{a.descriptionP1}</p>
        <p className={styles.description}>{a.descriptionP2}</p>
        <p className={styles.attribution}>
          {a.attribution}{' '}
          <a
            href={a.attributionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.attributionLink}
          >
            {a.attributionStudio}
          </a>
          {' | '}{a.attributionLocation}
        </p>
        <div className={styles.legalLinks}>
          <a
            href={a.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.legalLink}
          >
            {a.privacyLink}
          </a>
          <span className={styles.legalSeparator} aria-hidden="true">·</span>
          <a
            href={a.termsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.legalLink}
          >
            {a.termsLink}
          </a>
        </div>
        <button
          type="button"
          className={styles.closeButton}
          onClick={onClose}
        >
          {a.closeButton}
        </button>
      </div>
    </div>
  );
}
