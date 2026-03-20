import { useEffect, useRef, useState } from 'react';
import styles from './PulseCheckOverlay.module.css';

// Phrases that cycle during the wait — heartbeat metaphor, calm and a little alive
const PHASES: { message: string; targetPct: number; durationMs: number }[] = [
  { message: 'Checking your pulse…',                  targetPct: 18,  durationMs: 2000 },
  { message: 'Feeling for a heartbeat…',              targetPct: 35,  durationMs: 4000 },
  { message: 'Listening for what\'s alive in here…',  targetPct: 52,  durationMs: 5000 },
  { message: 'Finding what\'s beating strongest…',    targetPct: 68,  durationMs: 5000 },
  { message: 'Taking the temperature…',               targetPct: 82,  durationMs: 5000 },
  { message: 'Almost got a read…',                    targetPct: 92,  durationMs: 99999 },
];

interface PulseCheckOverlayProps {
  itemName?: string;
  /** When true, snaps bar to 100% and fades out */
  done: boolean;
  /** When set, shows error state instead */
  error?: string;
  onErrorDismiss: () => void;
}

/**
 * Full-screen overlay shown while a Pulse Check is generating.
 * Simulates progress through named phases since Bedrock gives no streaming signal.
 * Fades out automatically on completion.
 */
export default function PulseCheckOverlay({
  itemName,
  done,
  error,
  onErrorDismiss,
}: PulseCheckOverlayProps) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(true);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const phaseStartPct = useRef(0);

  // Animate the bar through phases
  useEffect(() => {
    if (done || error) return;

    const phase = PHASES[phaseIndex];
    if (!phase) return;

    const from = phaseStartPct.current;
    const to = phase.targetPct;
    const duration = phase.durationMs;

    const animate = (now: number) => {
      if (!startRef.current) startRef.current = now;
      const elapsed = now - startRef.current;
      const t = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setPct(from + (to - from) * eased);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        // Move to next phase
        phaseStartPct.current = to;
        startRef.current = null;
        if (phaseIndex < PHASES.length - 1) {
          setPhaseIndex((i) => i + 1);
        }
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [phaseIndex, done, error]);

  // Snap to 100% then fade out when done
  useEffect(() => {
    if (!done) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPct(100);
    const t = setTimeout(() => setVisible(false), 600);
    return () => clearTimeout(t);
  }, [done]);

  if (!visible) return null;

  const currentPhase = PHASES[Math.min(phaseIndex, PHASES.length - 1)];

  return (
    <div
      className={`${styles.backdrop} ${done ? styles.fadeOut : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Generating Pulse Check"
      aria-live="polite"
    >
      <div className={styles.card}>
        {error ? (
          <>
            <p className={styles.errorHeading}>Something went wrong.</p>
            <p className={styles.errorMessage}>{error}</p>
            <button
              type="button"
              className={styles.dismissButton}
              onClick={onErrorDismiss}
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <div className={styles.wordmark}>pulse</div>
            {itemName && (
              <p className={styles.itemName}>{itemName}</p>
            )}
            <p className={styles.phase} aria-live="polite">
              {currentPhase.message}
            </p>

            <div className={styles.barTrack} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={styles.barFill}
                style={{ width: `${pct}%` }}
              />
            </div>

            <p className={styles.notice}>
              Don't close this tab — your Pulse Check is being generated.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
