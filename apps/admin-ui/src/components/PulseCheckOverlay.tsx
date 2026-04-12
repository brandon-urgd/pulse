import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import styles from './PulseCheckOverlay.module.css';
import { labels } from '../config/labels-registry';

// Default pulse-wave-themed phases that cycle during the wait
const DEFAULT_PHASES: { message: string; targetPct: number; durationMs: number }[] = [
  { message: labels.pulseCheck.overlayPhase1, targetPct: 18,  durationMs: 2000 },
  { message: labels.pulseCheck.overlayPhase2, targetPct: 35,  durationMs: 4000 },
  { message: labels.pulseCheck.overlayPhase3, targetPct: 52,  durationMs: 5000 },
  { message: labels.pulseCheck.overlayPhase4, targetPct: 68,  durationMs: 5000 },
  { message: labels.pulseCheck.overlayPhase5, targetPct: 82,  durationMs: 5000 },
  { message: labels.pulseCheck.overlayPhase6, targetPct: 92,  durationMs: 99999 },
];

interface PulseCheckOverlayProps {
  itemName?: string;
  /** When true, snaps bar to 100% and fades out */
  done: boolean;
  /** When set, shows error state instead */
  error?: string;
  onErrorDismiss: () => void;
  /** Custom phase messages and timings (defaults to PulseCheck phases) */
  phases?: { message: string; targetPct: number; durationMs: number }[];
  /** Custom notice text below the progress bar */
  notice?: string;
  /** Selects the patience message set — defaults to 'pulseCheck' */
  operationType?: 'pulseCheck' | 'revision';
}

const PATIENCE_LABELS = {
  pulseCheck: [
    labels.pulseCheck.patience1,
    labels.pulseCheck.patience2,
    labels.pulseCheck.patience3,
  ],
  revision: [
    labels.revision.patience1,
    labels.revision.patience2,
    labels.revision.patience3,
  ],
};

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
  phases,
  notice,
  operationType = 'pulseCheck',
}: PulseCheckOverlayProps) {
  const PHASES = phases ?? DEFAULT_PHASES;
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(true);
  const [patienceLevel, setPatienceLevel] = useState<0 | 1 | 2 | 3>(0);
  const focusTrapRef = useFocusTrap(visible);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const phaseStartPct = useRef(0);

  // Progressive patience messages at 45s, 90s, 150s
  useEffect(() => {
    if (done || error) return;
    const t1 = setTimeout(() => setPatienceLevel(1), 45000);
    const t2 = setTimeout(() => setPatienceLevel(2), 90000);
    const t3 = setTimeout(() => setPatienceLevel(3), 150000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [done, error]);

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
      ref={focusTrapRef}
      className={`${styles.backdrop} ${done ? styles.fadeOut : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Generating Pulse Check"
      aria-live="polite"
    >
      <div className={styles.card}>
        {error ? (
          <>
            <p className={styles.errorHeading}>{labels.pulseCheck.overlayErrorHeading}</p>
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
              {notice ?? labels.pulseCheck.overlayNotice}
            </p>
            {patienceLevel > 0 && (
              <p className={styles.longWaitNotice} aria-live="polite">
                {PATIENCE_LABELS[operationType][patienceLevel - 1]}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
