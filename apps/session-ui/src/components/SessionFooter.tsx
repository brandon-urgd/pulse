// Session footer — "powered quietly by ur/gd" + report links
// Visible on validate, confidentiality, and summary screens. Hidden during active chat.

import { useState } from 'react'
import ReportSheet from './ReportSheet'

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
  color: '#555',
  flexWrap: 'wrap' as const,
  textAlign: 'center' as const,
}

const linkStyle: React.CSSProperties = {
  color: '#555',
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
        <span>
          Quietly Powerful, by{' '}
          <a
            href="https://urgdstudios.com/"
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...linkStyle, textDecoration: 'underline' }}
          >
            ur/gd Studios
          </a>
        </span>
      </footer>

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
