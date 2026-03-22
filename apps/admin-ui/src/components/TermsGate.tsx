import { useId } from 'react';
import { labels } from '../config/labels-registry';
import { TERMS_VERSION } from '../config/terms';
import styles from './TermsGate.module.css';
import '../styles/glass.css';

interface TermsGateProps {
  isUpdated: boolean;
  onAccept: () => Promise<void>;
  isAccepting: boolean;
}

function formatTermsDate(version: string): string {
  // version is 'YYYY-MM-DD' — format as 'Month DD, YYYY'
  const [year, month, day] = version.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function TermsGate({ isUpdated, onAccept, isAccepting }: TermsGateProps) {
  const headingId = useId();
  const t = labels.termsGate;

  return (
    <div className="pulse-entry-bg" style={{ padding: '24px' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="pulse-glass-card"
        style={{ width: '100%', maxWidth: 480, padding: '48px 32px', textAlign: 'center' }}
      >
        {/* Logo + wordmark */}
        <div style={{ margin: '0 auto 32px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div
            role="img"
            aria-label="ur/gd Studios logo"
            style={{
              height: 'clamp(10rem, 18.75vw, 15rem)',
              width: 'clamp(10rem, 18.75vw, 15rem)',
              backgroundImage: `url(${window.location.origin}/logo.svg)`,
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
              marginTop: 'clamp(-2.22rem, -4.17vw, -3.33rem)',
              marginBottom: 'clamp(-2.67rem, -5vw, -4rem)',
            }}
          />
          <span
            style={{
              display: 'block',
              fontSize: '1.75rem',
              fontWeight: 300,
              letterSpacing: '0.12em',
              color: 'var(--color-accent-pulse)',
            }}
          >
            pulse
          </span>
        </div>

        {/* Heading */}
        <h1
          id={headingId}
          className={styles.heading}
        >
          {isUpdated ? t.headingUpdated : t.headingFirst}
        </h1>

        {/* Body */}
        <p className={styles.body}>{t.body}</p>

        {/* Last updated */}
        <p className={styles.lastUpdated}>
          Last updated: {formatTermsDate(TERMS_VERSION)}
        </p>

        {/* Read link */}
        <a
          href="https://urgdstudios.com/terms/"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.readLink}
        >
          {t.readLink}
        </a>

        {/* Agree button */}
        <button
          type="button"
          className="pulse-btn pulse-btn-primary"
          style={{ marginTop: 24, width: '100%' }}
          onClick={onAccept}
          disabled={isAccepting}
        >
          {isAccepting ? t.agreeing : t.agreeButton}
        </button>
      </div>
    </div>
  );
}
