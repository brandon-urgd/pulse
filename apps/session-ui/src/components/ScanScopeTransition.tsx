/**
 * ScanScopeTransition — Full-screen splash animation (CF-2)
 *
 * Usage:
 *   <ScanScopeTransition playing={true} onComplete={() => navigate('/next')} />
 *
 * Sequence (5s total):
 *   0.0s — Black screen, grid fades in
 *   0.8s — Trace begins drawing left-to-right with peak glows
 *   2.0s — "Welcome to pulse" slides up from bottom
 *   2.2s — "by ur/gd Studios" slides up
 *   3.8s — Everything fades to black
 *   4.8s — onComplete fires
 *
 * Requires: animations.css (trace-draw, peak-flash, fade-in keyframes)
 * No external dependencies — pure React + inline styles + CSS keyframes.
 */
import React, { useEffect, useState } from 'react';

type Phase = 'idle' | 'in' | 'hold' | 'out' | 'done';

interface Props {
  /** Set to true to start the animation */
  playing: boolean;
  /** Called when the full sequence completes (~5s) */
  onComplete?: () => void;
}

function FullWidthTrace({ animate }: { animate: boolean }) {
  const w = 1200, h = 600, cy = h / 2;
  const uid = `cf2-${Math.random().toString(36).slice(2, 6)}`;
  const peaks = [0.2, 0.42, 0.65, 0.82];
  const peakH = [h * 0.12, h * 0.08, h * 0.14, h * 0.06];

  let d = `M 0 ${cy}`;
  peaks.forEach((pos, i) => {
    const x = w * pos;
    const prev = i === 0 ? 0 : w * peaks[i - 1] + w * 0.04;
    d += ` L ${prev + (x - prev) * 0.4} ${cy}`;
    d += ` Q ${x - w * 0.015} ${cy} ${x} ${cy - peakH[i]}`;
    d += ` Q ${x + w * 0.015} ${cy} ${x + w * 0.03} ${cy}`;
  });
  d += ` L ${w} ${cy}`;

  return (
    <svg
      width="100%" height="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      fill="none"
      style={{ position: 'absolute', inset: 0 }}
    >
      <defs>
        <filter id={`g-${uid}`}>
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* Grid lines */}
      <g style={{ opacity: animate ? 0.08 : 0, transition: 'opacity 0.5s ease' }}>
        {[1, 2, 3, 4, 5, 6, 7].map(i => (
          <line key={`v${i}`} x1={w * i / 8} y1={0} x2={w * i / 8} y2={h} stroke="var(--color-text-muted)" strokeWidth={0.5} />
        ))}
        {[1, 2, 3, 4].map(i => (
          <line key={`h${i}`} x1={0} y1={h * i / 5} x2={w} y2={h * i / 5} stroke="var(--color-text-muted)" strokeWidth={0.5} />
        ))}
      </g>

      {/* Baseline */}
      <line
        x1={0} y1={cy} x2={w} y2={cy}
        stroke="var(--color-text-muted)" strokeWidth={0.5}
        style={{ opacity: animate ? 0.15 : 0, transition: 'opacity 0.5s ease 0.3s' }}
      />

      {/* Signal trace — draws left to right */}
      {animate && (
        <path
          d={d} stroke="var(--color-accent)" strokeWidth={2} fill="none"
          strokeLinecap="round" strokeLinejoin="round" opacity={0.45}
          style={{
            strokeDasharray: w * 2,
            strokeDashoffset: w * 2,
            animation: 'trace-draw 2.5s ease-out forwards 0.8s',
          }}
        />
      )}

      {/* Peak glows */}
      {animate && peaks.map((pos, i) => (
        <circle
          key={i} cx={w * pos} cy={cy - peakH[i]} r={3}
          fill="var(--color-accent-glow)" filter={`url(#g-${uid})`}
          style={{ opacity: 0, animation: `peak-flash 0.4s ease-out ${0.8 + pos * 2.5}s forwards` }}
        />
      ))}
    </svg>
  );
}

export function ScanScopeTransition({ playing, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');

  useEffect(() => {
    if (!playing) { setPhase('idle'); return; }

    setPhase('in');
    const t1 = setTimeout(() => setPhase('hold'), 2000);
    const t2 = setTimeout(() => setPhase('out'), 3800);
    const t3 = setTimeout(() => {
      setPhase('done');
      onComplete?.();
    }, 4800);

    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [playing, onComplete]);

  if (phase === 'idle' || phase === 'done') return null;

  const showTrace = phase === 'in' || phase === 'hold';
  const showText = phase === 'hold';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'var(--color-bg)', zIndex: 9999,
        opacity: phase === 'out' ? 0 : 1,
        transition: phase === 'out' ? 'opacity 1.2s ease-out' : 'opacity 0.4s ease-in',
      }}
      aria-live="polite"
      aria-label="Scanning for signal…"
    >
      <FullWidthTrace animate={showTrace} />

      <div style={{
        position: 'absolute', inset: 0, zIndex: 5,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {/* "Welcome to pulse" */}
        <div style={{
          opacity: showText ? 1 : 0,
          transform: `translateY(${showText ? 0 : 30}px)`,
          transition: 'opacity 0.6s ease, transform 0.6s cubic-bezier(0, 0, 0.2, 1)',
          textAlign: 'center',
        }}>
          <span style={{
            fontFamily: "'Rubik', sans-serif", fontWeight: 400,
            fontSize: '1.25rem', color: 'hsl(220,14%,96%)',
          }}>Welcome to </span>
          <span style={{
            fontFamily: "'Rubik', sans-serif", fontWeight: 300,
            fontSize: '2rem', color: 'var(--color-accent)', letterSpacing: '0.12em',
          }}>pulse</span>
        </div>

        {/* "by ur/gd Studios" */}
        <div style={{
          opacity: showText ? 1 : 0,
          transform: `translateY(${showText ? 0 : 30}px)`,
          transition: 'opacity 0.7s ease 0.15s, transform 0.7s cubic-bezier(0, 0, 0.2, 1) 0.15s',
          marginTop: 14,
        }}>
          <span style={{
            fontFamily: "'Rubik', sans-serif", fontWeight: 400,
            fontSize: '0.9375rem', color: 'var(--color-text-muted)',
          }}>by ur/gd Studios</span>
        </div>
      </div>
    </div>
  );
}

export default ScanScopeTransition;
