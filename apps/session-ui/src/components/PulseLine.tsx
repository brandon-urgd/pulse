import { useEffect, useState } from 'react'

export interface SectionEntry {
  id: string
  wordCount?: number
}

interface Props {
  current: number
  total: number
  sections?: SectionEntry[]
  animationDuration?: string
}

const KEYFRAMES = `
@keyframes pulseGlow {
  0%   { opacity: 1; }
  50%  { opacity: 0.6; }
  100% { opacity: 1; }
}
`

export function computeWeights(sections: SectionEntry[]): number[] {
  const totalWords = sections.reduce((sum, s) => sum + (s.wordCount ?? 0), 0)
  const useWordCount = totalWords > 0 && sections.every(s => s.wordCount != null)
  if (!useWordCount) return sections.map(() => 1 / sections.length)
  return sections.map(s => s.wordCount! / totalWords)
}

export default function PulseLine({ current, total, sections, animationDuration = '2s' }: Props) {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Compute progress percentage using word-count weights when available
  let pct: number
  if (total <= 0) {
    pct = 0
  } else if (current >= total) {
    pct = 100
  } else if (sections && sections.length > 0) {
    const weights = computeWeights(sections)
    const completedWeight = weights.slice(0, current - 1).reduce((a, b) => a + b, 0)
    const currentWeight = weights[current - 1] ?? 0
    pct = Math.min(100, (completedWeight + currentWeight * 0.5) * 100)
  } else {
    // Fallback: equal weights via original formula
    pct = Math.min(100, ((current - 0.5) / total) * 100)
  }

  // Clamp to [0, 100]
  pct = Math.max(0, Math.min(100, pct))

  const trackStyle: React.CSSProperties = {
    width: '100%',
    height: '3px',
    background: 'var(--color-border)',
    position: 'relative' as const,
    overflow: 'hidden',
  }

  const fillStyle: React.CSSProperties = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    height: '100%',
    width: `${pct}%`,
    background: 'var(--color-accent-deep)',
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
