// Session validation page — reviewer enters credentials to access their session
// Accepts ?code={pulseCode} query param or /{sessionId} path param
// Accepts ?public=1 to show the public walk-in entry form
// Accepts ?preview=true to auto-validate a preview session (no email required)
// Accepts ?token={tenantId}:{sessionId} to auto-authenticate a self-review session
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { validateSession } from '../api/session'
import { useSession } from '../context/SessionContext'
import SessionFooter from '../components/SessionFooter'

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
    maxWidth: '420px',
    backgroundColor: '#1a1a1a',
    borderRadius: '12px',
    padding: '2rem',
    border: '1px solid #2a2a2a',
  },
  wordmark: {
    fontSize: '1.125rem',
    fontWeight: 700,
    color: '#7C9E8A',
    letterSpacing: '0.05em',
    textTransform: 'lowercase' as const,
    marginBottom: '1.5rem',
    display: 'block',
  },
  heading: {
    fontSize: '1.375rem',
    fontWeight: 600,
    color: '#ffffff',
    margin: '0 0 0.5rem',
  },
  subheading: {
    fontSize: '0.9375rem',
    color: '#999',
    margin: '0 0 1.75rem',
    lineHeight: 1.5,
  },
  label: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#ccc',
    marginBottom: '0.375rem',
  },
  optionalLabel: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#ccc',
    marginBottom: '0.375rem',
  },
  optionalHint: {
    fontSize: '0.75rem',
    color: '#666',
    marginLeft: '0.375rem',
  },
  input: {
    width: '100%',
    padding: '0.625rem 0.75rem',
    backgroundColor: '#111',
    border: '1px solid #333',
    borderRadius: '6px',
    color: '#e5e5e5',
    fontSize: '1rem',
    outline: 'none',
    boxSizing: 'border-box' as const,
    marginBottom: '1.25rem',
  },
  button: {
    width: '100%',
    padding: '0.75rem',
    backgroundColor: '#4a7c59',
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

function getErrorMessage(status: number): string {
  if (status === 403) return "That email address doesn't match our records. Check your invitation email and try again."
  if (status === 410) return 'This session has expired. Contact the person who invited you for more information.'
  if (status === 404) return "We couldn't find that session. Check your invitation link or pulse code."
  return 'Something went wrong. Please try again.'
}

export default function SessionValidate() {
  const { sessionId: pathSessionId } = useParams<{ sessionId: string }>()
  const [searchParams] = useSearchParams()
  const pulseCode = searchParams.get('code') ?? undefined
  const isPublic = searchParams.get('public') === '1'
  const isPreviewMode = searchParams.get('preview') === 'true'
  const tokenParam = searchParams.get('token') ?? undefined
  const navigate = useNavigate()
  const { setSession } = useSession()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.title = 'Access Your Session — Pulse'
  }, [])

  // Self-review mode: token param carries {tenantId}:{sessionId} — skip validate entirely
  useEffect(() => {
    if (!tokenParam || !pathSessionId) return
    // Token is already valid (issued by createSelfSession Lambda)
    // We don't have itemName here, but it's not critical for self-review flow
    setSession(tokenParam, pathSessionId, '', false)
    navigate(`/s/${pathSessionId}/confidentiality`, { replace: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenParam, pathSessionId])

  // Preview mode: auto-validate without email — skip confidentiality, go straight to chat
  useEffect(() => {
    if (!isPreviewMode || !pulseCode) return

    let cancelled = false
    setLoading(true)

    validateSession({ pulseCode })
      .then((result) => {
        if (cancelled) return
        setSession(result.sessionToken, result.sessionId, result.item.itemName ?? '', true)
        // Skip confidentiality in preview mode — go directly to chat
        navigate(`/s/${result.sessionId}/chat`, { replace: true })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const status = (err as { status?: number }).status ?? 500
        if (status === 410) {
          setError('This preview has expired.')
        } else {
          setError(getErrorMessage(status))
        }
        setLoading(false)
      })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPreviewMode, pulseCode])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (isPublic) {
      // Public session: name required, email optional
      if (!name.trim()) {
        setError('Please enter your name.')
        return
      }
    } else {
      // Private session: email required
      if (!email.trim()) {
        setError('Please enter your email address.')
        return
      }
    }

    setLoading(true)
    try {
      const result = await validateSession({
        email: isPublic ? (email.trim() || undefined) : email.trim(),
        name: isPublic ? name.trim() : undefined,
        ...(pulseCode ? { pulseCode } : {}),
        ...(pathSessionId && !pulseCode ? { sessionId: pathSessionId } : {}),
      })

      setSession(result.sessionToken, result.sessionId, result.item.itemName)
      navigate(`/s/${result.sessionId}/confidentiality`, { replace: true })
    } catch (err: unknown) {
      const status = (err as { status?: number }).status ?? 500
      setError(getErrorMessage(status))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <span style={styles.wordmark} aria-label="Pulse">pulse</span>

        {isPublic ? (
          <>
            <h1 style={styles.heading}>Join this session</h1>
            <p style={styles.subheading}>
              You're joining a public feedback session. Enter your name to get started.
            </p>
          </>
        ) : (
          <>
            <h1 style={styles.heading}>Access your session</h1>
            <p style={styles.subheading}>
              Enter the email address where you received your invitation to continue.
            </p>
          </>
        )}

        {error && (
          <div role="alert" aria-live="polite" style={styles.error}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate>
          {isPublic ? (
            <>
              <label htmlFor="name" style={styles.label}>Your name</label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Jane Smith"
                style={styles.input}
                disabled={loading}
                required
              />
              <label htmlFor="email" style={styles.optionalLabel}>
                Email address
                <span style={styles.optionalHint}>(optional)</span>
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={styles.input}
                disabled={loading}
              />
            </>
          ) : (
            <>
              <label htmlFor="email" style={styles.label}>Email address</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                style={styles.input}
                disabled={loading}
                required
              />
            </>
          )}

          <button
            type="submit"
            style={{ ...styles.button, ...(loading ? styles.buttonDisabled : {}) }}
            disabled={loading}
          >
            {loading ? 'Verifying…' : 'Continue'}
          </button>
        </form>
      </div>
      <SessionFooter />
    </main>
  )
}
