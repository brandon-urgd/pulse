/**
 * ScanLineTrace — Atmospheric background SVG trace
 *
 * Usage:
 *   <ScanLineTrace />                          // defaults: 800w, 40h, 4% opacity, 3 peaks
 *   <ScanLineTrace opacity={0.03} peaks={2} /> // subtle, fewer peaks
 *
 * Place behind glass cards or branded backgrounds. The trace is static (no animation).
 * For animated traces, see ScanScopeTransition or SplashVariations.
 *
 * No dependencies — pure React + inline SVG.
 */
import React from 'react';

interface Props {
  width?: number;
  height?: number;
  opacity?: number;
  peaks?: number;
  color?: string;
}

export function ScanLineTrace({
  width = 800,
  height = 40,
  opacity = 0.04,
  peaks = 3,
  color = 'var(--color-accent, #7a9e87)',
}: Props) {
  const cy = height / 2;
  const positions = Array.from({ length: peaks }, (_, i) => 0.15 + (i / peaks) * 0.7);
  const heights = positions.map((_, i) => height * (0.2 + Math.sin(i * 1.7) * 0.1));

  let d = `M 0 ${cy}`;
  positions.forEach((pos, i) => {
    const x = width * pos;
    const h = heights[i];
    d += ` L ${x - width * 0.04} ${cy}`;
    d += ` Q ${x - width * 0.01} ${cy} ${x} ${cy - h}`;
    d += ` Q ${x + width * 0.01} ${cy} ${x + width * 0.03} ${cy}`;
  });
  d += ` L ${width} ${cy}`;

  return (
    <svg
      width="100%" height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      fill="none"
      style={{ opacity, display: 'block' }}
      aria-hidden="true"
    >
      {/* Baseline */}
      <line x1={0} y1={cy} x2={width} y2={cy} stroke={color} strokeWidth={0.5} opacity={0.3} />
      {/* Signal trace with peaks */}
      <path d={d} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export default ScanLineTrace;
