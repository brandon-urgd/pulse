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
import styles from './PulseCheck.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeedbackPoint {
  feedbackPointId: string;
  section: string;
  text: string;
  agreementLevel: string;
  reviewerCount: number;
}

interface Decision {
  feedbackPointId: string;
  action: Exclude<FeedbackAction, null>;
  tenantNote?: string;
}

interface PulseCheckTheme {
  themeId: string;
  theme: string;
  /** Per-reviewer signals keyed by reviewerId */
  signals?: Record<string, { signal: 'conviction' | 'tension' | 'uncertainty'; quote: string }>;
  /** Aggregate signal type for single-session view */
  signal?: 'conviction' | 'tension' | 'uncertainty';
  quotes?: string[];
}

interface ReviewerSummary {
  reviewerId: string;
  name: string;
  verdict: string;
  energy: EnergyLevel;
}

interface AggregateSummary {
  themes: PulseCheckTheme[];
  agreementDistribution: Record<string, number>;
  feedbackPoints: FeedbackPoint[];
  /** Synthesized verdict (multi-session) */
  verdict?: string;
  /** Shared convictions */
  sharedConvictions?: string[];
  /** Repeated tensions */
  repeatedTensions?: string[];
  /** Open questions */
  openQuestions?: string[];
  /** Per-reviewer summaries (multi-session) */
  reviewers?: ReviewerSummary[];
  /** Single-session energy */
  energy?: EnergyLevel;
  /** Single-session one-line verdict */
  singleVerdict?: string;
}

interface PulseCheck {
  itemId: string;
  aggregateSummary: AggregateSummary;
  feedbackPoints: FeedbackPoint[];
  decisions: Record<string, { action: string; tenantNote?: string; decidedAt: string }>;
  sessionCount: number;
  incompleteCount?: number;
  generatedAt: string;
  status: 'generating' | 'complete';
}

interface PulseCheckResponse {
  data: PulseCheck;
}

interface ItemResponse {
  data: { itemId: string; itemName: string; sessionCount: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildMatrixData(
  themes: PulseCheckTheme[],
  reviewers: ReviewerSummary[]
): { themeRows: ThemeRow[]; reviewerCols: ReviewerColumn[] } {
  const reviewerCols: ReviewerColumn[] = reviewers.map((r) => ({
    reviewerId: r.reviewerId,
    name: r.name,
    verdict: r.verdict,
    energy: r.energy,
  }));

  const themeRows: ThemeRow[] = themes.map((t) => ({
    themeId: t.themeId,
    theme: t.theme,
    signals: t.signals ?? {},
  }));

  return { themeRows, reviewerCols };
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Pulse Check page — single-session and multi-session views.
 * Calls POST to generate or GET to load existing pulse check.
 * Multi-session: SignalMatrix + synthesized verdict + FeedbackActionPills per theme.
 * Single-session: Verdict → What Landed → Where It Struggled → Open Questions → Energy.
 * Requirements: 7.4, 7.5, 7.6, 7.7, 7.10
 */
export default function PulseCheck() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Decisions state: feedbackPointId → action
  const [decisions, setDecisions] = useState<Record<string, FeedbackAction>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErrorMsg, setSaveErrorMsg] = useState('');
  const [generateError, setGenerateError] = useState('');
  const [conflictError, setConflictError] = useState('');

  // ── Load item (for name) ────────────────────────────────────────────────────
  const { data: itemResp } = useAuthedQuery<ItemResponse>(
    ['item', itemId],
    `/api/manage/items/${itemId}`,
    { enabled: Boolean(itemId) }
  );
  const itemName = itemResp?.data?.itemName ?? '';

  // ── Load existing pulse check ───────────────────────────────────────────────
  const {
    data: pcResp,
    isLoading,
    isError,
    refetch,
  } = useAuthedQuery<PulseCheckResponse>(
    ['pulse-check', itemId],
    `/api/manage/items/${itemId}/pulse-check`,
    { enabled: Boolean(itemId), retry: false }
  );
  const pc = pcResp?.data;

  // ── Sync decisions from loaded pulse check ──────────────────────────────────
  useEffect(() => {
    if (pc?.decisions) {
      const synced: Record<string, FeedbackAction> = {};
      for (const [id, d] of Object.entries(pc.decisions)) {
        synced[id] = d.action as FeedbackAction;
      }
      setDecisions(synced);
    }
  }, [pc]);

  // ── Document title ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.title = itemName
      ? labels.pulseCheck.documentTitle.replace('{itemName}', itemName)
      : labels.pulseCheck.documentTitleDefault;
  }, [itemName]);

  // ── Generate mutation ───────────────────────────────────────────────────────
  const generateMutation = useAuthedMutation<PulseCheckResponse, undefined>(
    `/api/manage/items/${itemId}/pulse-check`,
    'POST',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['pulse-check', itemId] });
        refetch();
        setGenerateError('');
        setConflictError('');
      },
      onError: (err) => {
        const status = (err as Error & { status?: number }).status;
        if (status === 409) {
          setConflictError(labels.pulseCheck.sessionsStillOpenError);
        } else {
          setGenerateError(labels.pulseCheck.generateError);
        }
      },
    }
  );

  // ── Save decisions ──────────────────────────────────────────────────────────
  async function handleSaveDecisions() {
    setSaveStatus('saving');
    setSaveErrorMsg('');

    const payload: Decision[] = Object.entries(decisions)
      .filter(([, action]) => action !== null)
      .map(([feedbackPointId, action]) => ({
        feedbackPointId,
        action: action as Exclude<FeedbackAction, null>,
      }));

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
      if (status === 409) {
        setSaveErrorMsg(labels.pulseCheck.sessionsStillOpenError);
      } else {
        setSaveErrorMsg(labels.pulseCheck.saveDecisionsError);
      }
      setSaveStatus('error');
    }
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading} aria-busy="true">
          {labels.pulseCheck.loading}
        </p>
      </div>
    );
  }

  // ── No pulse check yet — show generate prompt ───────────────────────────────
  if (isError || !pc) {
    return (
      <div className={styles.container}>
        <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
          ← {labels.pulseCheck.backToItem}
        </Link>
        <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
        {itemName && <p className={styles.subheading}>{itemName}</p>}

        {conflictError && (
          <div className={styles.conflictError} role="alert" aria-live="polite">
            {conflictError}
          </div>
        )}

        <div className={styles.generatePrompt}>
          <p className={styles.generatePromptText}>
            {labels.pulseCheck.generatePromptText}
          </p>
          <button
            type="button"
            className={styles.generateButton}
            onClick={() => generateMutation.mutate(undefined)}
            disabled={generateMutation.isPending}
          >
            {generateMutation.isPending
              ? labels.pulseCheck.generating
              : labels.pulseCheck.generateButton}
          </button>
          {generateError && (
            <p className={styles.error} role="alert" aria-live="polite">
              {generateError}
            </p>
          )}
        </div>
      </div>
    );
  }

  const isMultiSession = pc.sessionCount >= 2;
  const summary = pc.aggregateSummary;
  const incompleteCount = pc.incompleteCount ?? 0;

  // ── Incomplete sessions notice (shared across both views) ───────────────────
  const IncompleteNotice = incompleteCount > 0 ? (
    <p className={styles.incompleteNotice} role="note">
      {labels.pulseCheck.incompleteSessionsNotice
        .replace('{incomplete}', String(incompleteCount))
        .replace('{total}', String(pc.sessionCount))}
    </p>
  ) : null;

  // ── Single-session view ─────────────────────────────────────────────────────
  if (!isMultiSession) {
    const verdict = summary.singleVerdict ?? summary.verdict ?? labels.pulseCheck.noVerdict;
    const energy = summary.energy ?? 'neutral';
    const convictions = summary.sharedConvictions ?? [];
    const tensions = summary.repeatedTensions ?? [];
    const questions = summary.openQuestions ?? [];

    return (
      <div className={styles.container}>
        <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
          ← {labels.pulseCheck.backToItem}
        </Link>
        <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
        {itemName && <p className={styles.subheading}>{itemName}</p>}
        {IncompleteNotice}

        {/* Verdict */}
        <div className={styles.verdictBlock}>
          <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
          <p className={styles.verdictText}>{verdict}</p>
          <div className={styles.energyRow}>
            <span className={styles.energyLabel}>{labels.pulseCheck.energyLabel}</span>
            <SignalBadge variant={energy} />
          </div>
        </div>

        {/* What Landed */}
        <section className={styles.section} aria-labelledby="pc-convictions-heading">
          <h2 id="pc-convictions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="conviction" />
            {labels.pulseCheck.convictionsHeading}
          </h2>
          {convictions.length > 0 ? (
            <ul className={styles.quoteList}>
              {convictions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noConvictions}</p>
          )}
        </section>

        {/* Where It Struggled */}
        <section className={styles.section} aria-labelledby="pc-tensions-heading">
          <h2 id="pc-tensions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="tension" />
            {labels.pulseCheck.tensionsHeading}
          </h2>
          {tensions.length > 0 ? (
            <ul className={styles.quoteList}>
              {tensions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noTensions}</p>
          )}
        </section>

        {/* Open Questions */}
        <section className={styles.section} aria-labelledby="pc-questions-heading">
          <h2 id="pc-questions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="uncertainty" />
            {labels.pulseCheck.questionsHeading}
          </h2>
          {questions.length > 0 ? (
            <ul className={styles.quoteList}>
              {questions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noQuestions}</p>
          )}
        </section>

        <p className={styles.meta}>
          {labels.pulseCheck.generatedAt.replace(
            '{date}',
            new Date(pc.generatedAt).toLocaleString()
          )}
        </p>
      </div>
    );
  }

  // ── Multi-session view ──────────────────────────────────────────────────────
  const reviewers = summary.reviewers ?? [];
  const { themeRows, reviewerCols } = buildMatrixData(summary.themes ?? [], reviewers);
  const feedbackPoints = pc.feedbackPoints ?? [];
  const synthesizedVerdict = summary.verdict ?? labels.pulseCheck.noVerdict;
  const sharedConvictions = summary.sharedConvictions ?? [];
  const repeatedTensions = summary.repeatedTensions ?? [];
  const openQuestions = summary.openQuestions ?? [];

  return (
    <div className={styles.container}>
      <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
        ← {labels.pulseCheck.backToItem}
      </Link>
      <h1 className={styles.heading}>{labels.pulseCheck.heading}</h1>
      {itemName && <p className={styles.subheading}>{itemName}</p>}
      {IncompleteNotice}

      {/* ── Signal Matrix ── */}
      {themeRows.length > 0 && reviewerCols.length > 0 && (
        <section className={styles.matrixSection} aria-labelledby="matrix-heading">
          <h2 id="matrix-heading" className={styles.matrixHeading}>
            {labels.pulseCheck.matrixHeading}
          </h2>
          <SignalMatrix
            themes={themeRows}
            reviewers={reviewerCols}
            ariaLabel={labels.pulseCheck.matrixAriaLabel}
          />
        </section>
      )}

      {/* ── Synthesized verdict + signal sections ── */}
      <section className={styles.synthesisSection} aria-labelledby="synthesis-heading">
        <h2 id="synthesis-heading" className={styles.synthesisHeading}>
          {labels.pulseCheck.synthesisHeading}
        </h2>

        {/* Verdict */}
        <div className={styles.verdictBlock}>
          <p className={styles.verdictLabel}>{labels.pulseCheck.verdictLabel}</p>
          <p className={styles.verdictText}>{synthesizedVerdict}</p>
        </div>

        {/* Shared convictions */}
        <section className={styles.section} aria-labelledby="multi-convictions-heading">
          <h3 id="multi-convictions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="conviction" />
            {labels.pulseCheck.convictionsHeading}
          </h3>
          {sharedConvictions.length > 0 ? (
            <ul className={styles.quoteList}>
              {sharedConvictions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noConvictions}</p>
          )}
        </section>

        {/* Repeated tensions */}
        <section className={styles.section} aria-labelledby="multi-tensions-heading">
          <h3 id="multi-tensions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="tension" />
            {labels.pulseCheck.tensionsHeading}
          </h3>
          {repeatedTensions.length > 0 ? (
            <ul className={styles.quoteList}>
              {repeatedTensions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noTensions}</p>
          )}
        </section>

        {/* Open questions */}
        <section className={styles.section} aria-labelledby="multi-questions-heading">
          <h3 id="multi-questions-heading" className={styles.sectionHeading}>
            <SignalBadge variant="uncertainty" />
            {labels.pulseCheck.questionsHeading}
          </h3>
          {openQuestions.length > 0 ? (
            <ul className={styles.quoteList}>
              {openQuestions.map((q, i) => (
                <li key={i} className={styles.quoteItem}>{q}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptySection}>{labels.pulseCheck.noQuestions}</p>
          )}
        </section>
      </section>

      {/* ── Feedback decisions per theme ── */}
      {feedbackPoints.length > 0 && (
        <section aria-labelledby="decisions-heading">
          <h2 id="decisions-heading" className={styles.synthesisHeading}>
            {labels.pulseCheck.decisionsHeading}
          </h2>
          <ul className={styles.themeDecisionList}>
            {feedbackPoints.map((fp) => (
              <li key={fp.feedbackPointId} className={styles.themeDecisionRow}>
                <div className={styles.themeDecisionHeader}>
                  <div style={{ flex: 1 }}>
                    <p className={styles.themeDecisionText}>{fp.text}</p>
                    <p className={styles.themeDecisionMeta}>
                      {fp.reviewerCount} {fp.reviewerCount === 1 ? 'reviewer' : 'reviewers'} · {fp.section}
                    </p>
                  </div>
                  <FeedbackActionPills
                    value={decisions[fp.feedbackPointId] ?? null}
                    onChange={(action) =>
                      setDecisions((prev) => ({ ...prev, [fp.feedbackPointId]: action }))
                    }
                    ariaLabel={`Decision for: ${fp.text}`}
                  />
                </div>
              </li>
            ))}
          </ul>

          {/* Save decisions */}
          <div className={styles.saveRow}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleSaveDecisions}
              disabled={saveStatus === 'saving'}
            >
              {saveStatus === 'saving'
                ? labels.pulseCheck.savingDecisions
                : labels.pulseCheck.saveDecisionsButton}
            </button>
            {saveStatus === 'saved' && (
              <span className={styles.saveSuccess} aria-live="polite">
                {labels.pulseCheck.decisionsSaved}
              </span>
            )}
            {saveStatus === 'error' && (
              <span className={styles.saveError} role="alert" aria-live="polite">
                {saveErrorMsg}
              </span>
            )}
          </div>
        </section>
      )}

      <p className={styles.meta}>
        {labels.pulseCheck.generatedAt.replace(
          '{date}',
          new Date(pc.generatedAt).toLocaleString()
        )}
      </p>
    </div>
  );
}
