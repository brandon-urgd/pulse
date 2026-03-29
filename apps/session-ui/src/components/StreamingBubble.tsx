import { useEffect, useRef } from 'react'

interface Props {
  /** Accumulated text so far (grows as tokens arrive) */
  text: string
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '0.5rem',
    minWidth: 0,
    maxWidth: '100%',
  },
  bubble: {
    background: '#1a1a1a',
    color: '#e5e5e5',
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
}

/**
 * A single growing chat bubble rendered during active streaming.
 * Auto-scrolls to keep the latest tokens visible.
 * On stream complete, the parent replaces this with the proper multi-bubble layout.
 */
export default function StreamingBubble({ text }: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Auto-scroll: find the nearest scrollable ancestor and scroll to bottom
    const el = bubbleRef.current
    if (!el) return
    const scrollParent = el.closest('.chat-scroll-area') as HTMLElement | null
    if (scrollParent) {
      scrollParent.scrollTop = scrollParent.scrollHeight
    }
  }, [text])

  if (!text) return null

  return (
    <div style={styles.wrapper}>
      <div ref={bubbleRef} style={styles.bubble}>
        {text}
      </div>
    </div>
  )
}
