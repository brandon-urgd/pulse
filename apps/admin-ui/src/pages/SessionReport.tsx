import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { labels } from '../config/labels-registry';
import SignalBadge, { type EnergyLevel } from '../components/SignalBadge';
import styles from './SessionReport.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type OverallSentiment = 'positive' | 'mixed' | 'negative';

interface ReportSection {
  sectionName: string;
  sentiment: string;
  quotes: string[];
  suggestions: string[];
  concerns: string[];
}

interface Report {
  sessionId: string;
  itemId: string;
  sections: ReportSection[];
  overallSentiment: OverallSentiment;
  generatedAt: string;
  /** Optional one-line verdict synthesized by Bedrock */
  verdict?: string;
  /** Optional energy level */
  energy?: EnergyLevel;
}

interface ReportResponse {
  data: Report;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a one-line verdict from the report when the API doesn't provide one.
 * Uses overallSentiment as a fallback.
 */
function deriveVerdict(report: Report): string {
  if (report.verdict) return report.verdict;
  switch (report.overallSentiment) {
    case 'positive': return 'Overall positive — reviewer found strong conviction in the work.';
    case 'negative': return 'Overall critical — reviewer raised significant concerns.';
    default: return 'Mixed signals — conviction and tension present in roughly equal measure.';
  }
}

/**
 * Derive energy level from sentiment when not explicitly provided.
 */
function deriveEnergy(report: Report): EnergyLevel {
  if (report.energy) return report.energy;
  switch (report.overallSentiment) {
    case 'positive': return 'engaged';
    case 'negative': return 'resistant';
    default: return 'neutral';
  }
}

/**
 * Collect all quotes (conviction items) from sections.
 */
function collectConvictions(sections: ReportSection[]): string[] {
  return sections.flatMap((s) => s.quotes ?? []);
}

/**
 * Collect all concerns (tension items) from sections.
 */
function collectTensions(sections: ReportSection[]): string[] {
  return sections.flatMap((s) => s.concerns ?? []);
}

/**
 * Collect all suggestions (uncertainty / open questions) from sections.
 */
function collectUncertainties(sections: ReportSection[]): string[] {
  return sections.flatMap((s) => s.suggestions ?? []);
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Per-session feedback report view.
 * Organized by signal type: Verdict → What Landed → Where It Struggled → Open Questions → Energy.
 * Accessible from ItemDetail session list.
 * Requirements: 7.2
 */
export default function SessionReport() {
  const { itemId, sessionId } = useParams<{ itemId: string; sessionId: string }>();

  const { data, isLoading, isError } = useAuthedQuery<ReportResponse>(
    ['report', itemId, sessionId],
    `/api/manage/items/${itemId}/sessions/${sessionId}/report`,
    { enabled: Boolean(itemId && sessionId) }
  );

  const report = data?.data;

  // ── Document title ──────────────────────────────────────────────────────────
  useEffect(() => {
    document.title = report
      ? labels.sessionReport.documentTitle
      : labels.sessionReport.documentTitleLoading;
  }, [report]);

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading} aria-busy="true">
          {labels.sessionReport.loading}
        </p>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────────
  if (isError || !report) {
    return (
      <div className={styles.container}>
        <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
          ← {labels.sessionReport.backToItem}
        </Link>
        <p className={styles.error} role="alert" aria-live="polite">
          {labels.sessionReport.loadError}
        </p>
      </div>
    );
  }

  const verdict = deriveVerdict(report);
  const energy = deriveEnergy(report);
  const convictions = collectConvictions(report.sections);
  const tensions = collectTensions(report.sections);
  const uncertainties = collectUncertainties(report.sections);

  return (
    <div className={styles.container}>
      {/* Back link */}
      <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
        ← {labels.sessionReport.backToItem}
      </Link>

      {/* ── Verdict ── */}
      <div className={styles.verdictBlock}>
        <p className={styles.verdictLabel}>{labels.sessionReport.verdictLabel}</p>
        <p className={styles.verdictText}>{verdict}</p>
        <div className={styles.energyRow}>
          <span className={styles.energyLabel}>{labels.sessionReport.energyLabel}</span>
          <SignalBadge variant={energy} />
        </div>
      </div>

      {/* ── What Landed (Conviction) ── */}
      <section className={styles.section} aria-labelledby="convictions-heading">
        <h2 id="convictions-heading" className={styles.sectionHeading}>
          <SignalBadge variant="conviction" />
          {labels.sessionReport.convictionsHeading}
        </h2>
        {convictions.length > 0 ? (
          <ul className={styles.quoteList}>
            {convictions.map((q, i) => (
              <li key={i} className={styles.quoteItem}>{q}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptySection}>{labels.sessionReport.noConvictions}</p>
        )}
      </section>

      {/* ── Where It Struggled (Tension) ── */}
      <section className={styles.section} aria-labelledby="tensions-heading">
        <h2 id="tensions-heading" className={styles.sectionHeading}>
          <SignalBadge variant="tension" />
          {labels.sessionReport.tensionsHeading}
        </h2>
        {tensions.length > 0 ? (
          <ul className={styles.quoteList}>
            {tensions.map((q, i) => (
              <li key={i} className={styles.quoteItem}>{q}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptySection}>{labels.sessionReport.noTensions}</p>
        )}
      </section>

      {/* ── Open Questions (Uncertainty) ── */}
      <section className={styles.section} aria-labelledby="uncertainties-heading">
        <h2 id="uncertainties-heading" className={styles.sectionHeading}>
          <SignalBadge variant="uncertainty" />
          {labels.sessionReport.uncertaintiesHeading}
        </h2>
        {uncertainties.length > 0 ? (
          <ul className={styles.quoteList}>
            {uncertainties.map((q, i) => (
              <li key={i} className={styles.quoteItem}>{q}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptySection}>{labels.sessionReport.noUncertainties}</p>
        )}
      </section>

      {/* Meta */}
      <p className={styles.meta}>
        {labels.sessionReport.generatedAt.replace(
          '{date}',
          new Date(report.generatedAt).toLocaleString()
        )}
      </p>
    </div>
  );
}
