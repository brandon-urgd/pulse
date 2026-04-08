/**
 * ScanLineLoader — Generating/loading animation
 *
 * A looping scan-line trace that draws and redraws, with status text below.
 * Use for pulse check generation, revision generation, or any async wait.
 *
 * Usage:
 *   <ScanLineLoader text="Generating revision for Product Launch Brief..." />
 *   <ScanLineLoader text="Running your Pulse Check..." />
 *   <ScanLineLoader />  // no text, just the animation
 *
 * Requires: animations.css (trace-draw keyframe)
 * No external dependencies.
 */
import React from 'react';

interface Props {
  text?: string;
  width?: number;
  color?: string;
}

export function ScanLineLoader({
  text,
  width = 200,
  color = 'var(--color-accent, #7a9e87)',
}: Props) {
  const h = 40;
  const cy = h / 2;
  const borderColor = 'var(--color-border, #373a40)';
  const textColor = 'var(--color-text-secondary, #adb5bd)';

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 16,
    }}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} fill="none" aria-hidden="true">
        {/* Baseline */}
        <line x1={0} y1={cy} x2={width} y2={cy} stroke={borderColor} strokeWidth={0.5} />
        {/* Animated trace */}
        <path
          d={`M 0 ${cy} L ${width * 0.2} ${cy} Q ${width * 0.275} ${cy} ${width * 0.325} ${cy - 12} Q ${width * 0.375} ${cy} ${width * 0.425} ${cy} L ${width * 0.6} ${cy} Q ${width * 0.65} ${cy} ${width * 0.7} ${cy - 8} Q ${width * 0.75} ${cy} ${width * 0.8} ${cy} L ${width} ${cy}`}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          style={{
            strokeDasharray: width * 2,
            strokeDashoffset: width * 2,
            animation: 'trace-draw 2s ease-out infinite',
          }}
        />
      </svg>
      {text && (
        <p style={{
          fontSize: '0.9375rem', color: textColor,
          margin: 0, fontFamily: "'Rubik', sans-serif",
        }}>
          {text}
        </p>
      )}
    </div>
  );
}

export default ScanLineLoader;
