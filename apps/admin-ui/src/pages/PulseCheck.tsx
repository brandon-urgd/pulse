import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { useAuthedMutation, authedMutate } from '../hooks/useAuthedMutation';
import { useNavigate } from 'react-router-dom';
import { labels } from '../config/labels-registry';
import SignalBadge, { type EnergyLevel } from '../components/SignalBadge';
import SignalMatrix, { type ThemeRow, type ReviewerColumn } from '../components/SignalMatrix';
import FeedbackActionPills, { type FeedbackAction } from '../components/FeedbackActionPills';
import PulseCheckOverlay from '../components/PulseCheckOverlay';
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
}

interface PulseCheckResponse {
  data: PulseCheck;
}

interface ItemResponse {
  data: { itemId: string; itemName: string; sessionCount: number; status: string; description: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function PulseCheck() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [decisions, setDecisions] = useState<Record<string, FeedbackAction>>({});
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

  const { data: itemResp } = useAuthedQuery<ItemResponse>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: Boolean(itemId) }
  );
  const itemName = itemResp?.data?.itemName ?? '';
  const itemStatus = itemResp?.data?.status ?? '';
  const itemDescription = itemResp?.data?.description ?? '';

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
  const newlyCompletedCount = (() => {
    if (!pc?.generatedAt || !sessionsResp?.data) return 0;
    return sessionsResp.data.filter(
      s => s.status === 'completed' && s.completedAt && s.completedAt > pc.generatedAt
    ).length;
  })();

  useEffect(() => {
    if (pc?.decisions) {
      const synced: Record<string, FeedbackAction> = {};
      for (const [revisionId, d] of Object.entries(pc.decisions)) {
        const action = d.action.toLowerCase();
        // map legacy 'override'/'revise' to current action names
        const mapped = action === 'override' ? 'dismiss' : action === 'revise' ? 'adjust' : action;
        synced[revisionId] = mapped as FeedbackAction;
      }
      setDecisions(synced);
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
        payload[themeId] = { action: actionToApi[action] ?? action.charAt(0).toUpperCase() + action.slice(1) };
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

  const isRerunPending = generateMutation.isPending;

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
          <h1 className={styles.heading}>
            {itemName
              ? labels.pulseCheck.itemHeading.replace('{itemName}', itemName)
              : labels.pulseCheck.heading}
          </h1>
          {IncompleteNotice}
          {NewSessionsBanner}

          {(() => {
            // Verdict color based on verdict text sentiment, not energy
            const v = verdict.toLowerCase();
            const isPositive = v.includes('ready') || v.includes('strong') || v.includes('solid') || v.includes('good');
            const isNegative = v.includes('not there') || v.includes('needs work') || v.includes('not ready') || v.includes('weak') || v.includes('gaps');
            const verdictColorClass = isNegative ? styles.verdictBlockResistant : isPositive ? '' : styles.verdictBlockNeutral;
            return (
              <div className={`${styles.verdictBlock} ${verdictColorClass}`}>
                <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
                <p className={styles.verdictText}>{verdict}</p>
                {narrative && <p className={styles.verdictNarrative}>{narrative}</p>}
                <div className={styles.energyRow}>
                  <span className={styles.energyLabel}>{labels.pulseCheck.energyLabel}</span>
                  <SignalBadge variant={energy} />
                </div>
              </div>
            );
          })()}

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
                      <li key={i} className={styles.quoteItem}>"{rs.quote}"</li>
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
                      <ul className={styles.themeDecisionList}>
                        {group.map((revision) => {
                          const decided = decisions[revision.revisionId] ?? null;
                          return (
                            <li
                              key={revision.revisionId}
                              className={styles.themeDecisionRow}
                              data-decided={decided ?? undefined}
                            >
                              <div className={styles.themeDecisionHeader}>
                                <p className={styles.themeDecisionText}>{revision.proposal}</p>
                                <div className={styles.themeDecisionBody}>
                                  <p className={styles.themeDecisionMeta}>{revision.rationale}</p>
                                  <FeedbackActionPills
                                    value={decided}
                                    onChange={(action) => setDecisions((prev) => ({ ...prev, [revision.revisionId]: action }))}
                                    ariaLabel={`Decision for: ${revision.proposal}`}
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
                    disabled={saveStatus === 'saving' || Object.keys(decisions).length === 0 || JSON.stringify(decisions) === JSON.stringify(savedDecisionsRef.current)}
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
              </>
            )}
          </section>

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
        <h1 className={styles.heading}>
          {itemName
            ? labels.pulseCheck.itemHeading.replace('{itemName}', itemName)
            : labels.pulseCheck.heading}
        </h1>
        {IncompleteNotice}
        {NewSessionsBanner}

        {/* Verdict + narrative — above everything else */}
        {(() => {
          const v = synthesizedVerdict.toLowerCase();
          const isPositive = v.includes('ready') || v.includes('strong') || v.includes('solid') || v.includes('good');
          const isNegative = v.includes('not there') || v.includes('needs work') || v.includes('not ready') || v.includes('weak') || v.includes('gaps');
          const verdictColorClass = isNegative ? styles.verdictBlockResistant : isPositive ? '' : styles.verdictBlockNeutral;
          return (
            <div className={`${styles.verdictBlock} ${verdictColorClass}`}>
              <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
              <p className={styles.verdictText}>{synthesizedVerdict}</p>
              {narrative && <p className={styles.verdictNarrative}>{narrative}</p>}
              <p className={styles.verdictSessionCount}>
                {labels.pulseCheck.basedOnSessions
                  .replace('{count}', String(pc.sessionCount))
                  .replace('{plural}', pc.sessionCount === 1 ? '' : 's')}
              </p>
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

        {themeRows.length > 0 && reviewerCols.length > 0 && (
          <section className={styles.matrixSection} aria-labelledby="matrix-heading">
            <h2 id="matrix-heading" className={styles.matrixHeading}>{labels.pulseCheck.matrixHeading}</h2>
            <div className={styles.matrixScroll}>
              <SignalMatrix themes={themeRows} reviewers={reviewerCols} ariaLabel={labels.pulseCheck.matrixAriaLabel} />
            </div>
          </section>
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
                {sharedConvictions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
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
                {repeatedTensions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
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
                {openQuestions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noQuestions}</p>
            )}
          </section>
        </section>

        {/* Proposed Revisions — grouped by type */}
        <section aria-labelledby="decisions-heading" className={styles.decisionsSection}>
          <h2 id="decisions-heading" className={styles.synthesisHeading}>{labels.pulseCheck.decisionsHeading}</h2>
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
                    <ul className={styles.themeDecisionList}>
                      {group.map((revision) => {
                        const decided = decisions[revision.revisionId] ?? null;
                        return (
                          <li
                            key={revision.revisionId}
                            className={styles.themeDecisionRow}
                            data-decided={decided ?? undefined}
                          >
                            <div className={styles.themeDecisionHeader}>
                              <p className={styles.themeDecisionText}>{revision.proposal}</p>
                              <div className={styles.themeDecisionBody}>
                                <p className={styles.themeDecisionMeta}>{revision.rationale}</p>
                                <FeedbackActionPills
                                  value={decided}
                                  onChange={(action) => setDecisions((prev) => ({ ...prev, [revision.revisionId]: action }))}
                                  ariaLabel={`Decision for: ${revision.proposal}`}
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
                  disabled={saveStatus === 'saving' || Object.keys(decisions).length === 0 || JSON.stringify(decisions) === JSON.stringify(savedDecisionsRef.current)}
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
            </>
          )}
        </section>

        <p className={styles.meta}>
          {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}
        </p>
      </div>
    </>
  );
}
