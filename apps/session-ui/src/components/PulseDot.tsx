import { useEffect, useState } from 'react'

type DotState = 'idle' | 'active' | 'thinking'

interface Props {
  state: DotState
}

const KEYFRAMES = `
@keyframes pulseDotRing {
  0%   { transform: scale(1);    opacity: 0.6; }
  100% { transform: scale(1.43); opacity: 0; }
}
@keyframes pulseDotThink {
  0%, 100% { opacity: 0.5; }
  50%       { opacity: 1.0; }
}
`

export default function PulseDot({ state }: Props) {
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const wrapperStyle: React.CSSProperties = {
    position: 'relative',
    width: '28px',
    height: '28px',
    flexShrink: 0,
  }

  const circleStyle: React.CSSProperties = {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: '#4a7c59',
    position: 'absolute',
    top: 0,
    left: 0,
    ...(state === 'thinking' && !reducedMotion
      ? { animation: 'pulseDotThink 1.5s ease-in-out infinite' }
      : {}),
  }

  const ringStyle: React.CSSProperties = {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    border: '2px solid #4a7c59',
    position: 'absolute',
    top: 0,
    left: 0,
    animation: 'pulseDotRing 1.5s ease-out infinite',
    transformOrigin: 'center',
  }

  return (
    <>
      {!reducedMotion && <style>{KEYFRAMES}</style>}
      <div style={wrapperStyle} aria-hidden="true">
        {state === 'active' && !reducedMotion && <div style={ringStyle} />}
        <div style={circleStyle} />
      </div>
    </>
  )
}
