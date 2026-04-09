import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import { downloadPulseCheckPdf } from '../utils/downloadPdf';
import SignalBadge, { type EnergyLevel } from '../components/SignalBadge';
import SignalMatrix, { type ThemeRow, type ReviewerColumn } from '../components/SignalMatrix';
import SignalSummary from '../components/SignalSummary';
import ReviewerOverview from '../components/ReviewerOverview';
import RevisionGroups from '../components/RevisionGroups';
import FeedbackActionPills, { type FeedbackAction } from '../components/FeedbackActionPills';
import PulseCheckOverlay from '../components/PulseCheckOverlay';
import SectionCoveragePanel from '../components/SectionCoveragePanel';
import styles from './PulseCheck.module.css';

// ─── Types (matching actual lambda response shape) ────────────────────────────

interface ReviewerSignal {
  sessionId: string;
  signalType: 'conviction' | 'tension' | 'uncertainty';
  quote: string;
}

interface PulseCheckTheme {
  themeId: string;
  label: string;
  reviewerSignals: ReviewerSignal[];
}

interface ReviewerVerdict {
  sessionId: string;
  verdict: string;
  energy: EnergyLevel;
  isSelfReview: boolean;
}

interface DecisionRecord {
  action: string;
  tenantNote?: string;
  decidedAt: string;
}

interface ProposedRevision {
  revisionId: string;
  proposal: string;
  rationale: string;
  revisionType: 'structural' | 'line-edit' | 'conceptual' | 'feature';
  sourceThemeIds: string[];
}

interface PulseCheck {
  itemId: string;
  verdict: string;
  narrative: string;
  themes: PulseCheckTheme[];
  sharedConviction: string[];
  repeatedTension: string[];
  openQuestions: string[];
  reviewerVerdicts: ReviewerVerdict[];
  proposedRevisions: ProposedRevision[];
  decisions: Record<string, DecisionRecord>;
  sessionCount: number;
  incompleteCount?: number;
  generatedAt: string;
  status: 'generating' | 'complete' | 'failed';
  newSessionsSinceLastRun?: number;
}

interface PulseCheckResponse {
  data: PulseCheck;
}

interface ItemResponse {
  data: {
    itemId: string;
    itemName: string;
    sessionCount: number;
    status: string;
    description: string;
    feedbackSections?: string[];
    coverageMap?: Record<string, { sessionCount: number; avgDepth?: string; reviewerIds?: string[] }>;
    sectionMap?: {
      sections: Array<{ id: string; title: string; classification: string }>;
    };
    sectionDepthPreferences?: Record<string, 'deep' | 'explore' | 'skim'>;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Scale tier detection — determines rendering strategy based on session count */
export type ScaleTier = 'solo' | 'small' | 'medium';

export function getScaleTier(sessionCount: number): ScaleTier {
  if (sessionCount <= 1) return 'solo';
  if (sessionCount <= 7) return 'small';
  return 'medium'; // 8-20
}

/** Shallow-compare two Record<string, string | null> objects (avoids JSON.stringify in render) */
function shallowRecordEqual(a: Record<string, string | null>, b: Record<string, string | null>): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function buildMatrixData(
  themes: PulseCheckTheme[],
  reviewerVerdicts: ReviewerVerdict[],
  itemId: string
): { themeRows: ThemeRow[]; reviewerCols: ReviewerColumn[] } {
  const reviewerCols: ReviewerColumn[] = reviewerVerdicts.map((rv, i) => ({
    reviewerId: rv.sessionId,
    name: rv.isSelfReview ? 'Self-review' : `Reviewer ${i + 1}`,
    verdict: rv.verdict,
    energy: rv.energy,
    href: `/admin/items/${itemId}/sessions/${rv.sessionId}/report`,
  }));

  const themeRows: ThemeRow[] = themes.map((t) => {
    const signals: ThemeRow['signals'] = {};
    for (const rs of t.reviewerSignals) {
      signals[rs.sessionId] = { signal: rs.signalType, quote: rs.quote };
    }
    return { themeId: t.themeId, theme: t.label, signals };
  });

  return { themeRows, reviewerCols };
}

// ─── S4 Enhancement Components ────────────────────────────────────────────────

function ConfidenceIndicator({ sessionCount }: { sessionCount: number }) {
  const label = sessionCount === 1
    ? labels.pulseCheck.confidenceSolo
    : labels.pulseCheck.confidenceMulti.replace('{count}', String(sessionCount));
  const level = sessionCount >= 5 ? 'high' : sessionCount >= 2 ? 'moderate' : 'low';
  return <span className={styles[`confidence${level}`]}>{label}</span>;
}

function ScaleTierLabel({ sessionCount }: { sessionCount: number }) {
  const tier = getScaleTier(sessionCount);
  const label = tier === 'solo'
    ? labels.pulseCheck.scaleSolo
    : tier === 'small'
      ? labels.pulseCheck.scaleSmallGroup
      : labels.pulseCheck.scaleMediumGroup;
  return <span className={styles.scaleTier}>{label}</span>;
}

function InlineQuotePreview({ quote }: { quote: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = quote.length > 60;
  const preview = needsTruncation ? quote.slice(0, 60) + '…' : quote;

  return (
    <span
      className={styles.quotePreview}
      onClick={() => needsTruncation && setExpanded(!expanded)}
      onKeyDown={needsTruncation ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } } : undefined}
      role={needsTruncation ? 'button' : undefined}
      tabIndex={needsTruncation ? 0 : undefined}
      aria-expanded={needsTruncation ? expanded : undefined}
    >
      {expanded ? quote : preview}
    </span>
  );
}

function RevisionWeightIndicator({ count, total }: { count: number; total: number }) {
  if (count === 1 && total === 1) {
    return <span className={styles.revisionWeight}>{labels.pulseCheck.revisionWeightSolo}</span>;
  }
  return (
    <span className={styles.revisionWeight}>
      {labels.pulseCheck.revisionWeight.replace('{count}', String(count)).replace('{total}', String(total))}
    </span>
  );
}

interface BatchActionProps {
  revisionType: string;
  revisionIds: string[];
  onBatchAccept: (type: string) => void;
  onBatchDismiss: (type: string) => void;
  onUndo: (type: string) => void;
}

function BatchActionControls({ revisionType, revisionIds, onBatchAccept, onBatchDismiss, onUndo }: BatchActionProps) {
  const [lastAction, setLastAction] = useState<'accept' | 'dismiss' | null>(null);

  if (revisionIds.length <= 1) return null;

  return (
    <div className={styles.batchActions}>
      <button type="button" onClick={() => { onBatchAccept(revisionType); setLastAction('accept'); }}>
        {labels.pulseCheck.batchAcceptAll}
      </button>
      <button type="button" onClick={() => { onBatchDismiss(revisionType); setLastAction('dismiss'); }}>
        {labels.pulseCheck.batchDismissAll}
      </button>
      {lastAction && (
        <button type="button" onClick={() => { onUndo(revisionType); setLastAction(null); }}>
          {labels.pulseCheck.batchUndo}
        </button>
      )}
    </div>
  );
}

function PulseCheckFeedback({ itemId, existingFeedback }: { itemId: string; existingFeedback?: { rating?: string; reason?: string } }) {
  const [rating, setRating] = useState<'up' | 'down' | null>((existingFeedback?.rating as 'up' | 'down') ?? null);
  const [showReasons, setShowReasons] = useState(false);
  const [submitted, setSubmitted] = useState(!!existingFeedback?.rating);
  const navigate = useNavigate();

  const reasons = [
    { key: 'already_knew', label: labels.feedback.pcAlreadyKnew },
    { key: 'too_abstract', label: labels.feedback.pcTooAbstract },
    { key: 'didnt_reflect_reviewers', label: labels.feedback.pcDidntReflectReviewers },
    { key: 'need_more_feedback', label: labels.feedback.pcNeedMoreFeedback },
  ];

  const handleUp = async () => {
    setRating('up');
    setSubmitted(true);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/pulse-check/decisions`,
        'PUT',
        { pulseCheckFeedback: { rating: 'up', timestamp: new Date().toISOString() } },
        navigate
      );
    } catch { /* best-effort */ }
  };

  const handleDown = () => {
    setRating('down');
    setShowReasons(true);
  };

  const handleReason = async (reasonKey: string) => {
    setSubmitted(true);
    setShowReasons(false);
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/pulse-check/decisions`,
        'PUT',
        { pulseCheckFeedback: { rating: 'down', reason: reasonKey, timestamp: new Date().toISOString() } },
        navigate
      );
    } catch { /* best-effort */ }
  };

  return (
    <div className={styles.feedbackPrompt}>
      <p>{labels.feedback.pulseCheckPrompt}</p>
      <div className={styles.feedbackButtons}>
        <button type="button" disabled={submitted} onClick={handleUp} className={rating === 'up' ? styles.selected : ''} aria-label="Helpful">👍</button>
        <button type="button" disabled={submitted} onClick={handleDown} className={rating === 'down' ? styles.selected : ''} aria-label="Not helpful">👎</button>
      </div>
      {showReasons && !submitted && (
        <div className={styles.reasonPills}>
          <p>{labels.feedback.reasonPromptPulseCheck}</p>
          {reasons.map(r => (
            <button key={r.key} type="button" onClick={() => handleReason(r.key)} className={styles.reasonPill}>{r.label}</button>
          ))}
        </div>
      )}
      {submitted && <p className={styles.thanks}>{labels.feedback.thanks}</p>}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PulseCheck() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [decisions, setDecisions] = useState<Record<string, FeedbackAction>>({});
  const [tenantNotes, setTenantNotes] = useState<Record<string, string>>({});
  const savedDecisionsRef = useRef<Record<string, FeedbackAction>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErrorMsg, setSaveErrorMsg] = useState('');
  const [generateError, setGenerateError] = useState('');
  const [conflictError, setConflictError] = useState('');
  const [isClosingAndRunning, setIsClosingAndRunning] = useState(false);
  const [closeRunError, setCloseRunError] = useState('');
  const [rerunError, setRerunError] = useState('');
  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayDone, setOverlayDone] = useState(false);
  const [overlayError, setOverlayError] = useState('');
  const [pdfGenerating, setPdfGenerating] = useState(false);

  // Batch action state — stores pre-batch decisions for undo
  const [preBatchDecisions, setPreBatchDecisions] = useState<Record<string, Record<string, FeedbackAction>>>({});

  const { data: itemResp } = useAuthedQuery<ItemResponse>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: Boolean(itemId) }
  );
  const itemName = itemResp?.data?.itemName ?? '';
  const itemStatus = itemResp?.data?.status ?? '';
  const itemDescription = itemResp?.data?.description ?? '';
  const itemCoverageMap = itemResp?.data?.coverageMap ?? {};
  const itemSectionMap = itemResp?.data?.sectionMap;

  // Filter sections to only those the tenant requested feedback on
  const feedbackSections = itemResp?.data?.feedbackSections;
  const allSections = itemSectionMap?.sections ?? [];
  const coverageSections =
    feedbackSections && feedbackSections.length > 0
      ? allSections.filter((s) => feedbackSections.includes(s.id))
      : allSections;

  const { data: pcResp, isLoading, isError, refetch } = useAuthedQuery<PulseCheckResponse>(
    ['pulse-check', itemId],
    `/api/manage/items/${itemId}/pulse-check`,
    { enabled: Boolean(itemId), retry: false }
  );
  const pc = pcResp?.data;

  // Poll every 3s while status is 'generating'
  useEffect(() => {
    if (pc?.status !== 'generating') return;
    const interval = setInterval(() => {
      refetch().then((result) => {
        if (result.data?.data?.status === 'complete') {
          setOverlayDone(true);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (result.data?.data?.status === 'failed') {
          setOverlayVisible(false);
          setOverlayError(labels.pulseCheck.generateError);
        }
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [pc?.status, refetch]);

  interface Session { sessionId: string; status: string; completedAt?: string }
  const { data: sessionsResp } = useAuthedQuery<{ data: Session[] }>(
    ['item-sessions', itemId],
    `/api/manage/items/${itemId}/sessions`,
    { enabled: Boolean(itemId) && Boolean(pcResp) }
  );
  const newlyCompletedCount = pc?.newSessionsSinceLastRun ?? 0;

  useEffect(() => {
    if (pc?.decisions) {
      const synced: Record<string, FeedbackAction> = {};
      const syncedNotes: Record<string, string> = {};
      for (const [revisionId, d] of Object.entries(pc.decisions)) {
        const action = d.action.toLowerCase();
        // map legacy 'override'/'revise' to current action names
        const mapped = action === 'override' ? 'dismiss' : action === 'revise' ? 'adjust' : action;
        synced[revisionId] = mapped as FeedbackAction;
        if (d.tenantNote) {
          syncedNotes[revisionId] = d.tenantNote;
        }
      }
      setDecisions(synced);
      setTenantNotes(syncedNotes);
      savedDecisionsRef.current = synced;
    }
  }, [pc]);

  useEffect(() => {
    document.title = itemName
      ? labels.pulseCheck.documentTitle.replace('{itemName}', itemName)
      : labels.pulseCheck.documentTitleDefault;
  }, [itemName]);

  function showOverlay() {
    setOverlayVisible(true);
    setOverlayDone(false);
    setOverlayError('');
  }

  async function handleDownloadPdf() {
    if (!pc || pdfGenerating) return;
    setPdfGenerating(true);
    try {
      await downloadPulseCheckPdf(pc, itemName);
    } catch { /* PDF generation error — non-blocking */ }
    finally { setPdfGenerating(false); }
  }

  const generateMutation = useAuthedMutation<PulseCheckResponse, undefined>(
    `/api/manage/items/${itemId}/pulse-check`,
    'POST',
    {
      onSuccess: () => {
        // POST returned 202 — polling loop will detect 'complete' and set overlayDone
        queryClient.invalidateQueries({ queryKey: ['pulse-check', itemId] });
        refetch();
        setGenerateError('');
        setConflictError('');
        setRerunError('');
      },
      onError: (err) => {
        const status = (err as Error & { status?: number }).status;
        setOverlayVisible(false);
        setOverlayDone(false);
        if (status === 409) {
          setConflictError(labels.pulseCheck.sessionsStillOpenError);
        } else {
          setOverlayError(labels.pulseCheck.generateError);
          setGenerateError(labels.pulseCheck.generateError);
          setRerunError(labels.pulseCheck.rerunError);
        }
      },
    }
  );

  async function handleCloseAndRun() {
    setIsClosingAndRunning(true);
    setCloseRunError('');
    try {
      await authedMutate(`/api/manage/items/${itemId}/close`, 'PUT', {}, navigate);
      queryClient.invalidateQueries({ queryKey: ['item', itemId] });
      queryClient.invalidateQueries({ queryKey: ['items'] });
      showOverlay();
      generateMutation.mutate(undefined);
    } catch {
      setCloseRunError(labels.pulseCheck.closeAndRunError);
      setIsClosingAndRunning(false);
    }
  }

  async function handleSaveDecisions() {
    setSaveStatus('saving');
    setSaveErrorMsg('');
    // Map frontend action names back to Lambda-expected values
    const actionToApi: Record<string, string> = { accept: 'Accept', adjust: 'Revise', dismiss: 'Override' };
    const payload: Record<string, { action: string; tenantNote?: string }> = {};
    for (const [themeId, action] of Object.entries(decisions)) {
      if (action !== null) {
        const entry: { action: string; tenantNote?: string } = { action: actionToApi[action] ?? action.charAt(0).toUpperCase() + action.slice(1) };
        if (action === 'adjust' && tenantNotes[themeId]?.length) {
          entry.tenantNote = tenantNotes[themeId];
        }
        payload[themeId] = entry;
      }
    }
    try {
      await authedMutate(
        `/api/manage/items/${itemId}/pulse-check/decisions`,
        'PUT',
        { decisions: payload },
        navigate
      );
      setSaveStatus('saved');
      savedDecisionsRef.current = { ...decisions };
      queryClient.invalidateQueries({ queryKey: ['pulse-check', itemId] });
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      setSaveErrorMsg(status === 409 ? labels.pulseCheck.sessionsStillOpenError : labels.pulseCheck.saveDecisionsError);
      setSaveStatus('error');
    }
  }

  function handleBatchAccept(revisionType: string) {
    const revisions = (pc?.proposedRevisions ?? []).filter(r => r.revisionType === revisionType);
    setPreBatchDecisions(prev => ({ ...prev, [revisionType]: { ...decisions } }));
    setDecisions(prev => {
      const next = { ...prev };
      for (const r of revisions) next[r.revisionId] = 'accept';
      return next;
    });
    setTenantNotes(prev => {
      const next = { ...prev };
      for (const r of revisions) delete next[r.revisionId];
      return next;
    });
  }

  function handleBatchDismiss(revisionType: string) {
    const revisions = (pc?.proposedRevisions ?? []).filter(r => r.revisionType === revisionType);
    setPreBatchDecisions(prev => ({ ...prev, [revisionType]: { ...decisions } }));
    setDecisions(prev => {
      const next = { ...prev };
      for (const r of revisions) next[r.revisionId] = 'dismiss';
      return next;
    });
    setTenantNotes(prev => {
      const next = { ...prev };
      for (const r of revisions) delete next[r.revisionId];
      return next;
    });
  }

  function handleBatchUndo(revisionType: string) {
    const saved = preBatchDecisions[revisionType];
    if (saved) {
      setDecisions(saved);
      setPreBatchDecisions(prev => { const next = { ...prev }; delete next[revisionType]; return next; });
    }
  }

  // ── Revision CTA visibility ─────────────────────────────────────────────────
  // Show CTA when at least one accept/adjust decision has been persisted
  const hasPersistedActionableDecision = Object.values(savedDecisionsRef.current).some(
    (action) => action === 'accept' || action === 'adjust'
  );

  // ── Overlay (rendered regardless of page state) ─────────────────────────────
  const Overlay = overlayVisible ? (
    <PulseCheckOverlay
      itemName={itemName}
      done={overlayDone}
      error={overlayError}
      onErrorDismiss={() => { setOverlayVisible(false); setOverlayError(''); }}
    />
  ) : null;

  if (isLoading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading} aria-busy="true">{labels.pulseCheck.loading}</p>
      </div>
    );
  }

  if (isError || !pc) {
    const itemIsActive = itemStatus === 'active';
    const isPending = generateMutation.isPending || isClosingAndRunning;

    return (
      <>
        {Overlay}
        <div className={styles.container}>
          <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
            ← {labels.pulseCheck.backToItem}
          </Link>
          <h1 className={styles.heading}>
            {itemName
              ? labels.pulseCheck.itemHeading.replace('{itemName}', itemName)
              : labels.pulseCheck.heading}
          </h1>

          <div className={`${styles.generatePrompt} ${itemIsActive ? styles.generatePromptActive : styles.generatePromptClosed}`}>
            {itemIsActive ? (
              <>
                <p className={styles.generatePromptEyebrow}>Ready to wrap up?</p>
                <p className={styles.generatePromptHeading}>{labels.pulseCheck.closeAndRunPromptText}</p>
                <p className={styles.generatePromptWarning}>{labels.pulseCheck.closeAndRunWarning}</p>
                <button
                  type="button"
                  className={styles.generateButton}
                  onClick={handleCloseAndRun}
                  disabled={isPending}
                >
                  {isPending ? labels.pulseCheck.generating : labels.pulseCheck.closeAndRunButton}
                </button>
                {closeRunError && (
                  <p className={styles.error} role="alert" aria-live="polite">{closeRunError}</p>
                )}
              </>
            ) : (
              <>
                <p className={styles.generatePromptText}>{labels.pulseCheck.generatePromptText}</p>
                <button
                  type="button"
                  className={styles.generateButton}
                  onClick={() => { showOverlay(); generateMutation.mutate(undefined); }}
                  disabled={isPending}
                >
                  {isPending ? labels.pulseCheck.generating : labels.pulseCheck.generateButton}
                </button>
                {conflictError && (
                  <p className={styles.conflictError} role="alert" aria-live="polite">{conflictError}</p>
                )}
                {!conflictError && generateError && (
                  <p className={styles.error} role="alert" aria-live="polite">{generateError}</p>
                )}
              </>
            )}
          </div>
        </div>
      </>
    );
  }

  const isMultiSession = pc.sessionCount >= 2;
  const incompleteCount = pc.incompleteCount ?? 0;

  const IncompleteNotice = incompleteCount > 0 ? (
    <p className={styles.incompleteNotice} role="note">
      {labels.pulseCheck.incompleteSessionsNotice
        .replace('{incomplete}', String(incompleteCount))
        .replace('{total}', String(pc.sessionCount))}
    </p>
  ) : null;

  const NewSessionsBanner = newlyCompletedCount > 0 ? (
    <div className={styles.rerunBanner} role="status">
      <p className={styles.rerunBannerText}>
        {labels.pulseCheck.newSessionsNotice.replace('{count}', String(newlyCompletedCount))}
      </p>
      <button
        type="button"
        className={styles.rerunBannerButton}
        onClick={() => { setRerunError(''); showOverlay(); generateMutation.mutate(undefined); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        disabled={generateMutation.isPending}
      >
        {generateMutation.isPending ? labels.pulseCheck.generating : labels.pulseCheck.rerunButton}
      </button>
    </div>
  ) : null;

  // ── Single-session view ─────────────────────────────────────────────────────
  if (!isMultiSession) {
    const singleReviewer = pc.reviewerVerdicts?.[0];
    const verdict = pc.verdict ?? labels.pulseCheck.noVerdict;
    const energy = singleReviewer?.energy ?? 'neutral';
    const narrative = pc.narrative ?? '';
    const questions = pc.openQuestions ?? [];
    const themes = pc.themes ?? [];
    const proposedRevisions = pc.proposedRevisions ?? [];

    return (
      <>
        {Overlay}
        <div className={styles.container}>
          <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
            ← {labels.pulseCheck.backToItem}
          </Link>
          <div className={styles.headingRow}>
            <h1 className={styles.heading}>
              {itemName
                ? labels.pulseCheck.itemHeading.replace('{itemName}', itemName)
                : labels.pulseCheck.heading}
            </h1>
            <button
              type="button"
              className={styles.downloadPdfButton}
              onClick={handleDownloadPdf}
              disabled={pdfGenerating}
            >
              {pdfGenerating ? labels.pulseCheck.downloadingPdf : labels.pulseCheck.downloadPdf}
            </button>
          </div>
          {IncompleteNotice}
          {NewSessionsBanner}

          {(() => {
            // Verdict color based on verdict text sentiment, not energy
            const v = verdict.toLowerCase();
            const isPositive = v.includes('strong consensus') || v.includes('move forward');
            const isNegative = v.includes('not enough') || v.includes('gather more');
            const verdictColorClass = isNegative ? styles.verdictBlockNegative : isPositive ? styles.verdictBlockPositive : styles.verdictBlockNeutral;
            return (
              <div className={`${styles.verdictBlock} ${verdictColorClass}`}>
                <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
                <p className={styles.verdictText}>{verdict}</p>
                {narrative && <p className={styles.verdictNarrative}>{narrative}</p>}
                <div className={styles.energyRow}>
                  <span className={styles.energyLabel}>{labels.pulseCheck.energyLabel}</span>
                  <SignalBadge variant={energy} />
                </div>
                <div className={styles.confidenceRow}>
                  <ConfidenceIndicator sessionCount={pc.sessionCount} />
                  <ScaleTierLabel sessionCount={pc.sessionCount} />
                </div>
              </div>
            );
          })()}

          {/* Section coverage panel */}
          {coverageSections.length > 0 && (
            <SectionCoveragePanel
              sections={coverageSections}
              coverageMap={itemCoverageMap}
              depthPreferences={itemResp?.data?.sectionDepthPreferences ?? {}}
            />
          )}

          {/* Themes — what the reviewer flagged */}
          {themes.length > 0 && (
            <section className={styles.synthesisSection} aria-labelledby="single-themes-heading">
              <h2 id="single-themes-heading" className={styles.synthesisHeading}>{labels.pulseCheck.synthesisHeading}</h2>
              {themes.map((t) => (
                <div key={t.themeId} className={styles.section}>
                  <h3 className={styles.sectionHeading}>
                    <SignalBadge variant={t.reviewerSignals[0]?.signalType ?? 'conviction'} />
                    {t.label}
                  </h3>
                  <ul className={styles.quoteList}>
                    {t.reviewerSignals.map((rs, i) => (
                      <li key={i} className={styles.quoteItem}><InlineQuotePreview quote={rs.quote} /></li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section className={styles.section} aria-labelledby="pc-questions-heading">
            <h2 id="pc-questions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="uncertainty" />
              {labels.pulseCheck.questionsHeading}
            </h2>
            {questions.length > 0 ? (
              <ul className={styles.quoteList}>
                {questions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noQuestions}</p>
            )}
          </section>

          {/* Proposed Revisions — same as multi-session */}
          <section aria-labelledby="single-decisions-heading" className={styles.decisionsSection}>
            <h2 id="single-decisions-heading" className={styles.synthesisHeading}>{labels.pulseCheck.decisionsHeading}</h2>
            <p className={styles.decisionsHint}>{labels.pulseCheck.decisionsHint}</p>
            {proposedRevisions.length === 0 ? (
              <p className={styles.emptySection}>{labels.pulseCheck.noProposedRevisions}</p>
            ) : (
              <>
                {(['structural', 'conceptual', 'feature', 'line-edit'] as const).map((type) => {
                  const group = proposedRevisions.filter(r => r.revisionType === type);
                  if (group.length === 0) return null;
                  return (
                    <div key={type} className={styles.revisionGroup}>
                      <p className={styles.revisionGroupLabel}>{labels.pulseCheck.revisionTypeLabels[type]}</p>
                      <BatchActionControls
                        revisionType={type}
                        revisionIds={group.map(r => r.revisionId)}
                        onBatchAccept={handleBatchAccept}
                        onBatchDismiss={handleBatchDismiss}
                        onUndo={handleBatchUndo}
                      />
                      <ul className={styles.themeDecisionList}>
                        {group.map((revision) => {
                          const decided = decisions[revision.revisionId] ?? null;
                          const sourceCount = revision.sourceThemeIds?.length ?? 1;
                          return (
                            <li
                              key={revision.revisionId}
                              className={styles.themeDecisionRow}
                              data-decided={decided ?? undefined}
                            >
                              <div className={styles.themeDecisionHeader}>
                                <p className={styles.themeDecisionText}>{revision.proposal}</p>
                                <RevisionWeightIndicator count={sourceCount} total={pc.sessionCount} />
                                <div className={styles.themeDecisionBody}>
                                  <p className={styles.themeDecisionMeta}>{revision.rationale}</p>
                                  <FeedbackActionPills
                                    value={decided}
                                    onChange={(action) => {
                                      setDecisions((prev) => ({ ...prev, [revision.revisionId]: action }));
                                      if (action !== 'adjust') {
                                        setTenantNotes((prev) => { const next = { ...prev }; delete next[revision.revisionId]; return next; });
                                      }
                                    }}
                                    ariaLabel={`Decision for: ${revision.proposal}`}
                                    noteValue={tenantNotes[revision.revisionId] ?? ''}
                                    onNoteChange={(note) => setTenantNotes((prev) => ({ ...prev, [revision.revisionId]: note }))}
                                  />
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}

                <div className={styles.saveRow}>
                  <button
                    type="button"
                    className={styles.saveButton}
                    onClick={handleSaveDecisions}
                    disabled={saveStatus === 'saving' || Object.keys(decisions).length === 0 || shallowRecordEqual(decisions, savedDecisionsRef.current)}
                  >
                    {saveStatus === 'saving' ? labels.pulseCheck.savingDecisions : labels.pulseCheck.saveDecisionsButton}
                  </button>
                  {saveStatus === 'saved' && (
                    <span className={styles.saveSuccess} aria-live="polite">{labels.pulseCheck.decisionsSaved}</span>
                  )}
                  {saveStatus === 'error' && (
                    <span className={styles.saveError} role="alert" aria-live="polite">{saveErrorMsg}</span>
                  )}
                </div>

                {hasPersistedActionableDecision && (
                  <div className={styles.revisionCtaRow}>
                    <Link to={`/admin/items/${itemId}/revisions`} className={styles.revisionCta}>
                      {labels.pulseCheck.viewRevisions}
                    </Link>
                  </div>
                )}
              </>
            )}
          </section>
          <PulseCheckFeedback itemId={itemId!} existingFeedback={(pc as unknown as { pulseCheckFeedback?: { rating?: string; reason?: string } }).pulseCheckFeedback} />
          <p className={styles.retentionNotice}>{labels.retention.shortNotice}</p>
          <p className={styles.meta}>
            {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}
          </p>
        </div>
      </>
    );
  }

  // ── Multi-session view ──────────────────────────────────────────────────────
  const reviewerVerdicts = pc.reviewerVerdicts ?? [];
  const { themeRows, reviewerCols } = buildMatrixData(pc.themes ?? [], reviewerVerdicts, itemId ?? '');
  const synthesizedVerdict = pc.verdict ?? labels.pulseCheck.noVerdict;
  const narrative = pc.narrative ?? '';
  const sharedConvictions = pc.sharedConviction ?? [];
  const repeatedTensions = pc.repeatedTension ?? [];
  const openQuestions = pc.openQuestions ?? [];
  const themes = pc.themes ?? [];
  const proposedRevisions = pc.proposedRevisions ?? [];

  return (
    <>
      {Overlay}
      <div className={styles.container}>
        <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
          ← {labels.pulseCheck.backToItem}
        </Link>
        <div className={styles.headingRow}>
          <h1 className={styles.heading}>
            {itemName
              ? labels.pulseCheck.itemHeading.replace('{itemName}', itemName)
              : labels.pulseCheck.heading}
          </h1>
          <button
            type="button"
            className={styles.downloadPdfButton}
            onClick={handleDownloadPdf}
            disabled={pdfGenerating}
          >
            {pdfGenerating ? labels.pulseCheck.downloadingPdf : labels.pulseCheck.downloadPdf}
          </button>
        </div>
        {IncompleteNotice}
        {NewSessionsBanner}

        {/* Verdict + narrative — above everything else */}
        {(() => {
          const v = synthesizedVerdict.toLowerCase();
          const isPositive = v.includes('strong consensus') || v.includes('move forward');
          const isNegative = v.includes('not enough') || v.includes('gather more');
          const verdictColorClass = isNegative ? styles.verdictBlockNegative : isPositive ? styles.verdictBlockPositive : styles.verdictBlockNeutral;
          return (
            <div className={`${styles.verdictBlock} ${verdictColorClass}`}>
              <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
              <p className={styles.verdictText}>{synthesizedVerdict}</p>
              {narrative && <p className={styles.verdictNarrative}>{narrative}</p>}
              <div className={styles.confidenceRow}>
                <ConfidenceIndicator sessionCount={pc.sessionCount} />
                <ScaleTierLabel sessionCount={pc.sessionCount} />
              </div>
              <p className={styles.verdictMeta}>
                {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}
              </p>
            </div>
          );
        })()}

        {/* Item description context */}
        {itemDescription && (
          <div className={styles.descriptionContext}>
            <p className={styles.descriptionContextLabel}>{labels.pulseCheck.askedForLabel}</p>
            <p className={styles.descriptionContextText}>{itemDescription}</p>
          </div>
        )}

        {/* Section coverage panel */}
        {coverageSections.length > 0 && (
          <SectionCoveragePanel
            sections={coverageSections}
            coverageMap={itemCoverageMap}
            depthPreferences={itemResp?.data?.sectionDepthPreferences ?? {}}
          />
        )}

        {themeRows.length > 0 && reviewerCols.length > 0 && (
          <section className={styles.matrixSection} aria-labelledby="matrix-heading">
            <h2 id="matrix-heading" className={styles.matrixHeading}>
              {getScaleTier(pc.sessionCount) === 'medium' ? 'Signal Summary' : labels.pulseCheck.matrixHeading}
            </h2>
            {getScaleTier(pc.sessionCount) === 'medium' ? (
              <SignalSummary themes={themeRows} reviewers={reviewerCols} sessionCount={pc.sessionCount} />
            ) : (
              <div className={styles.matrixScroll}>
                <SignalMatrix themes={themeRows} reviewers={reviewerCols} ariaLabel={labels.pulseCheck.matrixAriaLabel} />
              </div>
            )}
          </section>
        )}

        {/* Reviewer Overview — shown for Tier 2 (8+ sessions) */}
        {getScaleTier(pc.sessionCount) === 'medium' && reviewerCols.length > 0 && (
          <ReviewerOverview reviewers={reviewerCols} sessionCount={pc.sessionCount} />
        )}

        <section className={styles.synthesisSection} aria-labelledby="synthesis-heading">
          <h2 id="synthesis-heading" className={styles.synthesisHeading}>{labels.pulseCheck.synthesisHeading}</h2>

          <section className={styles.section} aria-labelledby="multi-convictions-heading">
            <h3 id="multi-convictions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="conviction" />
              {labels.pulseCheck.convictionsHeading}
            </h3>
            {sharedConvictions.length > 0 ? (
              <ul className={styles.quoteList}>
                {sharedConvictions.map((q, i) => <li key={i} className={styles.quoteItem}><InlineQuotePreview quote={q} /></li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noConvictions}</p>
            )}
          </section>

          <section className={styles.section} aria-labelledby="multi-tensions-heading">
            <h3 id="multi-tensions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="tension" />
              {labels.pulseCheck.tensionsHeading}
            </h3>
            {repeatedTensions.length > 0 ? (
              <ul className={styles.quoteList}>
                {repeatedTensions.map((q, i) => <li key={i} className={styles.quoteItem}><InlineQuotePreview quote={q} /></li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noTensions}</p>
            )}
          </section>

          <section className={styles.section} aria-labelledby="multi-questions-heading">
            <h3 id="multi-questions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="uncertainty" />
              {labels.pulseCheck.questionsHeading}
            </h3>
            {openQuestions.length > 0 ? (
              <ul className={styles.quoteList}>
                {openQuestions.map((q, i) => <li key={i} className={styles.quoteItem}><InlineQuotePreview quote={q} /></li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noQuestions}</p>
            )}
          </section>
        </section>

        {/* Proposed Revisions — grouped by type when sessionCount > 10, flat list otherwise */}
        <section aria-labelledby="decisions-heading" className={styles.decisionsSection}>
          <h2 id="decisions-heading" className={styles.synthesisHeading}>{labels.pulseCheck.decisionsHeading}</h2>
          <p className={styles.decisionsHint}>{labels.pulseCheck.decisionsHint}</p>
          {proposedRevisions.length === 0 ? (
            <p className={styles.emptySection}>{labels.pulseCheck.noProposedRevisions}</p>
          ) : (
            <>
              {pc.sessionCount > 10 ? (
                <RevisionGroups
                  revisions={proposedRevisions}
                  decisions={decisions}
                  onDecisionChange={(revisionId, action) => {
                    setDecisions((prev) => ({ ...prev, [revisionId]: action as FeedbackAction }));
                    if (action !== 'adjust') {
                      setTenantNotes((prev) => { const next = { ...prev }; delete next[revisionId]; return next; });
                    }
                  }}
                  onBatchAccept={handleBatchAccept}
                  onBatchDismiss={handleBatchDismiss}
                />
              ) : (
                <>
                  {(['structural', 'conceptual', 'feature', 'line-edit'] as const).map((type) => {
                    const group = proposedRevisions.filter(r => r.revisionType === type);
                    if (group.length === 0) return null;
                    return (
                      <div key={type} className={styles.revisionGroup}>
                        <p className={styles.revisionGroupLabel}>{labels.pulseCheck.revisionTypeLabels[type]}</p>
                        <BatchActionControls
                          revisionType={type}
                          revisionIds={group.map(r => r.revisionId)}
                          onBatchAccept={handleBatchAccept}
                          onBatchDismiss={handleBatchDismiss}
                          onUndo={handleBatchUndo}
                        />
                        <ul className={styles.themeDecisionList}>
                          {group.map((revision) => {
                            const decided = decisions[revision.revisionId] ?? null;
                            const sourceCount = revision.sourceThemeIds?.length ?? 1;
                            return (
                              <li
                                key={revision.revisionId}
                                className={styles.themeDecisionRow}
                                data-decided={decided ?? undefined}
                              >
                                <div className={styles.themeDecisionHeader}>
                                  <p className={styles.themeDecisionText}>{revision.proposal}</p>
                                  <RevisionWeightIndicator count={sourceCount} total={pc.sessionCount} />
                                  <div className={styles.themeDecisionBody}>
                                    <p className={styles.themeDecisionMeta}>{revision.rationale}</p>
                                    <FeedbackActionPills
                                      value={decided}
                                      onChange={(action) => {
                                        setDecisions((prev) => ({ ...prev, [revision.revisionId]: action }));
                                        if (action !== 'adjust') {
                                          setTenantNotes((prev) => { const next = { ...prev }; delete next[revision.revisionId]; return next; });
                                        }
                                      }}
                                      ariaLabel={`Decision for: ${revision.proposal}`}
                                      noteValue={tenantNotes[revision.revisionId] ?? ''}
                                      onNoteChange={(note) => setTenantNotes((prev) => ({ ...prev, [revision.revisionId]: note }))}
                                    />
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </>
              )}

              <div className={styles.saveRow}>
                <button
                  type="button"
                  className={styles.saveButton}
                  onClick={handleSaveDecisions}
                  disabled={saveStatus === 'saving' || Object.keys(decisions).length === 0 || shallowRecordEqual(decisions, savedDecisionsRef.current)}
                >
                  {saveStatus === 'saving' ? labels.pulseCheck.savingDecisions : labels.pulseCheck.saveDecisionsButton}
                </button>
                {saveStatus === 'saved' && (
                  <span className={styles.saveSuccess} aria-live="polite">{labels.pulseCheck.decisionsSaved}</span>
                )}
                {saveStatus === 'error' && (
                  <span className={styles.saveError} role="alert" aria-live="polite">{saveErrorMsg}</span>
                )}
              </div>

              {hasPersistedActionableDecision && (
                <div className={styles.revisionCtaRow}>
                  <Link to={`/admin/items/${itemId}/revisions`} className={styles.revisionCta}>
                    {labels.pulseCheck.viewRevisions}
                  </Link>
                </div>
              )}
            </>
          )}
        </section>

        <PulseCheckFeedback itemId={itemId!} existingFeedback={(pc as unknown as { pulseCheckFeedback?: { rating?: string; reason?: string } }).pulseCheckFeedback} />

        <p className={styles.retentionNotice}>{labels.retention.shortNotice}</p>
        <p className={styles.meta}>
          {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}
        </p>
      </div>
    </>
  );
}
