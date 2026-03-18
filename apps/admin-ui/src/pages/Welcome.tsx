import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';

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
    <main style={{ maxWidth: 560, margin: '80px auto', padding: '0 16px', textAlign: 'center' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: 16 }}>{labels.welcome.title}</h1>
      <p style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 32 }}>
        {labels.welcome.description}
      </p>
      <button
        type="button"
        onClick={() => navigate('/admin/items')}
        style={{
          padding: '12px 24px',
          fontSize: '1rem',
          cursor: 'pointer',
        }}
      >
        {labels.welcome.ctaButton}
      </button>
    </main>
  );
}
