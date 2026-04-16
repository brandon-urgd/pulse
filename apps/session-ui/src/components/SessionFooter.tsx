// Session footer — "powered quietly by ur/gd" + report links + about
// Visible on validate, confidentiality, and summary screens. Hidden during active chat.

import { useState, useEffect } from 'react'
import ReportSheet from './ReportSheet'
import { APP_VERSION, ABOUT_CONTENT } from '@pulse/shared'

interface Props {
  sessionId?: string
  sessionToken?: string
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  padding: '1rem',
  fontSize: '0.75rem',
  color: 'var(--color-text-muted)',
  flexWrap: 'wrap' as const,
  textAlign: 'center' as const,
}

const linkStyle: React.CSSProperties = {
  color: 'var(--color-text-muted)',
  textDecoration: 'none',
  background: 'none',
  border: 'none',
  fontSize: '0.75rem',
  cursor: 'pointer',
  padding: 0,
  fontFamily: 'inherit',
}

export default function SessionFooter({ sessionId, sessionToken }: Props) {
  const [reportType, setReportType] = useState<'report-abuse' | 'bug-report' | null>(null)
  const [showAbout, setShowAbout] = useState(false)

  const canReport = Boolean(sessionId && sessionToken)

  return (
    <>
      <footer style={footerStyle}>
        {canReport && (
          <>
            <button
              type="button"
              style={linkStyle}
              onClick={() => setReportType('report-abuse')}
            >
              Report abuse
            </button>
            <button
              type="button"
              style={linkStyle}
              onClick={() => setReportType('bug-report')}
            >
              Report a problem
            </button>
          </>
        )}
        <button
          type="button"
          style={linkStyle}
          onClick={() => setShowAbout(true)}
        >
          About Pulse
        </button>
        <span>
          {ABOUT_CONTENT.attribution}{' '}
          <a
            href={ABOUT_CONTENT.attributionUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...linkStyle, textDecoration: 'underline' }}
          >
            {ABOUT_CONTENT.attributionStudio}
          </a>
        </span>
      </footer>

      {showAbout && (
        <SessionAboutModal onClose={() => setShowAbout(false)} />
      )}

      {reportType && sessionId && sessionToken && (
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


// ── Inline About modal for Session UI ────────────────────────────────────────

const aboutOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  zIndex: 400,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '1rem',
}

const aboutCardStyle: React.CSSProperties = {
  background: 'var(--color-surface, #1a1a2e)',
  borderRadius: '16px',
  padding: '2rem 1.75rem',
  maxWidth: '400px',
  width: '100%',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.4)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.75rem',
  textAlign: 'center' as const,
}

const aboutWordmarkStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 300,
  letterSpacing: '0.12em',
  color: 'var(--color-accent, #7a9e87)',
  margin: 0,
}

const aboutVersionStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--color-text-muted, #6c757d)',
  margin: 0,
}

const aboutDescStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  color: 'var(--color-text-secondary, #adb5bd)',
  lineHeight: 1.6,
  margin: 0,
  maxWidth: '320px',
}

const aboutAttrStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--color-text-muted, #6c757d)',
  margin: 0,
}

const aboutLegalStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  alignItems: 'center',
}

const aboutLegalLinkStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--color-accent, #7a9e87)',
  textDecoration: 'none',
}

const aboutCloseStyle: React.CSSProperties = {
  padding: '0.5rem 1.25rem',
  borderRadius: '8px',
  background: 'transparent',
  color: 'var(--color-text-primary, #e9ecef)',
  border: '1px solid var(--color-border, #495057)',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
  marginTop: '0.5rem',
}

function SessionAboutModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      style={aboutOverlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="session-about-title"
    >
      <div style={aboutCardStyle}>
        <p style={aboutWordmarkStyle} id="session-about-title">{ABOUT_CONTENT.wordmark}</p>
        <p style={aboutVersionStyle}>Version {APP_VERSION}</p>
        <p style={aboutDescStyle}>{ABOUT_CONTENT.descriptionP1}</p>
        <p style={aboutDescStyle}>{ABOUT_CONTENT.descriptionP2}</p>
        <p style={aboutAttrStyle}>
          {ABOUT_CONTENT.attribution}{' '}
          <a
            href={ABOUT_CONTENT.attributionUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...aboutLegalLinkStyle, textDecoration: 'underline' }}
          >
            {ABOUT_CONTENT.attributionStudio}
          </a>
          {' | '}{ABOUT_CONTENT.attributionLocation}
        </p>
        <div style={aboutLegalStyle}>
          <a
            href={ABOUT_CONTENT.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={aboutLegalLinkStyle}
          >
            {ABOUT_CONTENT.privacyLabel}
          </a>
          <span style={{ color: 'var(--color-text-muted, #6c757d)', fontSize: '0.75rem' }} aria-hidden="true">·</span>
          <a
            href={ABOUT_CONTENT.termsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={aboutLegalLinkStyle}
          >
            {ABOUT_CONTENT.termsLabel}
          </a>
        </div>
        <button
          type="button"
          style={aboutCloseStyle}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  )
}
