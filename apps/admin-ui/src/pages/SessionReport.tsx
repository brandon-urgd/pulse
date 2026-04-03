import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuthedQuery } from '../hooks/useAuthedQuery';
import { labels } from '../config/labels-registry';
import { downloadPdf } from '../utils/downloadPdf';
import SignalBadge, { type EnergyLevel } from '../components/SignalBadge';
import styles from './SessionReport.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Report {
  sessionId: string;
  itemId: string;
  verdict: string;
  conviction: string[];
  tension: string[];
  uncertainty: string[];
  energy: EnergyLevel;
  conversationShape: string;
  themes: string[];
  isSelfReview: boolean;
  generatedAt: string;
}

interface ReportResponse {
  data: Report;
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
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const pdfContentRef = useRef<HTMLDivElement>(null);

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

  const verdict = report.verdict;
  const energy = report.energy;
  const convictions = report.conviction;
  const tensions = report.tension;
  const uncertainties = report.uncertainty;

  async function handleDownloadPdf() {
    if (!pdfContentRef.current || pdfGenerating) return;
    setPdfGenerating(true);
    try {
      await downloadPdf(pdfContentRef.current, 'Session Report');
    } catch { /* silently fail */ }
    finally { setPdfGenerating(false); }
  }

  return (
    <div className={styles.container} ref={pdfContentRef}>
      {/* Back link */}
      <Link to={`/admin/items/${itemId}`} className={styles.backLink}>
        ← {labels.sessionReport.backToItem}
      </Link>

      {/* ── Pulse eyebrow + PDF button ── */}
      <div className={styles.headingRow}>
        <p className={styles.pulseEyebrow}>
          {labels.sessionReport.pulseFromReviewer.replace(
            '{reviewerLabel}',
            report.isSelfReview ? 'Self-review' : 'Reviewer'
          )}
        </p>
        <button
          type="button"
          className={styles.downloadPdfButton}
          onClick={handleDownloadPdf}
          disabled={pdfGenerating}
        >
          {pdfGenerating ? labels.sessionReport.downloadingPdf : labels.sessionReport.downloadPdf}
        </button>
      </div>

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
