import { useEffect, useRef, useState } from 'react'
import ReportSheet from './ReportSheet'

interface Props {
  tenantName: string
  sessionId: string
  sessionToken: string
  onSubmit: () => void
  onDiscard: () => void
  onKeepGoing: () => void
}

type SheetState = 'initial' | 'discard-confirm' | 'report'

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 500,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  backdropDesktop: {
    alignItems: 'center',
  },
  sheet: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '12px 12px 0 0',
    padding: '1.5rem 1.25rem',
    width: '100%',
    maxWidth: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  sheetDesktop: {
    borderRadius: '12px',
    maxWidth: '480px',
    width: '100%',
  },
  heading: {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--color-text-white)',
    margin: '0 0 0.75rem',
  },
  body: {
    fontSize: '0.875rem',
    color: 'var(--color-text-secondary)',
    margin: '0 0 1.25rem',
    lineHeight: 1.6,
  },
  bodyDestructive: {
    fontSize: '0.875rem',
    color: 'var(--color-error)',
    margin: '0 0 1.25rem',
    lineHeight: 1.6,
  },
  primaryButton: {
    width: '100%',
    background: 'var(--color-accent-deep)',
    color: 'var(--color-text-white)',
    border: 'none',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  destructiveButton: {
    width: '100%',
    background: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    border: '1px solid var(--color-error-border)',
    borderRadius: '6px',
    padding: '0.75rem',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  keepGoingButton: {
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: 'var(--color-accent)',
    fontSize: '0.9375rem',
    cursor: 'pointer',
    marginTop: '0.75rem',
    padding: '0.5rem',
  },
  discardLink: {
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-muted)',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    marginTop: '1rem',
    textAlign: 'center' as const,
    display: 'block',
    width: '100%',
    padding: '0.25rem',
  },
  cancelLink: {
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-muted)',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    marginTop: '0.75rem',
    textAlign: 'center' as const,
    display: 'block',
    width: '100%',
    padding: '0.25rem',
  },
  reportLinksRow: {
    display: 'flex',
    justifyContent: 'center',
    gap: '1.25rem',
    marginTop: '1rem',
    paddingTop: '0.75rem',
    borderTop: '1px solid var(--color-border)',
  },
  reportLink: {
    background: 'transparent',
    border: 'none',
    color: 'var(--color-text-muted)',
    fontSize: '0.75rem',
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
}

export default function ExitSheet({ tenantName, sessionId, sessionToken, onSubmit, onDiscard, onKeepGoing }: Props) {
  const [sheetState, setSheetState] = useState<SheetState>('initial')
  const [reportType, setReportType] = useState<'report-abuse' | 'bug-report' | null>(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const firstFocusRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Focus first button on mount
  useEffect(() => {
    firstFocusRef.current?.focus()
  }, [sheetState])

  // Trap focus within sheet
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return

    const focusable = sheet.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }
      if (e.key === 'Escape') {
        onKeepGoing()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [sheetState, onKeepGoing])

  const backdropStyle: React.CSSProperties = {
    ...styles.backdrop,
    ...(isDesktop ? styles.backdropDesktop : {}),
  }

  const sheetStyle: React.CSSProperties = {
    ...styles.sheet,
    ...(isDesktop ? styles.sheetDesktop : {}),
  }

  return (
    <>
      <div
        style={backdropStyle}
        onClick={onKeepGoing}
      >
        <div
          ref={sheetRef}
          style={sheetStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby="exit-sheet-heading"
          onClick={(e) => e.stopPropagation()}
        >
          {sheetState === 'initial' ? (
            <>
              <h2 id="exit-sheet-heading" style={styles.heading}>
                Submit your feedback?
              </h2>
              <p style={styles.body}>
                Your responses so far will be shared with {tenantName}. You won't be able to continue
                this session.
              </p>
              <button
                ref={firstFocusRef}
                type="button"
                style={styles.primaryButton}
                onClick={onSubmit}
              >
                Submit feedback
              </button>
              <button type="button" style={styles.keepGoingButton} onClick={onKeepGoing}>
                Keep going
              </button>
              <button
                type="button"
                style={styles.discardLink}
                onClick={() => setSheetState('discard-confirm')}
              >
                Discard and exit
              </button>
              <div style={styles.reportLinksRow}>
                <button
                  type="button"
                  style={styles.reportLink}
                  onClick={() => setReportType('report-abuse')}
                >
                  Report abuse
                </button>
                <button
                  type="button"
                  style={styles.reportLink}
                  onClick={() => setReportType('bug-report')}
                >
                  Report a problem
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 id="exit-sheet-heading" style={styles.heading}>
                End your session?
              </h2>
              <p style={styles.bodyDestructive}>
                This will permanently delete your responses. This can't be undone.
              </p>
              <button
                ref={firstFocusRef}
                type="button"
                style={styles.destructiveButton}
                onClick={onDiscard}
              >
                Yes, discard
              </button>
              <button
                type="button"
                style={styles.cancelLink}
                onClick={() => setSheetState('initial')}
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
      {reportType && (
        <ReportSheet
          type={reportType}
          sessionId={sessionId}
          sessionToken={sessionToken}
          onClose={() => setReportType(null)}
        />
      )}
    </>
  )
}
