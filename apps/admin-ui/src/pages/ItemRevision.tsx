import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import ReactMarkdown from 'react-markdown';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import { downloadRevisionPdf } from '../utils/downloadPdf';
import PulseCheckOverlay from '../components/PulseCheckOverlay';
import styles from './ItemRevision.module.css';

// ─── Revision overlay phases ──────────────────────────────────────────────────

const REVISION_PHASES = [
  { message: labels.revision.overlayPhase1, targetPct: 15,  durationMs: 3000 },
  { message: labels.revision.overlayPhase2, targetPct: 30,  durationMs: 5000 },
  { message: labels.revision.overlayPhase3, targetPct: 55,  durationMs: 8000 },
  { message: labels.revision.overlayPhase4, targetPct: 72,  durationMs: 8000 },
  { message: labels.revision.overlayPhase5, targetPct: 85,  durationMs: 8000 },
  { message: labels.revision.overlayPhase6, targetPct: 93,  durationMs: 99999 },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Revision {
  revisionId: string;
  revisionNumber: number;
  createdAt: string;
  completedAt?: string;
  status: 'generating' | 'complete' | 'failed';
  decisionsApplied?: number;
  documentUrl?: string;
  originalUrl?: string;
}

interface RevisionsResponse {
  data: { revisions: Revision[] };
}

interface ItemResponse {
  data: { itemId: string; itemName: string; status: string; itemType?: 'document' | 'image' };
}

// ─── Revision pane content ────────────────────────────────────────────────────

function RevisionPane({ label, content, accentBorder }: { label: string; content: string; accentBorder?: boolean }) {
  return (
    <div className={styles.pane}>
      <p className={styles.paneLabel}>{label}</p>
      <div className={`${styles.paneContent} ${accentBorder ? styles.paneContentAccent : ''}`}>
        <div className={styles.paneMarkdown}>
          <ReactMarkdown
            components={{
              img: ({ alt }) => <span>{alt}</span>,
            }}
          >
            {content || ''}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// ─── Mobile tabs ──────────────────────────────────────────────────────────────

function MobileTabs({ activeTab, onSelect, revisionNumber }: { activeTab: 'original' | 'revision'; onSelect: (t: 'original' | 'revision') => void; revisionNumber: number }) {
  return (
    <div className={styles.mobileTabs} role="tablist">
      <button
        role="tab"
        aria-selected={activeTab === 'original'}
        aria-controls="pane-original"
        className={`${styles.mobileTab} ${activeTab === 'original' ? styles.mobileTabActive : ''}`}
        onClick={() => onSelect('original')}
      >
        {labels.revision.originalPaneLabel}
      </button>
      <button
        role="tab"
        aria-selected={activeTab === 'revision'}
        aria-controls="pane-revision"
        className={`${styles.mobileTab} ${activeTab === 'revision' ? styles.mobileTabActive : ''}`}
        onClick={() => onSelect('revision')}
      >
        {labels.revision.revisionPaneLabel.replace('{number}', String(revisionNumber))}
      </button>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ItemRevision() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayDone, setOverlayDone] = useState(false);
  const [overlayError, setOverlayError] = useState('');
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [revisionContent, setRevisionContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState<'original' | 'revision'>('revision');
  const [showHistory, setShowHistory] = useState(false);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCountRef = useRef(0);

  const { data: itemResp } = useAuthedQuery<ItemResponse>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: Boolean(itemId) }
  );
  const itemName = itemResp?.data?.itemName ?? '';
  const isImageItem = itemResp?.data?.itemType === 'image';

  // Image items don't support revisions — show a message instead
  if (isImageItem) {
    return (
      <div className={styles.container}>
        <Link to={`/admin/pulse-check/${itemId}`} className={styles.backLink}>
          {labels.revision.backLink.replace('{itemName}', itemName)}
        </Link>
        <h1 className={styles.heading}>{labels.revision.heading}</h1>
        <p className={styles.emptyBody}>{labels.pulseCheck.imageRevisionNotice}</p>
      </div>
    );
  }

  const { data: revisionsResp, isLoading, isError, refetch } = useAuthedQuery<RevisionsResponse>(
    ['revisions', itemId],
    `/api/manage/items/${itemId}/revisions`,
    { enabled: Boolean(itemId), retry: false }
  );

  const revisions = revisionsResp?.data?.revisions ?? [];
  const latestRevision = revisions[0] ?? null;
  const selectedRevision = selectedRevisionId
    ? revisions.find(r => r.revisionId === selectedRevisionId) ?? latestRevision
    : latestRevision;

  const generateMutation = useAuthedMutation<{ data: { revisionId: string; status: string } }, undefined>(
    `/api/manage/items/${itemId}/revise`,
    'POST',
    {
      onSuccess: () => {
        setGenerating(true);
        setGenerateError('');
        setOverlayVisible(true);
        setOverlayDone(false);
        setOverlayError('');
        startPolling();
      },
      onError: (err) => {
        const status = (err as Error & { status?: number }).status;
        if (status === 403) {
          navigate('/admin/items', { replace: true });
        } else if (status === 409) {
          setGenerateError(labels.revision.noPulseCheckError);
        } else {
          setOverlayVisible(false);
          setGenerateError(labels.revision.generateError);
        }
      },
    }
  );

  function startPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    failureCountRef.current = 0;
    pollingRef.current = setInterval(async () => {
      try {
        const result = await refetch();
        failureCountRef.current = 0; // reset on success
        const latest = result.data?.data?.revisions?.[0];
        if (latest?.status === 'complete') {
          stopPolling();
          setOverlayDone(true);
          setGenerating(false);
          setSelectedRevisionId(latest.revisionId);
        } else if (latest?.status === 'failed') {
          stopPolling();
          setOverlayVisible(false);
          setGenerating(false);
          setGenerateError(labels.revision.generateError);
        }
      } catch {
        failureCountRef.current += 1;
        if (failureCountRef.current >= 10) {
          stopPolling();
          setOverlayVisible(false);
          setGenerating(false);
          setGenerateError(labels.revision.generateError);
        }
      }
    }, 3000);
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  useEffect(() => () => stopPolling(), []);

  // Load pane content when a revision is selected
  useEffect(() => {
    if (!selectedRevision || selectedRevision.status !== 'complete') return;
    if (!selectedRevision.documentUrl && !selectedRevision.originalUrl) return;

    setContentLoading(true);
    const fetches: Promise<string>[] = [];

    if (selectedRevision.originalUrl) {
      fetches.push(fetch(selectedRevision.originalUrl).then(r => r.text()));
    } else {
      fetches.push(Promise.resolve(''));
    }
    if (selectedRevision.documentUrl) {
      fetches.push(fetch(selectedRevision.documentUrl).then(r => r.text()));
    } else {
      fetches.push(Promise.resolve(''));
    }

    Promise.all(fetches)
      .then(([orig, rev]) => {
        setOriginalContent(orig);
        setRevisionContent(rev);
      })
      .catch(() => {
        setOriginalContent(null);
        setRevisionContent(null);
      })
      .finally(() => setContentLoading(false));
  }, [selectedRevision?.revisionId, selectedRevision?.status]);

  useEffect(() => {
    document.title = itemName
      ? labels.revision.documentTitle.replace('{itemName}', itemName)
      : 'Revision — Pulse';
  }, [itemName]);

  async function handleDownloadPdf() {
    if (!selectedRevision || pdfGenerating || !originalContent || !revisionContent) return;
    setPdfGenerating(true);
    try {
      await downloadRevisionPdf(originalContent, revisionContent, itemName, selectedRevision.revisionNumber);
    } catch { /* silently fail */ }
    finally { setPdfGenerating(false); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className={styles.container}>
        <p className={styles.loadingText}>{labels.revision.loading}</p>
      </div>
    );
  }

  if (isError && !generating) {
    return (
      <div className={styles.container}>
        <p className={styles.errorText}>{labels.revision.loadError}</p>
        <button type="button" className={styles.retryButton} onClick={() => refetch()}>
          {labels.revision.retryButton}
        </button>
      </div>
    );
  }

  const hasPulseCheck = !isError; // 404 on revisions means no pulse check yet
  const hasRevisions = revisions.length > 0;

  return (
    <div className={styles.container} aria-label={`Revision for ${itemName}`}>
      {/* Breadcrumb */}
      <Link to="/admin/items" state={{ openModalId: itemId, returnFocusId: itemId }} className={styles.backLink}>
        {labels.revision.backLink.replace('{itemName}', itemName || 'item')}
      </Link>

      {/* Heading */}
      <div className={styles.headingRow}>
        <h1 className={styles.heading}>
          {selectedRevision
            ? labels.revision.headingWithNumber.replace('{number}', String(selectedRevision.revisionNumber))
            : labels.revision.heading}
        </h1>
        {selectedRevision?.status === 'complete' && (
          <button
            type="button"
            className={styles.downloadPdfButton}
            onClick={handleDownloadPdf}
            disabled={pdfGenerating}
          >
            {pdfGenerating ? labels.revision.downloadingPdf : labels.revision.downloadPdf}
          </button>
        )}
      </div>

      {/* Generating overlay */}
      {overlayVisible && (
        <PulseCheckOverlay
          itemName={itemName}
          done={overlayDone}
          error={overlayError}
          onErrorDismiss={() => { setOverlayVisible(false); setOverlayError(''); }}
          phases={REVISION_PHASES}
          notice={labels.revision.overlayNotice}
          operationType="revision"
        />
      )}

      {/* Error from generate */}
      {generateError && !generating && (
        <div aria-live="polite" className={styles.errorRegion}>
          <p className={styles.errorText}>{generateError}</p>
          {generateError === labels.revision.noPulseCheckError && (
            <Link to={`/admin/pulse-check/${itemId}`} className={styles.linkButton}>
              {labels.revision.noPulseCheckLink}
            </Link>
          )}
          {generateError === labels.revision.generateError && (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => { setGenerateError(''); generateMutation.mutate(undefined); }}
            >
              {labels.revision.retryButton}
            </button>
          )}
        </div>
      )}

      {/* Empty state — no revisions yet */}
      {!generating && !hasRevisions && !generateError && (
        hasPulseCheck ? (
          // Action-forward empty state
          <div className={styles.emptyActionState}>
            <p className={styles.emptyEyebrow}>{labels.revision.emptyEyebrow}</p>
            <h2 className={styles.emptyHeading}>{labels.revision.emptyHeading}</h2>
            <p className={styles.emptyBody}>
              {labels.revision.emptyBody.replace('{itemName}', itemName)}
            </p>
            <span className={styles.warningPill}>{labels.revision.emptyWarning}</span>
            <button
              type="button"
              className={styles.generateButton}
              onClick={() => generateMutation.mutate(undefined)}
              disabled={generateMutation.isPending}
            >
              {labels.revision.emptyCta}
            </button>
          </div>
        ) : (
          // Informational empty state — no pulse check
          <div className={styles.emptyInfoState}>
            <p className={styles.emptyInfoText}>{labels.revision.noPulseCheckBody}</p>
            <Link to={`/admin/pulse-check/${itemId}`} className={styles.linkButton}>
              {labels.revision.noPulseCheckLink}
            </Link>
          </div>
        )
      )}

      {/* Revision history list */}
      {!generating && hasRevisions && showHistory && (
        <div className={styles.historyList} aria-label="Revision history">
          {revisions.map(r => (
            <div
              key={r.revisionId}
              className={`${styles.historyRow} ${r.revisionId === selectedRevision?.revisionId ? styles.historyRowActive : ''}`}
            >
              <span className={styles.historyLabel}>
                {labels.revision.revisionPaneLabel.replace('{number}', String(r.revisionNumber))}
              </span>
              <span className={styles.historyDate}>
                {new Date(r.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </span>
              <button
                type="button"
                className={styles.historyViewButton}
                onClick={() => { setSelectedRevisionId(r.revisionId); setShowHistory(false); }}
                aria-label={`View ${labels.revision.revisionPaneLabel.replace('{number}', String(r.revisionNumber))}`}
              >
                View
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Side-by-side revision view */}
      {!generating && selectedRevision?.status === 'complete' && (
        <>
          {/* Mobile tabs */}
          <div className={styles.mobileOnly}>
            <MobileTabs
              activeTab={mobileTab}
              onSelect={setMobileTab}
              revisionNumber={selectedRevision.revisionNumber}
            />
          </div>

          {contentLoading ? (
            <p className={styles.loadingText}>{labels.revision.loading}</p>
          ) : (
            <>
              {/* Desktop: side-by-side */}
              <div className={`${styles.panesContainer} ${styles.desktopOnly}`}>
                <RevisionPane
                  label={labels.revision.originalPaneLabel}
                  content={originalContent ?? ''}
                />
                <RevisionPane
                  label={labels.revision.revisionPaneLabel.replace('{number}', String(selectedRevision.revisionNumber))}
                  content={revisionContent ?? ''}
                  accentBorder
                />
              </div>

              {/* Mobile: single pane */}
              <div className={styles.mobileOnly}>
                {mobileTab === 'original' ? (
                  <div id="pane-original" role="tabpanel">
                    <RevisionPane label={labels.revision.originalPaneLabel} content={originalContent ?? ''} />
                  </div>
                ) : (
                  <div id="pane-revision" role="tabpanel">
                    <RevisionPane
                      label={labels.revision.revisionPaneLabel.replace('{number}', String(selectedRevision.revisionNumber))}
                      content={revisionContent ?? ''}
                      accentBorder
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {/* Action row */}
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.generateAnotherButton}
              onClick={() => generateMutation.mutate(undefined)}
              disabled={generateMutation.isPending}
            >
              {labels.revision.generateAnother}
            </button>
            <button
              type="button"
              className={styles.historyToggle}
              onClick={() => setShowHistory(v => !v)}
            >
              {labels.revision.historyLink}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
