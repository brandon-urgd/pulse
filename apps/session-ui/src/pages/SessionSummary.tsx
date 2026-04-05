import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../context/SessionContext'
import { getSessionSummary, submitSummaryFeedback } from '../api/session'
import PulseLine from '../components/PulseLine'
import SessionFooter from '../components/SessionFooter'
import EmailOptIn from '../components/EmailOptIn'

interface SummaryData {
  sections: string[]
  themes: string[]
  closingMessage: string
  tenantName?: string
  summaryFeedback?: { rating?: string; reason?: string }
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100dvh',
    background: '#0f0f0f',
    color: '#e5e5e5',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    overflowY: 'auto' as const,
  },
  topBar: {
    width: '100%',
    maxWidth: '600px',
    height: '48px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    marginBottom: '0.5rem',
  },
  wordmark: {
    color: '#7C9E8A',
    fontWeight: 700,
    letterSpacing: '0.05em',
    fontSize: '0.875rem',
  },
  backLink: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  closeButton: {
    background: 'transparent',
    border: '1px solid #3a3a3a',
    borderRadius: '6px',
    color: '#888',
    fontSize: '0.875rem',
    padding: '0.25rem 0.75rem',
    cursor: 'pointer',
  },
  content: {
    width: '100%',
    maxWidth: '600px',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
    padding: '0 1rem 3rem',
  },
  pulseLineWrapper: {
    padding: '0.5rem 0',
  },
  card: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderLeft: '4px solid #4a7c59',
    borderRadius: '12px',
    padding: '2rem 2rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.75rem',
  },
  cardHeading: {
    fontSize: '1.25rem',
    fontWeight: 700,
    color: '#ffffff',
    margin: 0,
  },
  sectionSubheading: {
    fontSize: '0.75rem',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    color: '#888',
    margin: '0 0 0.75rem',
  },
  sectionList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  sectionItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    fontSize: '0.9375rem',
    color: '#e5e5e5',
    lineHeight: 1.5,
  },
  checkmark: {
    color: '#4a7c59',
    flexShrink: 0,
    fontWeight: 700,
  },
  themeList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
  themeItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    fontSize: '0.9375rem',
    color: '#e5e5e5',
    lineHeight: 1.6,
    fontWeight: 500,
  },
  themeDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: '#4a7c59',
    flexShrink: 0,
    marginTop: '0.5em',
  },
  divider: {
    borderTop: '1px solid #2a2a2a',
    margin: '0',
  },
  closingMessage: {
    fontStyle: 'italic',
    color: '#ccc',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
    margin: 0,
  },
  footer: {
    fontSize: '0.8125rem',
    color: '#888',
    margin: 0,
  },
  loadingState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '4rem 1rem',
    color: '#888',
    fontSize: '0.9375rem',
  },
  errorState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    padding: '4rem 1rem',
    color: '#888',
    fontSize: '0.9375rem',
    textAlign: 'center' as const,
  },
}

// ─── Feedback styles ──────────────────────────────────────────────────────────

const feedbackStyles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: '1.5rem',
    padding: '1.25rem',
    border: '1px solid #2a2a2a',
    borderRadius: '12px',
    background: '#1a1a1a',
    textAlign: 'center' as const,
  },
  prompt: {
    margin: '0 0 0.75rem',
    fontSize: '0.875rem',
    color: '#ccc',
  },
  buttons: {
    display: 'flex',
    justifyContent: 'center',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  button: {
    fontSize: '1.25rem',
    padding: '0.375rem 0.75rem',
    borderRadius: '8px',
    border: '1px solid #3a3a3a',
    background: '#1a1a1a',
    cursor: 'pointer',
  },
  buttonDisabled: {
    fontSize: '1.25rem',
    padding: '0.375rem 0.75rem',
    borderRadius: '8px',
    border: '1px solid #3a3a3a',
    background: '#1a1a1a',
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  selected: {
    fontSize: '1.25rem',
    padding: '0.375rem 0.75rem',
    borderRadius: '8px',
    border: '1px solid #4a7c59',
    background: 'rgba(74, 124, 89, 0.15)',
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  reasonPills: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    justifyContent: 'center',
    gap: '0.5rem',
    marginTop: '0.75rem',
  },
  reasonPrompt: {
    margin: '0 0 0.5rem',
    fontSize: '0.8125rem',
    color: '#888',
    width: '100%',
  },
  pill: {
    padding: '0.25rem 0.75rem',
    borderRadius: '999px',
    fontSize: '0.75rem',
    border: '1px solid #3a3a3a',
    background: '#1a1a1a',
    color: '#ccc',
    cursor: 'pointer',
  },
  thanks: {
    fontSize: '0.875rem',
    color: '#4a7c59',
    fontWeight: 500,
    margin: '0.5rem 0 0',
  },
}

// ─── SummaryFeedback ──────────────────────────────────────────────────────────

function SummaryFeedback({ sessionId, sessionToken, existingFeedback }: {
  sessionId: string
  sessionToken: string
  existingFeedback?: { rating?: string; reason?: string }
}) {
  const [rating, setRating] = useState<'up' | 'down' | null>((existingFeedback?.rating as 'up' | 'down') ?? null)
  const [showReasons, setShowReasons] = useState(false)
  const [submitted, setSubmitted] = useState(!!existingFeedback?.rating)

  const reasons = [
    { key: 'didnt_capture', label: "Didn't capture what I said" },
    { key: 'felt_generic', label: 'Felt generic' },
    { key: 'left_out_important', label: 'Left out the important parts' },
    { key: 'wouldnt_share', label: "I wouldn't share this" },
  ]

  const handleUp = async () => {
    setRating('up')
    setSubmitted(true)
    try {
      await submitSummaryFeedback(sessionId, sessionToken, { rating: 'up', timestamp: new Date().toISOString() })
    } catch { /* best-effort */ }
  }

  const handleDown = () => {
    setRating('down')
    setShowReasons(true)
  }

  const handleReason = async (reasonKey: string) => {
    setSubmitted(true)
    setShowReasons(false)
    try {
      await submitSummaryFeedback(sessionId, sessionToken, { rating: 'down', reason: reasonKey, timestamp: new Date().toISOString() })
    } catch { /* best-effort */ }
  }

  return (
    <div style={feedbackStyles.container}>
      <p style={feedbackStyles.prompt}>Was this summary helpful?</p>
      <div style={feedbackStyles.buttons}>
        <button
          type="button"
          disabled={submitted}
          onClick={handleUp}
          style={rating === 'up' ? feedbackStyles.selected : submitted ? feedbackStyles.buttonDisabled : feedbackStyles.button}
        >👍</button>
        <button
          type="button"
          disabled={submitted}
          onClick={handleDown}
          style={rating === 'down' ? feedbackStyles.selected : submitted ? feedbackStyles.buttonDisabled : feedbackStyles.button}
        >👎</button>
      </div>
      {showReasons && !submitted && (
        <div style={feedbackStyles.reasonPills}>
          <p style={feedbackStyles.reasonPrompt}>What was off?</p>
          {reasons.map(r => (
            <button key={r.key} type="button" onClick={() => handleReason(r.key)} style={feedbackStyles.pill}>{r.label}</button>
          ))}
        </div>
      )}
      {submitted && <p style={feedbackStyles.thanks}>Thanks</p>}
    </div>
  )
}

export default function SessionSummary() {
  const { sessionId: paramSessionId } = useParams<{ sessionId: string }>()
  const { sessionToken, sessionId: ctxSessionId } = useSession()
  const navigate = useNavigate()

  const sessionId = paramSessionId ?? ctxSessionId ?? ''

  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error' | 'not-ready'>('loading')
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.title = 'Session Summary — Pulse'
  }, [])

  useEffect(() => {
    if (!sessionToken) {
      navigate(`/s/${sessionId}`)
    }
  }, [sessionToken, sessionId, navigate])

  useEffect(() => {
    if (!sessionToken || !sessionId) return

    async function load() {
      try {
        const resp = await getSessionSummary(sessionId, sessionToken!)
        setSummary(resp.summary)
        setLoadState('loaded')
      } catch (err) {
        const status = (err as Error & { status?: number }).status
        if (status === 409) {
          // Not ready yet — retry up to 5 times
          if (retryCountRef.current < 5) {
            retryCountRef.current += 1
            setLoadState('not-ready')
            retryTimerRef.current = setTimeout(load, 3000)
          } else {
            setLoadState('error')
          }
        } else if (status === 401) {
          navigate(`/s/${sessionId}`)
        } else {
          setLoadState('error')
        }
      }
    }

    load()

    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionToken])

  const totalSections = summary?.sections.length ?? 1

  return (
    <div className="page-scrollable" style={styles.page}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <span style={styles.wordmark}>pulse</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <a href={`/s/${sessionId}/chat`} style={styles.backLink}>
            ← Back to conversation
          </a>
          <button style={styles.closeButton} onClick={() => { window.close(); if (!window.closed) window.location.href = 'https://pulse.urgdstudios.com' }}>
            Close
          </button>
        </div>
      </div>

      <div style={styles.content}>
        {/* Progress line — fully filled */}
        <div style={styles.pulseLineWrapper}>
          <PulseLine current={totalSections} total={totalSections} />
        </div>

        {loadState === 'loading' || loadState === 'not-ready' ? (
          <div style={styles.loadingState}>
            <span>
              {loadState === 'not-ready'
                ? 'Preparing your summary…'
                : 'Loading…'}
            </span>
          </div>
        ) : loadState === 'error' ? (
          <div style={styles.errorState}>
            <span>Your summary is taking longer than expected. Try refreshing in a moment.</span>
          </div>
        ) : summary ? (
          <>
          <div style={styles.card}>
            <h1 style={styles.cardHeading}>Your Session Summary</h1>

            {summary.sections.length > 0 && (
              <div>
                <p style={styles.sectionSubheading}>Sections covered</p>
                <ul style={styles.sectionList}>
                  {summary.sections.map((section, i) => (
                    <li key={i} style={styles.sectionItem}>
                      <span style={styles.checkmark}>✓</span>
                      <span>{section}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.themes.length > 0 && (
              <div>
                <p style={styles.sectionSubheading}>Key themes</p>
                <ul style={styles.themeList}>
                  {summary.themes.map((theme, i) => (
                    <li key={i} style={styles.themeItem}>
                      <span style={styles.themeDot} />
                      <span>{theme}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <hr style={styles.divider} />

            {summary.closingMessage && (
              <p style={styles.closingMessage}>{summary.closingMessage}</p>
            )}

            {summary.tenantName && (
              <p style={styles.footer}>
                Your responses have been shared with {summary.tenantName}.
              </p>
            )}

            {sessionToken && (
              <>
                <hr style={styles.divider} />
                <EmailOptIn sessionId={sessionId} sessionToken={sessionToken} />
              </>
            )}
          </div>

          {/* Summary feedback */}
          {sessionToken && (
            <SummaryFeedback
              sessionId={sessionId}
              sessionToken={sessionToken}
              existingFeedback={summary.summaryFeedback}
            />
          )}
        </>
        ) : null}
      </div>
      <SessionFooter sessionId={sessionId} sessionToken={sessionToken ?? undefined} />
    </div>
  )
}
