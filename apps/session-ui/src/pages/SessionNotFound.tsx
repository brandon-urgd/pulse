import { useEffect } from 'react'

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    backgroundColor: '#0f0f0f',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#e5e5e5',
    textAlign: 'center',
  },
  heading: {
    fontSize: 'clamp(1.5rem, 5vw, 2.25rem)',
    fontWeight: 600,
    margin: '0 0 1.5rem',
    lineHeight: 1.2,
    color: '#ffffff',
  },
  link: {
    color: '#7C9E8A',
    textDecoration: 'none',
    fontSize: '1rem',
    borderBottom: '1px solid transparent',
  },
}

export default function SessionNotFound() {
  useEffect(() => {
    document.title = 'Session Not Found — Pulse'
  }, [])

  return (
    <main style={styles.page}>
      <h1 style={styles.heading}>We couldn't find that session.</h1>
      <a
        href="https://pulse.urgdstudios.com"
        style={styles.link}
        onMouseEnter={e => ((e.target as HTMLAnchorElement).style.borderBottomColor = '#7C9E8A')}
        onMouseLeave={e => ((e.target as HTMLAnchorElement).style.borderBottomColor = 'transparent')}
      >
        Back to Pulse
      </a>
    </main>
  )
}
