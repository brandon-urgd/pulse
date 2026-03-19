import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './Welcome.module.css';

/**
 * Welcome screen — shown on first login.
 * Sets onboardingComplete: true on mount.
 * Requirements: 3.16
 */
export default function Welcome() {
  const navigate = useNavigate();
  const { mutate: updateSettings } = useAuthedMutation('/api/manage/settings', 'PUT');

  useEffect(() => {
    document.title = labels.welcome.documentTitle;
    // Mark onboarding complete
    updateSettings({ onboardingComplete: true } as unknown as void);
  }, [updateSettings]);

  return (
    <main className={styles.container}>
      <h1 className={styles.heading}>{labels.welcome.title}</h1>
      <p className={styles.description}>{labels.welcome.description}</p>
      <button
        type="button"
        className={styles.ctaButton}
        onClick={() => navigate('/admin/items')}
      >
        {labels.welcome.ctaButton}
      </button>
    </main>
  );
}
