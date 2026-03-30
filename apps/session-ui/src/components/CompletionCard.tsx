import { useNavigate } from 'react-router-dom'

interface Props {
  sessionId: string
  /** Key observation from the agent's closing message */
  observation?: string
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'rgba(74,124,89,0.12)',
    borderLeft: '3px solid #4a7c59',
    borderRadius: '12px',
    padding: '1rem 1.25rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  heading: {
    fontSize: '1rem',
    fontWeight: 600,
    color: '#ffffff',
    margin: 0,
  },
  body: {
    fontSize: '0.875rem',
    color: '#ccc',
    margin: 0,
    lineHeight: 1.6,
  },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },
  link: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  closeButton: {
    background: 'transparent',
    border: '1px solid #3a3a3a',
    color: '#888',
    fontSize: '0.875rem',
    borderRadius: '8px',
    padding: '0.25rem 0.75rem',
    cursor: 'pointer',
  },
}

/**
 * Shown when session completes. Displays key observation from agent's
 * closing message and optional email CTA.
 * Uses direct strings (no labels registry) per session-ui convention.
 */
export default function CompletionCard({ sessionId, observation }: Props) {
  const navigate = useNavigate()
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>Thanks — your feedback has been captured.</h2>
      {observation && (
        <p style={styles.body}>{observation}</p>
      )}
      <p style={styles.body}>
        Your responses have been shared with the team.
      </p>
      <div style={styles.actions}>
        <a href={`/s/${sessionId}/summary`} style={styles.link}>
          View session summary →
        </a>
        <button
          type="button"
          onClick={() => navigate(`/s/${sessionId}/summary`)}
          style={styles.closeButton}
        >
          Close
        </button>
      </div>
    </div>
  )
}
