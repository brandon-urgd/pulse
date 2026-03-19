import { useEffect, useState } from 'react'

interface Props {
  current: number
  total: number
  animationDuration?: string
}

const KEYFRAMES = `
@keyframes pulseSegment {
  0%   { opacity: 1; }
  50%  { opacity: 0.55; }
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

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '3px',
    padding: '0 1rem',
    height: '4px',
    alignItems: 'center',
  }

  const segments = Array.from({ length: total }, (_, i) => {
    const segIndex = i + 1
    const isCompleted = segIndex < current
    const isCurrent = segIndex === current
    const isUpcoming = segIndex > current

    let bg = '#2a2a2a'
    if (isCompleted) bg = '#4a7c59'
    if (isCurrent) bg = '#4a7c59'

    const segStyle: React.CSSProperties = {
      flex: 1,
      height: '4px',
      borderRadius: '2px',
      background: bg,
      ...(isCurrent && !reducedMotion
        ? {
            animation: `pulseSegment ${animationDuration} ease-in-out infinite`,
          }
        : {}),
      ...(isUpcoming ? { opacity: 1 } : {}),
    }

    return <div key={i} style={segStyle} />
  })

  return (
    <>
      {!reducedMotion && (
        <style>{KEYFRAMES}</style>
      )}
      <div
        style={containerStyle}
        role="progressbar"
        aria-label={`Session progress: section ${current} of ${total}`}
        aria-valuenow={current}
        aria-valuemin={1}
        aria-valuemax={total}
      >
        {segments}
      </div>
    </>
  )
}
