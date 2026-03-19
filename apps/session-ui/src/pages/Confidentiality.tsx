// Confidentiality agreement page — reviewer must accept before accessing the session
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { acceptConfidentiality } from '../api/session'
import { useSession } from '../context/SessionContext'

const SAGE = '#4a7c59'
const SAGE_SUBTLE = 'rgba(74, 124, 89, 0.12)'

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
  },
  card: {
    width: '100%',
    maxWidth: '520px',
    backgroundColor: '#1a1a1a',
    borderRadius: '12px',
    border: '1px solid #2a2a2a',
    overflow: 'hidden',
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
  const { sessionToken, clearSession } = useSession()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      navigate(`/s/${sessionId}/chat`, { replace: true })
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500
      if (status === 401 || status === 403) {
        clearSession()
        navigate('/s/', { replace: true })
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <ShieldIcon style={styles.shieldIcon} />
          <h1 style={styles.headerText}>Confidentiality Agreement</h1>
        </div>

        <div style={styles.body}>
          <span style={styles.wordmark} aria-label="Pulse">pulse</span>

          <p style={styles.paragraph}>
            Before you begin, please review and accept the following terms. Your feedback will be
            collected and processed by Pulse on behalf of the person who invited you.
          </p>
          <p style={styles.paragraph}>
            Your responses are confidential and will only be shared in aggregate form with the
            item owner. Your personal information will not be disclosed to third parties except
            as required by law.
          </p>
          <p style={styles.paragraph}>
            By clicking "I Accept" below, you agree to our terms of use and acknowledge our
            privacy policy.
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
    </main>
  )
}
