import type { ReactNode } from 'react'

type BubbleType = 'agent' | 'reviewer' | 'content' | 'error'

interface Props {
  type: BubbleType
  children: ReactNode
}

const styles: Record<string, React.CSSProperties> = {
  errorRow: {
    display: 'flex',
    justifyContent: 'center',
  },
  agent: {
    background: 'var(--color-surface)',
    color: 'var(--color-text-primary)',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
    borderRadius: '16px 16px 16px 4px',
    maxWidth: '70%',
    minWidth: '80px',
    padding: '0.75rem 1rem',
    width: 'fit-content',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    overflow: 'hidden' as const,
    boxSizing: 'border-box' as const,
  },
  reviewer: {
    background: 'var(--color-accent-deep)',
    color: 'var(--color-text-white)',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
    borderRadius: '16px 16px 4px 16px',
    maxWidth: '85%',
    padding: '0.625rem 0.875rem',
    width: 'fit-content',
    wordBreak: 'break-word' as const,
    overflow: 'hidden' as const,
  },
  content: {
    background: 'var(--color-accent-subtle)',
    borderLeft: '3px solid var(--color-accent-deep)',
    borderRadius: '12px',
    maxWidth: '80%',
    padding: '1rem 1.25rem',
    color: 'var(--color-text-primary)',
    fontSize: '0.9375rem',
    lineHeight: 1.65,
  },
  error: {
    background: 'var(--color-error-bg)',
    border: '1px solid var(--color-error-border)',
    borderRadius: '12px',
    padding: '0.75rem 1rem',
    color: 'var(--color-error)',
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

  return <div style={styles[type]}>{children}</div>
}
