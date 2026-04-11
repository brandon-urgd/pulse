import { useEffect, useState } from 'react'
import { PulseWaveIcon } from './PulseWaveIcon'

const KEYFRAMES = `
@keyframes thinkDot {
  0%, 100% { opacity: 0.3; }
  50%       { opacity: 1.0; }
}
`

export default function ThinkingIndicator() {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.5rem',
    minWidth: 0,
    maxWidth: '100%',
  }

  const bubbleStyle: React.CSSProperties = {
    background: 'var(--color-surface)',
    borderRadius: '16px 16px 16px 4px',
    padding: '0.75rem 1rem',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }

  const dotStyle = (delayMs: number): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--color-accent-deep)',
    opacity: reducedMotion ? 0.6 : undefined,
    animation: reducedMotion
      ? undefined
      : `thinkDot 1.2s ease-in-out ${delayMs}ms infinite`,
  })

  return (
    <>
      {!reducedMotion && <style>{KEYFRAMES}</style>}
      <div style={rowStyle}>
        <PulseWaveIcon size={28} />
        <div
          style={bubbleStyle}
          aria-label="Agent is thinking"
          role="status"
          aria-live="polite"
        >
          <div style={dotStyle(0)} />
          <div style={dotStyle(200)} />
          <div style={dotStyle(400)} />
        </div>
      </div>
    </>
  )
}
