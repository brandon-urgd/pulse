import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import WelcomeAnimation from '../components/WelcomeAnimation';
import styles from './Welcome.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SettingsData {
  onboardingComplete: boolean;
}

interface SettingsResponse {
  data: SettingsData;
}

interface ItemData {
  itemId: string;
  isExample?: boolean;
}

interface ItemsResponse {
  data: ItemData[];
}

/**
 * Welcome screen — shown on first login.
 * Redirects to Items page when onboardingComplete === true.
 * Two CTAs: primary → create first item, secondary → explore example pulse check.
 * Requirements: 6.7, 6.8
 */
export default function Welcome() {
  const navigate = useNavigate();
  const { mutate: updateSettings } = useAuthedMutation('/api/manage/settings', 'PUT');
  const [animationDone, setAnimationDone] = useState(false);

  const { data: settingsResp, isLoading: settingsLoading } = useAuthedQuery<SettingsResponse>(
    ['settings'],
    '/api/manage/settings'
  );

  const { data: itemsResp } = useAuthedQuery<ItemsResponse>(
    ['items'],
    '/api/manage/items'
  );

  // Redirect to Items page when onboarding is already complete
  useEffect(() => {
    if (!settingsLoading && settingsResp?.data?.onboardingComplete) {
      navigate('/admin/items', { replace: true });
    }
  }, [settingsLoading, settingsResp, navigate]);

  useEffect(() => {
    document.title = labels.welcome.documentTitle;
  }, []);

  // Find the example item's ID for the secondary CTA
  const exampleItem = itemsResp?.data?.find((item) => item.isExample);

  function handlePrimaryCta() {
    updateSettings({ onboardingComplete: true } as unknown as void);
    navigate('/admin/items/new');
  }

  function handleSecondaryCta() {
    updateSettings({ onboardingComplete: true } as unknown as void);
    if (exampleItem) {
      navigate(`/admin/pulse-check/${exampleItem.itemId}`);
    } else {
      navigate('/admin/items');
    }
  }

  // Don't render while checking onboarding status
  if (settingsLoading) return null;
  if (settingsResp?.data?.onboardingComplete) return null;

  // Show welcome animation before revealing page content
  if (!animationDone) {
    return <WelcomeAnimation onComplete={() => setAnimationDone(true)} />;
  }

  return (
    <main className={styles.container}>
      <h1 className={styles.heading}>{labels.welcome.title}</h1>
      <p className={styles.description}>{labels.welcome.description}</p>
      <div className={styles.ctaGroup}>
        <button
          type="button"
          className={styles.ctaButton}
          onClick={handlePrimaryCta}
        >
          {labels.welcome.ctaButton}
        </button>
        <button
          type="button"
          className={styles.secondaryCta}
          onClick={handleSecondaryCta}
        >
          {labels.welcome.secondaryCta}
        </button>
      </div>
    </main>
  );
}
