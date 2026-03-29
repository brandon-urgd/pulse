interface Props {
  imageUrl: string
  alt?: string
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '40%',
    minWidth: '280px',
    height: '100%',
    background: '#0a0a0a',
    borderRight: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain' as const,
    touchAction: 'pinch-zoom',
  },
}

/**
 * Desktop split-pane image viewer (40% width, left side).
 * Loads image via presigned URL from getSessionState.
 */
export default function ImagePanel({ imageUrl, alt = 'Session image' }: Props) {
  return (
    <div style={styles.panel}>
      <img
        src={imageUrl}
        alt={alt}
        style={styles.image}
        draggable={false}
      />
    </div>
  )
}
