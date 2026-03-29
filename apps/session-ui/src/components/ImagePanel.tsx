interface Props {
  imageUrl: string
  alt?: string
  onImageError?: () => void
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: '100%',
    height: '100%',
    background: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: '1rem',
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
export default function ImagePanel({ imageUrl, alt = 'Session image', onImageError }: Props) {
  return (
    <div style={styles.panel}>
      <img
        src={imageUrl}
        alt={alt}
        style={styles.image}
        draggable={false}
        onError={onImageError}
      />
    </div>
  )
}
