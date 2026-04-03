import { useState } from 'react'
import { emailSessionSummary } from '../api/session'

interface Props {
  sessionId: string
  sessionToken: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type SendState = 'idle' | 'sending' | 'sent' | 'error'

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  label: {
    fontSize: '0.8125rem',
    color: '#888',
    margin: 0,
  },
  row: {
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    background: '#1a1a1a',
    border: '1px solid #3a3a3a',
    borderRadius: '8px',
    color: '#e5e5e5',
    fontSize: '0.875rem',
    padding: '0.5rem 0.75rem',
    fontFamily: 'inherit',
    outline: 'none',
  },
  button: {
    background: '#4a7c59',
    border: 'none',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 600,
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    fontFamily: 'inherit',
  },
  buttonDisabled: {
    background: '#3a3a3a',
    border: 'none',
    borderRadius: '8px',
    color: '#666',
    fontSize: '0.875rem',
    fontWeight: 600,
    padding: '0.5rem 1rem',
    cursor: 'not-allowed',
    whiteSpace: 'nowrap' as const,
    fontFamily: 'inherit',
  },
  status: {
    fontSize: '0.8125rem',
    margin: 0,
    lineHeight: 1.4,
  },
}

export default function EmailOptIn({ sessionId, sessionToken }: Props) {
  const [email, setEmail] = useState('')
  const [sendState, setSendState] = useState<SendState>('idle')

  const isValid = EMAIL_RE.test(email.trim())
  const disabled = !isValid || sendState === 'sending' || sendState === 'sent'

  async function handleSend() {
    if (disabled) return
    setSendState('sending')
    try {
      await emailSessionSummary(sessionId, sessionToken, email.trim())
      setSendState('sent')
    } catch {
      setSendState('error')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !disabled) handleSend()
  }

  return (
    <div style={styles.wrapper}>
      <p style={styles.label}>Want a copy of this summary? Enter your email.</p>

      <div style={styles.row}>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            if (sendState === 'error') setSendState('idle')
          }}
          onKeyDown={handleKeyDown}
          disabled={sendState === 'sent'}
          style={styles.input}
          aria-label="Email address for session summary"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled}
          style={disabled ? styles.buttonDisabled : styles.button}
        >
          {sendState === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>

      {sendState === 'sent' && (
        <p style={{ ...styles.status, color: '#7C9E8A' }}>
          ✓ Summary sent — check your inbox.
        </p>
      )}

      {sendState === 'error' && (
        <p style={{ ...styles.status, color: '#c97070' }}>
          Something went wrong.{' '}
          <button
            type="button"
            onClick={handleSend}
            style={{
              background: 'none',
              border: 'none',
              color: '#7C9E8A',
              cursor: 'pointer',
              padding: 0,
              fontSize: 'inherit',
              fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  )
}
