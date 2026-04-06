import { useState } from 'react'
import { getFileViewerUrl } from '../api/session'
import FileViewerModal from './FileViewerModal'

interface FileItem {
  fileId: string
  filename: string
  contentType: string
}

interface Props {
  files: FileItem[]
  sessionId: string
  sessionToken: string
}

interface ViewerData {
  url: string
  contentType: string
  filename: string
  originalUrl?: string
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--color-bg)',
    borderBottom: '1px solid var(--color-border)',
    padding: '0.5rem 1rem',
    display: 'flex',
    gap: '0.5rem',
    alignItems: 'center',
    overflowX: 'auto' as const,
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  pill: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '16px',
    padding: '0.375rem 0.75rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 0.15s, border-color 0.15s',
  },
  pillLoading: {
    background: 'var(--color-surface-raised)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '16px',
    padding: '0.375rem 0.75rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    cursor: 'wait',
    flexShrink: 0,
    opacity: 0.7,
  },
  pillFilename: {
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '0.8125rem',
    color: 'var(--color-text-secondary)',
  },
  pillBadge: {
    fontSize: '0.6875rem',
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-muted)',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '4px',
    padding: '0.125rem 0.375rem',
  },
}

function getTypeBadge(contentType: string): string {
  if (contentType === 'application/pdf') return 'PDF'
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX'
  if (contentType === 'text/markdown') return 'MD'
  if (contentType === 'text/plain') return 'TXT'
  if (contentType.startsWith('image/')) return 'IMG'
  return contentType.split('/')[1]?.toUpperCase() ?? 'FILE'
}

export default function FileAttachmentBar({ files, sessionId, sessionToken }: Props) {
  const [loadingFileId, setLoadingFileId] = useState<string | null>(null)
  const [viewerData, setViewerData] = useState<ViewerData | null>(null)

  if (!files.length) return null

  async function handlePillClick(file: FileItem) {
    if (loadingFileId) return
    setLoadingFileId(file.fileId)
    try {
      const data = await getFileViewerUrl(sessionId, sessionToken, file.fileId)
      setViewerData({
        url: data.url,
        contentType: data.contentType,
        filename: data.filename,
        originalUrl: data.originalUrl,
      })
    } catch {
      // silently fail — user can retry
    } finally {
      setLoadingFileId(null)
    }
  }

  function handlePillKeyDown(e: React.KeyboardEvent, file: FileItem) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handlePillClick(file)
    }
  }

  return (
    <>
      <div style={styles.container}>
        <span style={styles.label}>Files</span>
        {files.map((file) => {
          const isLoading = loadingFileId === file.fileId
          return (
            <div
              key={file.fileId}
              style={isLoading ? styles.pillLoading : styles.pill}
              role="button"
              tabIndex={0}
              aria-label={`View file: ${file.filename}`}
              onClick={() => handlePillClick(file)}
              onKeyDown={(e) => handlePillKeyDown(e, file)}
            >
              <span style={styles.pillFilename}>{file.filename}</span>
              <span style={styles.pillBadge}>{getTypeBadge(file.contentType)}</span>
            </div>
          )
        })}
      </div>

      {viewerData && (
        <FileViewerModal
          url={viewerData.url}
          contentType={viewerData.contentType}
          filename={viewerData.filename}
          originalUrl={viewerData.originalUrl}
          onClose={() => setViewerData(null)}
        />
      )}
    </>
  )
}
