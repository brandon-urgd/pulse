/**
 * ScanLineIcon — Agent avatar / brand mark
 *
 * A small rounded rectangle with a signal trace inside.
 * Replaces the circular PulseDot as the agent's visual identity in chat.
 *
 * Usage:
 *   <ScanLineIcon />              // 24px, uses CSS var --color-accent
 *   <ScanLineIcon size={16} />    // 16px for inline chat use
 *   <ScanLineIcon size={32} color="#4a7c59" />
 *
 * No dependencies — pure React + inline SVG.
 */
import React from 'react';

interface Props {
  size?: number;
  color?: string;
}

export function ScanLineIcon({ size = 24, color }: Props) {
  const c = color || 'var(--color-accent, #7a9e87)';
  const pad = size * 0.1;
  const w = size - pad * 2;
  const h = w;
  const cy = size / 2;
  const sw = Math.max(0.8, size * 0.04);
  const r = Math.max(1.5, size * 0.06);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden="true">
      {/* Display frame — rounded rectangle */}
      <rect x={pad} y={pad} width={w} height={h} rx={r} stroke={c} strokeWidth={sw} fill="none" />
      {/* Signal trace with two peaks */}
      <path
        d={`M ${pad + w * 0.1} ${cy} L ${pad + w * 0.3} ${cy} Q ${pad + w * 0.38} ${cy} ${pad + w * 0.42} ${cy - h * 0.22} Q ${pad + w * 0.46} ${cy} ${pad + w * 0.52} ${cy} L ${pad + w * 0.6} ${cy} Q ${pad + w * 0.65} ${cy} ${pad + w * 0.68} ${cy - h * 0.14} Q ${pad + w * 0.71} ${cy} ${pad + w * 0.76} ${cy} L ${pad + w * 0.9} ${cy}`}
        stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export default ScanLineIcon;
