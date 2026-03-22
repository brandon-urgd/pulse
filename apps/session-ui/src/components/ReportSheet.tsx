// ReportSheet — bottom sheet for abuse/bug reports from session-ui
// Slides up from bottom on mobile, centered card on desktop
// Inline styles only (session-ui convention)

import { useEffect, useRef, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

type ReportType = 'report-abuse' | 'bug-report'

interface Props {
  type: ReportType
  sessionId: string
  sessionToken: string
  onClose: () => void
}

const TITLES: Record<ReportType, string> = {
  'report-abuse': 'Report abuse',
  'bug-report': 'Report a problem',
}

const PLACEHOLDERS: Record<ReportType, string> = {
  'report-abuse': 'Describe what happened. Include as much detail as you can.',
  'bug-report': 'Describe the issue. What were you doing when it happened?',
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
}

const overlayDesktop: React.CSSProperties = {
  alignItems: 'center',
}

const sheet: React.CSSProperties = {
  background: '#1a1a1a',
  borderRadius: '16px 16px 0 0',
  padding: '1.5rem',
  width: '100%',
  maxWidth: '480px',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: '#e5e5e5',
}

const sheetDesktop: React.CSSProperties = {
  borderRadius: '12px',
  maxWidth: '420px',
}

const titleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const titleStyle: React.CSSProperties = {
  fontSize: '1rem',
  fontWeight: 600,
  color: '#ffffff',
  margin: 0,
}

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: '1.25rem',
  cursor: 'pointer',
  padding: '0.25rem',
  lineHeight: 1,
}

const textarea: React.CSSProperties = {
  width: '100%',
  minHeight: '80px',
  background: '#111',
  border: '1px solid #333',
  borderRadius: '8px',
  color: '#e5e5e5',
  fontSize: '0.9375rem',
  padding: '0.75rem',
  resize: 'vertical' as const,
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box' as const,
}

const submitBtn: React.CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  background: '#4a7c59',
  color: '#fff',
  border: 'none',
  borderRadius: '8px',
  fontSize: '1rem',
  fontWeight: 600,
  cursor: 'pointer',
}

const submitBtnDisabled: React.CSSProperties = {
  opacity: 0.6,
  cursor: 'not-allowed',
}

const errorStyle: React.CSSProperties = {
  background: '#2a1a1a',
  border: '1px solid #5a2a2a',
  borderRadius: '6px',
  padding: '0.75rem',
  color: '#f87171',
  fontSize: '0.875rem',
}

const successStyle: React.CSSProperties = {
  textAlign: 'center' as const,
  color: '#7C9E8A',
  fontSize: '0.9375rem',
  padding: '1rem 0',
}

export default function ReportSheet({ type, sessionId, sessionToken, onClose }: Props) {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const firstFocusRef = useRef<HTMLTextAreaElement>(null)
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 640
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Focus textarea on open
  useEffect(() => {
    firstFocusRef.current?.focus()
  }, [])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Auto-close after success
  useEffect(() => {
    if (!success) return
    const timer = setTimeout(onClose, 2000)
    return () => clearTimeout(timer)
  }, [success, onClose])

  const handleSubmit = async () => {
    if (!message.trim()) return
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`${API_BASE}/api/session/${sessionId}/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          type,
          message: message.trim(),
          metadata: {
            userAgent: navigator.userAgent,
            url: window.location.href,
          },
        }),
      })

      if (!res.ok) {
        throw new Error('Failed')
      }

      setSuccess(true)
    } catch {
      setError("Couldn't send your report. Try again.")
    } finally {
      setLoading(false)
    }
  }

  const overlayStyle = isDesktop ? { ...overlay, ...overlayDesktop } : overlay
  const sheetStyle = isDesktop ? { ...sheet, ...sheetDesktop } : sheet

  // Slide-up animation (respects prefers-reduced-motion)
  const animationStyle: React.CSSProperties = prefersReducedMotion
    ? {}
    : {
        animation: 'slideUp 0.25s ease',
      }

  return (
    <>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
      {/* Backdrop */}
      <div
        style={overlayStyle}
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
        aria-hidden="true"
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[type]}
        style={{
          ...overlayStyle,
          background: 'transparent',
          pointerEvents: 'none',
        }}
      >
        <div style={{ ...sheetStyle, ...animationStyle, pointerEvents: 'auto' }}>
          {success ? (
            <p style={successStyle}>Thanks, we got it.</p>
          ) : (
            <>
              <div style={titleRow}>
                <h2 style={titleStyle}>{TITLES[type]}</h2>
                <button
                  type="button"
                  style={closeBtn}
                  onClick={onClose}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <textarea
                ref={firstFocusRef}
                style={textarea}
                aria-label="Describe the issue"
                placeholder={PLACEHOLDERS[type]}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={loading}
                rows={4}
              />

              {error && (
                <div role="alert" aria-live="assertive" style={errorStyle}>
                  {error}
                </div>
              )}

              <button
                type="button"
                style={{ ...submitBtn, ...(loading || !message.trim() ? submitBtnDisabled : {}) }}
                onClick={handleSubmit}
                disabled={loading || !message.trim()}
              >
                {loading ? 'Submitting…' : 'Submit'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  )
}
