import { useState } from 'react'

interface Props {
  imageUrl: string
  alt?: string
  onImageError?: () => void
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
    overflow: 'hidden',
  },
  trigger: {
    width: '100%',
    padding: '0.625rem 1rem',
    background: '#141414',
    border: 'none',
    color: '#ccc',
    fontSize: '0.875rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    fontFamily: 'inherit',
  },
  imageWrapper: {
    overflow: 'hidden',
    transition: 'max-height 0.3s ease, opacity 0.3s ease',
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageWrapperExpanded: {
    maxHeight: '40vh',
    opacity: 1,
  },
  imageWrapperCollapsed: {
    maxHeight: '0',
    opacity: 0,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '40vh',
    objectFit: 'contain' as const,
    touchAction: 'pinch-zoom',
  },
}

/**
 * Mobile collapsible panel above chat for image sessions.
 * Tap to expand/collapse with slide animation.
 */
export default function ExpandableImageHeader({ imageUrl, alt = 'Session image', onImageError }: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={styles.container}>
      <button
        type="button"
        style={styles.trigger}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse photo' : 'View photo'}
      >
        <span>📷 View Photo {expanded ? '▲' : '▼'}</span>
      </button>
      <div
        style={{
          ...styles.imageWrapper,
          ...(expanded ? styles.imageWrapperExpanded : styles.imageWrapperCollapsed),
        }}
      >
        {expanded && (
          <img
            src={imageUrl}
            alt={alt}
            style={styles.image}
            draggable={false}
            onError={onImageError}
          />
        )}
      </div>
    </div>
  )
}
