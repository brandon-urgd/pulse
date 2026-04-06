import { useEffect } from 'react'
import { ScanLineTrace } from '../components/ScanLineTrace'

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    backgroundColor: 'var(--color-bg)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    fontFamily: 'var(--font-body)',
    color: 'var(--color-text-primary)',
    textAlign: 'center',
    position: 'relative' as const,
  },
  heading: {
    fontSize: 'clamp(1.5rem, 5vw, 2.25rem)',
    fontWeight: 600,
    margin: '0 0 1.5rem',
    lineHeight: 1.2,
    color: 'var(--color-text-white)',
  },
  link: {
    color: 'var(--color-accent)',
    textDecoration: 'none',
    fontSize: '1rem',
    borderBottom: '1px solid transparent',
  },
}

export default function SessionNotFound() {
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    document.title = 'Session Not Found — Pulse'
  }, [])

  return (
    <main style={styles.page}>
      {!prefersReducedMotion && (
        <div style={{
          position: 'absolute',
          bottom: '20%',
          left: 0,
          right: 0,
          pointerEvents: 'none',
        }}>
          <ScanLineTrace opacity={0.035} peaks={3} />
        </div>
      )}
      <h1 style={styles.heading}>We couldn't find that session.</h1>
      <a
        href="https://pulse.urgdstudios.com"
        style={styles.link}
        onMouseEnter={e => ((e.target as HTMLAnchorElement).style.borderBottomColor = 'var(--color-accent)')}
        onMouseLeave={e => ((e.target as HTMLAnchorElement).style.borderBottomColor = 'transparent')}
      >
        Back to Pulse
      </a>
    </main>
  )
}
