// Confidentiality agreement page — reviewer must accept before accessing the session
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { acceptConfidentiality } from '../api/session'
import { useSession } from '../context/SessionContext'
import SessionFooter from '../components/SessionFooter'

const SAGE = '#4a7c59'
const SAGE_SUBTLE = 'rgba(74, 124, 89, 0.12)'

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100dvh',
    backgroundColor: '#0f0f0f',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    padding: '2rem 1.5rem 1.5rem',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#e5e5e5',
  },
  card: {
    width: '100%',
    maxWidth: '520px',
    backgroundColor: '#1a1a1a',
    borderRadius: '12px',
    border: '1px solid #2a2a2a',
    overflow: 'visible',
  },
  header: {
    backgroundColor: SAGE_SUBTLE,
    borderBottom: `1px solid ${SAGE}33`,
    padding: '1.5rem 2rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
  },
  shieldIcon: {
    width: '28px',
    height: '28px',
    color: SAGE,
    flexShrink: 0,
  },
  headerText: {
    fontSize: '1.125rem',
    fontWeight: 600,
    color: '#ffffff',
    margin: 0,
  },
  body: {
    padding: '1.75rem 2rem',
  },
  wordmark: {
    fontSize: '0.875rem',
    fontWeight: 700,
    color: SAGE,
    letterSpacing: '0.05em',
    textTransform: 'lowercase' as const,
    marginBottom: '1rem',
    display: 'block',
  },
  paragraph: {
    fontSize: '0.9375rem',
    color: '#ccc',
    lineHeight: 1.65,
    margin: '0 0 1rem',
  },
  linksRow: {
    display: 'flex',
    gap: '1.25rem',
    flexWrap: 'wrap' as const,
    marginBottom: '1.75rem',
  },
  link: {
    fontSize: '0.875rem',
    color: SAGE,
    textDecoration: 'none',
    borderBottom: '1px solid transparent',
  },
  button: {
    width: '100%',
    padding: '0.75rem',
    backgroundColor: SAGE,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  buttonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  error: {
    backgroundColor: '#2a1a1a',
    border: '1px solid #5a2a2a',
    borderRadius: '6px',
    padding: '0.75rem 1rem',
    color: '#f87171',
    fontSize: '0.875rem',
    marginBottom: '1.25rem',
    lineHeight: 1.5,
  },
}

// Minimal inline shield SVG icon
function ShieldIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

export default function Confidentiality() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const { sessionToken, itemName, clearSession } = useSession()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  const [fadeOut, setFadeOut] = useState(false)

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    document.title = 'Confidentiality Agreement — Pulse'
  }, [])

  // Redirect to validate if no session token
  useEffect(() => {
    if (!sessionToken || !sessionId) {
      navigate('/s/', { replace: true })
    }
  }, [sessionToken, sessionId, navigate])

  const handleAccept = async () => {
    if (!sessionId || !sessionToken) return
    setError(null)
    setLoading(true)

    try {
      await acceptConfidentiality(sessionId, sessionToken)

      if (prefersReducedMotion) {
        navigate(`/s/${sessionId}/chat`, { replace: true })
        return
      }

      // Fade out the card, then show transition screen, then navigate
      setFadeOut(true)
      setTimeout(() => {
        setTransitioning(true)
        setTimeout(() => {
          navigate(`/s/${sessionId}/chat`, { replace: true })
        }, 1200)
      }, 300)
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500
      setLoading(false)
      if (status === 401 || status === 403) {
        clearSession()
        navigate('/s/', { replace: true })
      } else {
        setFadeOut(false)
        setError('Something went wrong. Please try again.')
      }
    }
  }

  // Transition screen — full black fade with "Let's get your pulse..."
  if (transitioning) {
    return (
      <div
        style={{
          minHeight: '100dvh',
          backgroundColor: '#0f0f0f',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          animation: 'pulseTextFadeIn 0.4s ease forwards',
        }}
        aria-live="polite"
        aria-label="Starting session"
      >
        <style>{`
          @keyframes pulseTextFadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>
        <p style={{
          fontSize: '1.25rem',
          fontWeight: 500,
          color: SAGE,
          letterSpacing: '0.02em',
          margin: 0,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          Let's get your pulse...
        </p>
      </div>
    )
  }

  return (
    <main
      className="page-scrollable"
      style={{
        ...styles.page,
        opacity: fadeOut ? 0 : 1,
        transition: 'opacity 0.3s ease',
      }}
    >
      <div style={styles.card}>
        <div style={styles.header}>
          <ShieldIcon style={styles.shieldIcon} />
          <h1 style={styles.headerText}>Confidentiality Agreement</h1>
        </div>

        <div style={styles.body}>
          <span style={styles.wordmark} aria-label="Pulse">pulse</span>

          {itemName && (
            <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: '1.25rem', marginTop: 0 }}>
              Reviewing: <strong style={{ color: '#ccc' }}>{itemName}</strong>
            </p>
          )}

          <p style={styles.paragraph}>
            The material you are about to review may contain non-public, proprietary, or sensitive
            information belonging to the person who invited you. By participating, you agree to
            treat that material with discretion and not share, reproduce, or distribute it outside
            of this session.
          </p>
          <p style={styles.paragraph}>
            Your feedback will be collected and processed by Pulse on behalf of the person who
            invited you. Your responses, including the conversation transcript, may be reviewed
            by the item owner.
          </p>
          <p style={styles.paragraph}>
            By clicking "I Accept" you agree to our Terms of Use and acknowledge our Privacy Policy.
          </p>

          <div style={styles.linksRow}>
            <a
              href="https://urgdstudios.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              Privacy Policy
            </a>
            <a
              href="https://urgdstudios.com/terms"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              Terms of Use
            </a>
            <a
              href="https://urgdstudios.com/contact"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.link}
            >
              Contact
            </a>
          </div>

          {error && (
            <div role="alert" aria-live="polite" style={styles.error}>
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleAccept}
            style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
            disabled={loading}
          >
            {loading ? 'Accepting…' : 'I Accept'}
          </button>
        </div>
      </div>
      <SessionFooter sessionId={sessionId} sessionToken={sessionToken ?? undefined} />
    </main>
  )
}
