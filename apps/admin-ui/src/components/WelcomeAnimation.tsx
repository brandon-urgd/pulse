/**
 * WelcomeAnimation — branded "pulse" splash overlay
 *
 * Sequence: fade-in 800ms → hold 1500ms → fade-out 600ms → onComplete
 * Plays every time it's rendered — the parent (Welcome.tsx) controls
 * visibility via onboardingComplete, so this only mounts for first-time users.
 * Accessibility: prefers-reduced-motion skips animation entirely.
 * Fallback: setTimeout(3000ms) fires onComplete if animationend never fires.
 *
 * Requirements: 2.1, 2.2, 2.4, 2.5, 2.6
 */
import { useEffect, useRef, useCallback } from 'react';
import styles from './WelcomeAnimation.module.css';

interface WelcomeAnimationProps {
  onComplete: () => void;
}

const FALLBACK_TIMEOUT = 3000;

export default function WelcomeAnimation({ onComplete }: WelcomeAnimationProps) {
  const firedRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const fireOnce = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    // Reduced motion: skip immediately
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fireOnce();
      return;
    }

    // Listen for the fade-out animation ending (second of two animations)
    const el = overlayRef.current;
    let animCount = 0;
    const handleAnimationEnd = () => {
      animCount += 1;
      // Two animations: fadeIn (first) and fadeOut (second)
      if (animCount >= 2) {
        fireOnce();
      }
    };

    el?.addEventListener('animationend', handleAnimationEnd);

    // Fallback timeout in case animationend never fires
    const fallback = setTimeout(fireOnce, FALLBACK_TIMEOUT);

    return () => {
      el?.removeEventListener('animationend', handleAnimationEnd);
      clearTimeout(fallback);
    };
  }, [fireOnce]);

  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return null;
  }

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      role="status"
      aria-live="polite"
      aria-label="Welcome to Pulse"
    >
      <p className={styles.wordmark}>pulse</p>
      <hr className={styles.accentLine} aria-hidden="true" />
    </div>
  );
}
