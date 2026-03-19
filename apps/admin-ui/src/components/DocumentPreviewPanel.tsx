import { useCallback, useEffect, useRef, useState } from 'react';
import { labels } from '../config/labels-registry';
import styles from '../pages/ItemDetailModal.module.css';

interface Props {
  url: string;
  contentType: string;
  filename: string;
  originalUrl?: string;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

type LoadState = 'loading' | 'loaded' | 'error';

function getTypeBadge(contentType: string): string {
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
  if (contentType === 'text/markdown') return 'MD';
  if (contentType === 'text/plain') return 'TXT';
  if (contentType.startsWith('image/')) return 'IMG';
  return contentType.split('/')[1]?.toUpperCase() ?? 'FILE';
}

export default function DocumentPreviewPanel({ url, contentType, filename, originalUrl, onClose, triggerRef }: Props) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [textContent, setTextContent] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const isText = contentType === 'text/plain' || contentType === 'text/markdown';
  const isPdf = contentType === 'application/pdf';
  const isDocx = contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const isImage = contentType.startsWith('image/');

  const loadContent = useCallback(async () => {
    setLoadState('loading');
    try {
      if (isText || isDocx) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load');
        const text = await res.text();
        setTextContent(text);
      }
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, [url, isText, isDocx]);

  useEffect(() => {
    if (isPdf || isImage) {
      setLoadState('loaded');
    } else {
      loadContent();
    }
  }, [loadContent, isPdf, isImage, retryCount]);

  // Focus close button on open
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Return focus to trigger on close
  const handleClose = useCallback(() => {
    onClose();
    // Return focus to trigger after close
    setTimeout(() => {
      triggerRef?.current?.focus();
    }, 0);
  }, [onClose, triggerRef]);

  // Escape key scoped to panel focus
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && panel!.contains(document.activeElement)) {
        handleClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  function renderContent() {
    if (loadState === 'loading') {
      return (
        <div className={styles.previewLoading}>
          <span>{labels.itemDetail.previewLoading}</span>
        </div>
      );
    }

    if (loadState === 'error') {
      return (
        <div className={styles.previewError}>
          <span>{labels.itemDetail.previewError}</span>
          <button
            type="button"
            onClick={() => setRetryCount((c) => c + 1)}
          >
            {labels.itemDetail.previewRetry}
          </button>
        </div>
      );
    }

    if (isText) {
      if (!textContent) {
        return (
          <div className={styles.previewEmpty}>
            <span>{labels.itemDetail.previewNoText}</span>
          </div>
        );
      }
      return <div className={styles.previewText}>{textContent}</div>;
    }

    if (isPdf) {
      return (
        <div className={styles.previewContent}>
          <iframe
            src={url}
            className={styles.previewIframe}
            title={filename}
          />
          <div className={styles.previewFooter}>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.previewFooterLink}
            >
              {labels.itemDetail.previewPdfFallback}
            </a>
          </div>
        </div>
      );
    }

    if (isDocx) {
      return (
        <>
          <div className={styles.previewText}>
            {textContent || <span style={{ color: 'var(--color-text-muted)' }}>{labels.itemDetail.previewNoText}</span>}
          </div>
          <div className={styles.previewFooter}>
            <span className={styles.previewFooterCaption}>
              {labels.itemDetail.previewExtractedCaption}
            </span>
            {originalUrl && (
              <a
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.previewFooterLink}
              >
                {labels.itemDetail.previewDownloadOriginal}
              </a>
            )}
          </div>
        </>
      );
    }

    if (isImage) {
      return (
        <div className={styles.previewImageContainer}>
          <img src={url} alt={filename} className={styles.previewImage} />
        </div>
      );
    }

    return (
      <div className={styles.previewEmpty}>
        <span>{labels.itemDetail.previewEmpty}</span>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className={styles.previewPane}
      role="complementary"
      aria-label="Document preview"
    >
      <div className={styles.previewHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', overflow: 'hidden', flex: 1 }}>
          <span className={styles.previewFilename}>{filename}</span>
          <span className={styles.previewTypeBadge}>{getTypeBadge(contentType)}</span>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={handleClose}
          aria-label={labels.itemDetail.previewCloseAriaLabel}
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--color-text-secondary)',
            width: '28px',
            height: '28px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1rem',
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>
      <div className={styles.previewContent}>
        {renderContent()}
      </div>
    </div>
  );
}
