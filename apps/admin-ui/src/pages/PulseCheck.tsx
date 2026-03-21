import { useEffect, useState } from 'react';
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
  sourceThemeIds: string[];
}

interface PulseCheck {
  itemId: string;
  verdict: string;
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
  status: 'generating' | 'complete';
}

interface PulseCheckResponse {
  data: PulseCheck;
}

interface ItemResponse {
  data: { itemId: string; itemName: string; sessionCount: number; status: string };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMatrixData(
  themes: PulseCheckTheme[],
  reviewerVerdicts: ReviewerVerdict[]
): { themeRows: ThemeRow[]; reviewerCols: ReviewerColumn[] } {
  const reviewerCols: ReviewerColumn[] = reviewerVerdicts.map((rv, i) => ({
    reviewerId: rv.sessionId,
    name: rv.isSelfReview ? 'Self-review' : `Reviewer ${i + 1}`,
    verdict: rv.verdict,
    energy: rv.energy,
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

  const { data: pcResp, isLoading, isError, refetch } = useAuthedQuery<PulseCheckResponse>(
    ['pulse-check', itemId],
    `/api/manage/items/${itemId}/pulse-check`,
    { enabled: Boolean(itemId), retry: false }
  );
  const pc = pcResp?.data;

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
        // map legacy 'override' to 'dismiss' for backwards compat
        synced[revisionId] = (action === 'override' ? 'dismiss' : action) as FeedbackAction;
      }
      setDecisions(synced);
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
        setOverlayDone(true);
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
    const payload: Record<string, { action: string; tenantNote?: string }> = {};
    for (const [themeId, action] of Object.entries(decisions)) {
      if (action !== null) {
        payload[themeId] = { action: action.charAt(0).toUpperCase() + action.slice(1) };
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
          <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
          {itemName && <p className={styles.subheading}>{itemName}</p>}

          <div className={styles.generatePrompt}>
            {itemIsActive ? (
              <>
                <p className={styles.generatePromptText}>{labels.pulseCheck.closeAndRunPromptText}</p>
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

  const isRerunPending = generateMutation.isPending;
  const RerunFooter = (
    <div className={newlyCompletedCount > 0 ? styles.rerunBanner : styles.rerunRow}>
      {newlyCompletedCount > 0 ? (
        <p className={styles.rerunBannerText}>
          {labels.pulseCheck.newSessionsNotice.replace('{count}', String(newlyCompletedCount))}
        </p>
      ) : (
        <p className={styles.rerunNote}>{labels.pulseCheck.rerunNote}</p>
      )}
      <button
        type="button"
        className={newlyCompletedCount > 0 ? styles.rerunBannerButton : styles.rerunButton}
        onClick={() => { setRerunError(''); showOverlay(); generateMutation.mutate(undefined); }}
        disabled={isRerunPending}
      >
        {isRerunPending ? labels.pulseCheck.generating : labels.pulseCheck.rerunButton}
      </button>
      {rerunError && (
        <p className={styles.error} role="alert" aria-live="polite">{rerunError}</p>
      )}
    </div>
  );

  // ── Single-session view ─────────────────────────────────────────────────────
  if (!isMultiSession) {
    const singleReviewer = pc.reviewerVerdicts?.[0];
    const verdict = pc.verdict ?? labels.pulseCheck.noVerdict;
    const energy = singleReviewer?.energy ?? 'neutral';
    const convictions = pc.sharedConviction ?? [];
    const tensions = pc.repeatedTension ?? [];
    const questions = pc.openQuestions ?? [];

    return (
      <>
        {Overlay}
        <div className={styles.container}>
          <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
            ← {labels.pulseCheck.backToItem}
          </Link>
          <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
          {itemName && <p className={styles.subheading}>{itemName}</p>}
          {IncompleteNotice}

          <div className={styles.verdictBlock}>
            <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
            <p className={styles.verdictText}>{verdict}</p>
            <div className={styles.energyRow}>
              <span className={styles.energyLabel}>{labels.pulseCheck.energyLabel}</span>
              <SignalBadge variant={energy} />
            </div>
          </div>

          <section className={styles.section} aria-labelledby="pc-convictions-heading">
            <h2 id="pc-convictions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="conviction" />
              {labels.pulseCheck.convictionsHeading}
            </h2>
            {convictions.length > 0 ? (
              <ul className={styles.quoteList}>
                {convictions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noConvictions}</p>
            )}
          </section>

          <section className={styles.section} aria-labelledby="pc-tensions-heading">
            <h2 id="pc-tensions-heading" className={styles.sectionHeading}>
              <SignalBadge variant="tension" />
              {labels.pulseCheck.tensionsHeading}
            </h2>
            {tensions.length > 0 ? (
              <ul className={styles.quoteList}>
                {tensions.map((q, i) => <li key={i} className={styles.quoteItem}>{q}</li>)}
              </ul>
            ) : (
              <p className={styles.emptySection}>{labels.pulseCheck.noTensions}</p>
            )}
          </section>

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

          <p className={styles.meta}>
            {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString())}
          </p>
          {RerunFooter}
        </div>
      </>
    );
  }

  // ── Multi-session view ──────────────────────────────────────────────────────
  const reviewerVerdicts = pc.reviewerVerdicts ?? [];
  const { themeRows, reviewerCols } = buildMatrixData(pc.themes ?? [], reviewerVerdicts);
  const synthesizedVerdict = pc.verdict ?? labels.pulseCheck.noVerdict;
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
        <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
        {itemName && <p className={styles.subheading}>{itemName}</p>}
        {IncompleteNotice}

        {themeRows.length > 0 && reviewerCols.length > 0 && (
          <section className={styles.matrixSection} aria-labelledby="matrix-heading">
            <h2 id="matrix-heading" className={styles.matrixHeading}>{labels.pulseCheck.matrixHeading}</h2>
            <SignalMatrix themes={themeRows} reviewers={reviewerCols} ariaLabel={labels.pulseCheck.matrixAriaLabel} />
          </section>
        )}

        <section className={styles.synthesisSection} aria-labelledby="synthesis-heading">
          <h2 id="synthesis-heading" className={styles.synthesisHeading}>{labels.pulseCheck.synthesisHeading}</h2>

          <div className={styles.verdictBlock}>
            <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
            <p className={styles.verdictText}>{synthesizedVerdict}</p>
          </div>

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

        {proposedRevisions.length > 0 && (
          <section aria-labelledby="decisions-heading" className={styles.decisionsSection}>
            <h2 id="decisions-heading" className={styles.synthesisHeading}>{labels.pulseCheck.decisionsHeading}</h2>
            <p className={styles.decisionsHint}>{labels.pulseCheck.decisionsHint}</p>
            <ul className={styles.themeDecisionList}>
              {proposedRevisions.map((revision) => (
                <li key={revision.revisionId} className={styles.themeDecisionRow}>
                  <div className={styles.themeDecisionHeader}>
                    <div style={{ flex: 1 }}>
                      <p className={styles.themeDecisionText}>{revision.proposal}</p>
                      <p className={styles.themeDecisionMeta}>{revision.rationale}</p>
                    </div>
                    <FeedbackActionPills
                      value={decisions[revision.revisionId] ?? null}
                      onChange={(action) => setDecisions((prev) => ({ ...prev, [revision.revisionId]: action }))}
                      ariaLabel={`Decision for: ${revision.proposal}`}
                    />
                  </div>
                </li>
              ))}
            </ul>

            <div className={styles.saveRow}>
              <button
                type="button"
                className={styles.saveButton}
                onClick={handleSaveDecisions}
                disabled={saveStatus === 'saving'}
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
          </section>
        )}

        <p className={styles.meta}>
          {labels.pulseCheck.generatedAt.replace('{date}', new Date(pc.generatedAt).toLocaleString())}
        </p>
        {RerunFooter}
      </div>
    </>
  );
}
