import { useCallback, useEffect, useRef, useState } from 'react'
import ThinkingIndicator from './ThinkingIndicator'

interface Props {
  url: string
  contentType: string
  filename: string
  originalUrl?: string
  onClose: () => void
}

type LoadState = 'loading' | 'loaded' | 'error'

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    zIndex: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
  },
  modal: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    width: '100vw',
    height: '100dvh',
  },
  header: {
    height: '48px',
    background: '#1a1a1a',
    borderBottom: '1px solid #2a2a2a',
    padding: '0 1rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    gap: '0.75rem',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    overflow: 'hidden',
    flex: 1,
  },
  filename: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#e5e5e5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  typeBadge: {
    fontSize: '0.6875rem',
    textTransform: 'uppercase' as const,
    color: '#888',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '4px',
    padding: '0.125rem 0.375rem',
    flexShrink: 0,
  },
  closeButton: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '1px solid #2a2a2a',
    background: 'transparent',
    color: '#888',
    fontSize: '1.25rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  textContent: {
    whiteSpace: 'pre-wrap' as const,
    overflowY: 'auto' as const,
    fontSize: '0.9375rem',
    lineHeight: 1.7,
    color: '#e5e5e5',
    padding: '1.5rem',
    flex: 1,
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 'none',
    flex: 1,
  },
  iframeWrapper: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  pdfFallback: {
    padding: '1rem 1.5rem',
    borderTop: '1px solid #2a2a2a',
    flexShrink: 0,
  },
  pdfFallbackLink: {
    color: '#7C9E8A',
    fontSize: '0.875rem',
    textDecoration: 'none',
  },
  docxFooter: {
    padding: '0.75rem 1.5rem',
    borderTop: '1px solid #2a2a2a',
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    flexShrink: 0,
  },
  docxCaption: {
    fontSize: '0.8125rem',
    color: '#888',
  },
  docxLink: {
    fontSize: '0.8125rem',
    color: '#7C9E8A',
    textDecoration: 'none',
  },
  imageContainer: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f0f0f',
    overflow: 'hidden',
  },
  image: {
    objectFit: 'contain' as const,
    maxWidth: '100%',
    maxHeight: '100%',
    touchAction: 'pinch-zoom' as const,
  },
  loadingState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
  },
  loadingCaption: {
    fontSize: '0.875rem',
    color: '#888',
  },
  errorState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    color: '#888',
    fontSize: '0.875rem',
  },
  retryButton: {
    background: 'transparent',
    border: '1px solid #2a2a2a',
    borderRadius: '6px',
    color: '#7C9E8A',
    fontSize: '0.875rem',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
  },
}

function getTypeBadge(contentType: string): string {
  if (contentType.startsWith('image/')) return 'Image'
  if (contentType === 'application/pdf') return 'PDF'
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX'
  if (contentType === 'text/markdown') return 'MD'
  if (contentType === 'text/plain') return 'TXT'
  return contentType.split('/')[1]?.toUpperCase() ?? 'FILE'
}

export default function FileViewerModal({ url, contentType, filename, originalUrl, onClose }: Props) {
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [textContent, setTextContent] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  const isText = contentType === 'text/plain' || contentType === 'text/markdown'
  const isPdf = contentType === 'application/pdf'
  const isDocx = contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp'])
  const isImage = contentType.startsWith('image/') || IMAGE_EXTS.has(filename.split('.').pop()?.toLowerCase() ?? '')

  const loadContent = useCallback(async () => {
    setLoadState('loading')
    try {
      if (isText || isDocx) {
        const res = await fetch(url)
        if (!res.ok) throw new Error('Failed to load')
        const text = await res.text()
        setTextContent(text)
      }
      setLoadState('loaded')
    } catch {
      setLoadState('error')
    }
  }, [url, isText, isDocx])

  useEffect(() => {
    if (isPdf || isImage) {
      setLoadState('loaded')
    } else {
      loadContent()
    }
  }, [loadContent, isPdf, isImage, retryCount])

  // Focus close button on open
  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  // Trap focus + Escape
  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'Tab') {
        const focusable = modal!.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
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
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Desktop: max-width 800px centered
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)')
    setIsDesktop(mq.matches)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const modalStyle: React.CSSProperties = {
    ...styles.modal,
    ...(isDesktop
      ? {
          width: '100%',
          maxWidth: '800px',
          height: '90vh',
          maxHeight: '90vh',
        }
      : {}),
  }

  function renderContent() {
    if (loadState === 'loading') {
      return (
        <div style={styles.loadingState}>
          <ThinkingIndicator />
          <span style={styles.loadingCaption}>Loading file…</span>
        </div>
      )
    }

    if (loadState === 'error') {
      return (
        <div style={styles.errorState}>
          <span>This file couldn't be loaded.</span>
          <button
            type="button"
            style={styles.retryButton}
            onClick={() => setRetryCount((c) => c + 1)}
          >
            Try again
          </button>
        </div>
      )
    }

    if (isText) {
      return <div style={styles.textContent}>{textContent}</div>
    }

    if (isPdf) {
      return (
        <div style={styles.iframeWrapper}>
          <iframe src={url} style={styles.iframe} title={filename} />
          <div style={styles.pdfFallback}>
            <a href={url} target="_blank" rel="noopener noreferrer" style={styles.pdfFallbackLink}>
              Open PDF in new tab →
            </a>
          </div>
        </div>
      )
    }

    if (isDocx) {
      return (
        <>
          <div style={styles.textContent}>{textContent}</div>
          <div style={styles.docxFooter}>
            <span style={styles.docxCaption}>Showing extracted text.</span>
            {originalUrl && (
              <a
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.docxLink}
              >
                Download original
              </a>
            )}
          </div>
        </>
      )
    }

    if (isImage) {
      return (
        <div style={styles.imageContainer}>
          <img src={url} alt={filename} style={styles.image} />
        </div>
      )
    }

    return (
      <div style={styles.errorState}>
        <span>Preview not available for this file type.</span>
      </div>
    )
  }

  return (
    <div
      style={styles.backdrop}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-viewer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span id="file-viewer-title" style={styles.filename}>
              {filename}
            </span>
            <span style={styles.typeBadge}>{getTypeBadge(contentType)}</span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            style={styles.closeButton}
            onClick={onClose}
            aria-label="Close file viewer"
          >
            ×
          </button>
        </div>
        <div style={styles.content}>{renderContent()}</div>
      </div>
    </div>
  )
}
