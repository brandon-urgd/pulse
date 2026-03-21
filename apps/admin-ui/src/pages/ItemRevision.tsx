import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './ItemRevision.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Revision {
  revisionId: string;
  revisionNumber: number;
  generatedAt: string;
  status: 'generating' | 'complete' | 'failed';
  documentUrl?: string;
  originalUrl?: string;
}

interface RevisionsResponse {
  data: { revisions: Revision[] };
}

interface ItemResponse {
  data: { itemId: string; itemName: string; status: string };
}

// ─── Generating overlay ───────────────────────────────────────────────────────

const PHASES = [
  labels.revision.generatingPhase1,
  labels.revision.generatingPhase2,
  labels.revision.generatingPhase3,
  labels.revision.generatingPhase4,
] as const;

function GeneratingOverlay({ itemName }: { itemName: string }) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (prefersReduced) return;
    const id = setInterval(() => setPhaseIndex(i => (i + 1) % PHASES.length), 4000);
    return () => clearInterval(id);
  }, [prefersReduced]);

  return (
    <div className={styles.generatingOverlay} role="status" aria-label={labels.revision.generatingCaption.replace('{itemName}', itemName)}>
      <div className={styles.thinkingDots} aria-hidden="true">
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
      </div>
      <p className={styles.generatingPhase} aria-live="polite">
        {prefersReduced ? `${labels.revision.generatingCaption.replace('{itemName}', itemName)}…` : PHASES[phaseIndex]}
      </p>
      <p className={styles.generatingCaption}>
        {labels.revision.generatingCaption.replace('{itemName}', itemName)}
      </p>
    </div>
  );
}

// ─── Revision pane content ────────────────────────────────────────────────────

function RevisionPane({ label, content, accentBorder }: { label: string; content: string; accentBorder?: boolean }) {
  return (
    <div className={styles.pane}>
      <p className={styles.paneLabel}>{label}</p>
      <div className={`${styles.paneContent} ${accentBorder ? styles.paneContentAccent : ''}`}>
        <pre className={styles.paneText}>{content}</pre>
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
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [revisionContent, setRevisionContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [mobileTab, setMobileTab] = useState<'original' | 'revision'>('revision');
  const [showHistory, setShowHistory] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: itemResp } = useAuthedQuery<ItemResponse>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: Boolean(itemId) }
  );
  const itemName = itemResp?.data?.itemName ?? '';

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
        startPolling();
      },
      onError: (err) => {
        const status = (err as Error & { status?: number }).status;
        if (status === 403) {
          navigate('/admin/items', { replace: true });
        } else if (status === 409) {
          setGenerateError(labels.revision.noPulseCheckError);
        } else {
          setGenerateError(labels.revision.generateError);
        }
      },
    }
  );

  function startPolling() {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      const result = await refetch();
      const latest = result.data?.data?.revisions?.[0];
      if (latest?.status === 'complete') {
        stopPolling();
        setGenerating(false);
        setSelectedRevisionId(latest.revisionId);
      } else if (latest?.status === 'failed') {
        stopPolling();
        setGenerating(false);
        setGenerateError(labels.revision.generateError);
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
    <div className={styles.container} role="main" aria-label={`Revision for ${itemName}`}>
      {/* Breadcrumb */}
      <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
        {labels.revision.backLink.replace('{itemName}', itemName || 'item')}
      </Link>

      {/* Heading */}
      <h1 className={styles.heading}>
        {selectedRevision
          ? labels.revision.headingWithNumber.replace('{number}', String(selectedRevision.revisionNumber))
          : labels.revision.heading}
      </h1>

      {/* Generating overlay */}
      {generating && <GeneratingOverlay itemName={itemName} />}

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
                {new Date(r.generatedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </span>
              <button
                type="button"
                className={styles.historyViewButton}
                onClick={() => { setSelectedRevisionId(r.revisionId); setShowHistory(false); }}
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
