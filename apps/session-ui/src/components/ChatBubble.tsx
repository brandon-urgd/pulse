import type { ReactNode } from 'react'

type BubbleType = 'agent' | 'reviewer' | 'content' | 'error'

interface Props {
  type: BubbleType
  children: ReactNode
}

const styles: Record<string, React.CSSProperties> = {
  log: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  agentRow: {
    display: 'flex',
    justifyContent: 'flex-start',
  },
  reviewerRow: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  contentRow: {
    display: 'flex',
    justifyContent: 'flex-start',
  },
  errorRow: {
    display: 'flex',
    justifyContent: 'center',
  },
  agent: {
    background: '#1a1a1a',
    color: '#e5e5e5',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
    borderRadius: '16px 16px 16px 4px',
    maxWidth: '75%',
    minWidth: '80px',
    padding: '0.75rem 1rem',
  },
  reviewer: {
    background: '#4a7c59',
    color: '#ffffff',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
    borderRadius: '16px 16px 4px 16px',
    maxWidth: '78%',
    minWidth: '80px',
    padding: '0.75rem 1rem',
  },
  content: {
    background: 'rgba(74,124,89,0.12)',
    borderLeft: '3px solid #4a7c59',
    borderRadius: '12px',
    maxWidth: '80%',
    padding: '1rem 1.25rem',
    color: '#e5e5e5',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
  },
  error: {
    background: '#2a1a1a',
    border: '1px solid #5a2a2a',
    borderRadius: '12px',
    padding: '0.75rem 1rem',
    color: '#f87171',
    fontSize: '0.875rem',
    maxWidth: '92%',
  },
}

export default function ChatBubble({ type, children }: Props) {
  if (type === 'error') {
    return (
      <div style={styles.errorRow}>
        <div style={styles.error} role="alert" aria-live="assertive">
          {children}
        </div>
      </div>
    )
  }

  const rowStyle = type === 'reviewer' ? styles.reviewerRow : styles.contentRow
  const bubbleStyle = styles[type]

  return (
    <div style={rowStyle}>
      <div style={bubbleStyle}>{children}</div>
    </div>
  )
}
