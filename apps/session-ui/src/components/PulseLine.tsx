import { useEffect, useState } from 'react'

interface Props {
  current: number
  total: number
  animationDuration?: string
}

const KEYFRAMES = `
@keyframes pulseGlow {
  0%   { opacity: 1; }
  50%  { opacity: 0.6; }
  100% { opacity: 1; }
}
`

export default function PulseLine({ current, total, animationDuration = '2s' }: Props) {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Percentage complete — sections completed (not including current) / total
  // Current section counts as half-done to give a sense of progress within it
  const pct = total > 0 ? Math.min(100, ((current - 0.5) / total) * 100) : 0

  const trackStyle: React.CSSProperties = {
    width: '100%',
    height: '3px',
    background: '#2a2a2a',
    position: 'relative' as const,
    overflow: 'hidden',
  }

  const fillStyle: React.CSSProperties = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    height: '100%',
    width: `${pct}%`,
    background: '#4a7c59',
    borderRadius: '0 2px 2px 0',
    transition: 'width 0.6s ease',
    ...(pct > 0 && pct < 100 && !reducedMotion
      ? { animation: `pulseGlow ${animationDuration} ease-in-out infinite` }
      : {}),
  }

  const pctRounded = Math.round(pct)

  return (
    <>
      {!reducedMotion && <style>{KEYFRAMES}</style>}
      <div
        style={{ padding: '0 1rem' }}
        role="progressbar"
        aria-label={`Session progress: ${pctRounded}% complete`}
        aria-valuenow={pctRounded}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={trackStyle}>
          <div style={fillStyle} />
        </div>
      </div>
    </>
  )
}
