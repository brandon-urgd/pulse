/**
 * ScanLineIcon — Agent avatar / brand mark
 *
 * Renders the Pulse avatar SVG asset (pulse-avatar.svg) at the requested size.
 * Used as the AI agent identity icon in chat bubbles and thinking indicators.
 *
 * Usage:
 *   <ScanLineIcon />              // 24px default
 *   <ScanLineIcon size={16} />    // 16px for inline chat use
 *   <ScanLineIcon size={32} />
 *
 * No dependencies — pure React + img element referencing the static SVG asset.
 */
import React from 'react';

interface Props {
  size?: number;
  color?: string;
}

export function ScanLineIcon({ size = 24 }: Props) {
  return (
    <img
      src="/assets/pulse-avatar.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      role="img"
      style={{ display: 'block', flexShrink: 0 }}
    />
  );
}

export default ScanLineIcon;
