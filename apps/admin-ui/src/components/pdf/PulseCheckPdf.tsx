import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { PDF_COLORS, PDF_SIGNAL_STYLES, PDF_SIGNAL_TYPE_COLORS, PDF_FONTS } from '../../config/pdf-brand';
import { labels } from '../../config/labels-registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PulseCheckPdfData {
  verdict: string;
  narrative: string;
  themes: Array<{
    themeId: string;
    label: string;
    reviewerSignals: Array<{ sessionId?: string; signalType: string; quote: string }>;
  }>;
  sharedConviction: string[];
  repeatedTension: string[];
  openQuestions: string[];
  proposedRevisions: Array<{
    proposal: string;
    rationale: string;
    revisionType: string;
  }>;
  reviewerVerdicts: Array<{ sessionId?: string; verdict: string; energy: string; isSelfReview: boolean }>;
  sessionCount: number;
  generatedAt: string;
}

interface Props {
  data: PulseCheckPdfData;
  itemName: string;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    padding: 40,
    backgroundColor: PDF_COLORS.page,
    fontFamily: PDF_FONTS.body,
    fontSize: 10,
    color: PDF_COLORS.text,
  },
  // Header
  title: { fontSize: 24, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: '#1a1a1a' },
  dateLine: { fontSize: 9, color: PDF_COLORS.textMuted, marginTop: 4 },
  accentLine: { height: 1, backgroundColor: PDF_COLORS.accent, marginTop: 8, marginBottom: 24 },
  // Verdict
  verdictLabel: { fontSize: 9, color: PDF_COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  verdictText: { fontSize: 18, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: '#1a1a1a', marginTop: 4 },
  narrative: { fontSize: 11, color: PDF_COLORS.text, marginTop: 8 },
  metaLine: { fontSize: 9, color: PDF_COLORS.textMuted, marginTop: 8, marginBottom: 28 },
  // Signal section
  signalBlock: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, paddingRight: 10, marginBottom: 20 },
  signalHeading: { fontSize: 13, fontFamily: PDF_FONTS.heading, fontWeight: 700, marginBottom: 6 },
  bullet: { fontSize: 10, color: PDF_COLORS.text, marginBottom: 3, paddingLeft: 8 },
  // Themes
  sectionHeader: { fontSize: 16, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: PDF_COLORS.accent, marginTop: 16, marginBottom: 8 },
  themeLabel: { fontSize: 12, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: '#1a1a1a', marginBottom: 6 },
  themeGroup: { marginBottom: 12 },
  // Theme table
  tableRow: { flexDirection: 'row', marginBottom: 4 },
  tableColLeft: { width: 80 },
  tableColRight: { flex: 1 },
  signalTypeLabel: { fontSize: 10, fontFamily: PDF_FONTS.body, fontWeight: 500 },
  signalQuote: { fontSize: 10, color: PDF_COLORS.textSecondary },
  // Revisions
  revisionBlock: { marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: PDF_COLORS.border },
  revisionBlockLast: { marginBottom: 12, paddingBottom: 0, borderBottomWidth: 0 },
  revisionTypeBadge: { fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, color: PDF_COLORS.textMuted, marginBottom: 4 },
  revisionProposal: { fontSize: 11, fontFamily: PDF_FONTS.body, fontWeight: 500, color: '#1a1a1a' },
  revisionRationale: { fontSize: 10, color: PDF_COLORS.textMuted, paddingLeft: 12, marginTop: 4 },
  // Signal Matrix
  matrixHeader: { fontSize: 16, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: PDF_COLORS.accent, marginTop: 16, marginBottom: 8 },
  matrixRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: PDF_COLORS.border, paddingVertical: 4 },
  matrixHeaderRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: PDF_COLORS.accent, paddingBottom: 6, marginBottom: 4 },
  matrixThemeCol: { width: 120 },
  matrixReviewerCol: { flex: 1, paddingHorizontal: 4 },
  matrixReviewerName: { fontSize: 9, fontWeight: 700, color: PDF_COLORS.text },
  matrixReviewerMeta: { fontSize: 8, color: PDF_COLORS.textMuted },
  matrixCellQuote: { fontSize: 9, color: PDF_COLORS.textSecondary },
  matrixCellSignal: { fontSize: 8, fontWeight: 500 },
  matrixThemeLabel: { fontSize: 10, fontWeight: 500, color: PDF_COLORS.text },
  // Footer
  footer: { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between' },
  footerBrand: { fontSize: 8, color: PDF_COLORS.textMuted },
  footerPage: { fontSize: 8, color: PDF_COLORS.textMuted },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return iso;
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Signal Section Component ─────────────────────────────────────────────────

function SignalSection({ type, items }: { type: keyof typeof PDF_SIGNAL_STYLES; items: string[] }) {
  if (items.length === 0) return null;
  const cfg = PDF_SIGNAL_STYLES[type];
  return (
    <View
      style={[s.signalBlock, { borderLeftColor: cfg.border, backgroundColor: cfg.bg }]}
      wrap={false}
    >
      <Text style={[s.signalHeading, { color: cfg.heading }]}>
        {cfg.icon ? `${cfg.icon} ` : ''}{cfg.label}
      </Text>
      {items.map((item, i) => (
        <Text key={i} style={s.bullet}>• {item}</Text>
      ))}
    </View>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <View style={s.footer} fixed>
      <Text style={s.footerBrand}>© 2026 ur/gd Studios LLC. All rights reserved. | Pulse</Text>
      <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
    </View>
  );
}

// ─── Revision Grouping (matches in-browser RevisionGroups) ────────────────────

const REVISION_TYPE_LABELS: Record<string, string> = {
  structural: 'Structural',
  'line-edit': 'Line Edits',
  conceptual: 'Conceptual',
  feature: 'Features',
  other: 'Other',
};

const REVISION_GROUP_ORDER: string[] = ['structural', 'conceptual', 'feature', 'line-edit', 'other'];

function groupRevisionsByType(revisions: PulseCheckPdfData['proposedRevisions']) {
  const groups: Record<string, PulseCheckPdfData['proposedRevisions']> = {};
  for (const rev of revisions) {
    const type = rev.revisionType || 'other';
    const key = REVISION_GROUP_ORDER.includes(type) ? type : 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(rev);
  }
  return groups;
}

// ─── Signal Summary PDF Component (8+ sessions) ──────────────────────────────

function PdfSignalSummary({ data }: { data: PulseCheckPdfData }) {
  const reviewerCount = data.reviewerVerdicts.length || data.sessionCount;

  return (
    <View>
      <Text style={s.sectionHeader}>Signal Summary</Text>
      {data.themes.map((theme) => {
        // Aggregate signal counts
        let conviction = 0;
        let tension = 0;
        let uncertainty = 0;
        for (const sig of theme.reviewerSignals) {
          if (sig.signalType === 'conviction') conviction++;
          else if (sig.signalType === 'tension') tension++;
          else uncertainty++;
        }
        const flaggedCount = theme.reviewerSignals.length;
        const total = reviewerCount || 1;
        const convPct = (conviction / total) * 100;
        const tenPct = (tension / total) * 100;
        const uncPct = (uncertainty / total) * 100;
        const topQuotes = theme.reviewerSignals
          .map((sig) => sig.quote)
          .filter(Boolean)
          .slice(0, 3);

        return (
          <View key={theme.themeId} style={summaryStyles.themeCard} wrap={false}>
            <Text style={summaryStyles.themeName}>{theme.label}</Text>
            <Text style={summaryStyles.themeCount}>
              {flaggedCount} of {data.sessionCount} reviewers flagged this
            </Text>
            {/* Sentiment distribution bar — colored rectangles */}
            <View style={summaryStyles.sentimentRow}>
              {convPct > 0 && (
                <View style={[summaryStyles.barSegment, { width: `${convPct}%`, backgroundColor: '#7a9e87' }]} />
              )}
              {tenPct > 0 && (
                <View style={[summaryStyles.barSegment, { width: `${tenPct}%`, backgroundColor: '#d4a843' }]} />
              )}
              {uncPct > 0 && (
                <View style={[summaryStyles.barSegment, { width: `${uncPct}%`, backgroundColor: '#5b8db8' }]} />
              )}
            </View>
            <View style={summaryStyles.sentimentLegend}>
              {conviction > 0 && <Text style={summaryStyles.legendText}>● Conviction: {conviction}</Text>}
              {tension > 0 && <Text style={summaryStyles.legendText}>● Tension: {tension}</Text>}
              {uncertainty > 0 && <Text style={summaryStyles.legendText}>● Uncertainty: {uncertainty}</Text>}
            </View>
            {/* Top 3 quotes */}
            {topQuotes.length > 0 && (
              <View style={summaryStyles.quotesSection}>
                <Text style={summaryStyles.quotesHeading}>Top quotes</Text>
                {topQuotes.map((quote, i) => (
                  <Text key={i} style={summaryStyles.quoteText}>"{quote}"</Text>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function PdfGroupedRevisions({ revisions }: { revisions: PulseCheckPdfData['proposedRevisions'] }) {
  const groups = groupRevisionsByType(revisions);

  return (
    <View>
      <Text style={s.sectionHeader}>Proposed Revisions</Text>
      {REVISION_GROUP_ORDER.map((type) => {
        const group = groups[type];
        if (!group || group.length === 0) return null;
        const label = REVISION_TYPE_LABELS[type] ?? type;
        return (
          <View key={type} style={summaryStyles.revisionGroup}>
            <Text style={summaryStyles.revisionGroupHeader}>{label} ({group.length})</Text>
            {group.map((rev, i) => (
              <View
                key={i}
                style={i < group.length - 1 ? s.revisionBlock : s.revisionBlockLast}
                wrap={false}
              >
                <Text style={s.revisionProposal}>{rev.proposal}</Text>
                <Text style={s.revisionRationale}>{rev.rationale}</Text>
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  themeCard: {
    marginBottom: 16,
    padding: 12,
    backgroundColor: '#f8f9fa',
    borderRadius: 4,
    borderLeftWidth: 3,
    borderLeftColor: PDF_COLORS.accent,
  },
  themeName: {
    fontSize: 13,
    fontFamily: PDF_FONTS.heading,
    fontWeight: 700,
    color: '#1a1a1a',
    marginBottom: 4,
  },
  themeCount: {
    fontSize: 10,
    color: PDF_COLORS.textMuted,
    marginBottom: 8,
  },
  sentimentRow: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  barSegment: {
    height: 8,
  },
  sentimentLegend: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  legendText: {
    fontSize: 8,
    color: PDF_COLORS.textMuted,
  },
  quotesSection: {
    marginTop: 4,
  },
  quotesHeading: {
    fontSize: 9,
    color: PDF_COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  quoteText: {
    fontSize: 10,
    color: PDF_COLORS.textSecondary,
    marginBottom: 3,
    paddingLeft: 8,
  },
  revisionGroup: {
    marginBottom: 16,
  },
  revisionGroupHeader: {
    fontSize: 12,
    fontFamily: PDF_FONTS.heading,
    fontWeight: 700,
    color: PDF_COLORS.accent,
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: PDF_COLORS.border,
  },
});

// ─── Signal Matrix Component ──────────────────────────────────────────────────

function PdfSignalMatrix({ data }: { data: PulseCheckPdfData }) {
  const reviewerCount = data.reviewerVerdicts.length;
  const isScaled = reviewerCount >= 4;
  const isOverflow = reviewerCount >= 8;

  const reviewers = data.reviewerVerdicts.map((rv, i) => ({
    sessionId: rv.sessionId,
    name: rv.isSelfReview ? 'Self-review' : `Reviewer ${i + 1}`,
    verdict: rv.verdict,
    energy: rv.energy,
  }));

  // Dynamic styles based on reviewer count
  const themeColStyle = isScaled
    ? { ...s.matrixThemeCol, width: 90 }
    : s.matrixThemeCol;
  const reviewerNameStyle = isScaled
    ? { ...s.matrixReviewerName, fontSize: 8 }
    : s.matrixReviewerName;
  const cellSignalStyle = isScaled
    ? { ...s.matrixCellSignal, fontSize: 7 }
    : s.matrixCellSignal;
  const cellQuoteStyle = isScaled
    ? { ...s.matrixCellQuote, fontSize: 8 }
    : s.matrixCellQuote;
  const themeLabelStyle = isScaled
    ? { ...s.matrixThemeLabel, fontSize: 9 }
    : s.matrixThemeLabel;

  return (
    <View wrap={isOverflow}>
      <Text style={s.matrixHeader}>Signal Matrix</Text>
      {/* Header row — fixed for multi-page overflow at 8+ reviewers */}
      <View style={s.matrixHeaderRow} fixed={isOverflow}>
        <View style={themeColStyle}>
          <Text style={reviewerNameStyle}>Theme</Text>
        </View>
        {reviewers.map((r, i) => (
          <View key={i} style={s.matrixReviewerCol}>
            <Text style={reviewerNameStyle}>{r.name}</Text>
            <Text style={s.matrixReviewerMeta}>{r.energy}</Text>
          </View>
        ))}
      </View>
      {/* Body rows */}
      {data.themes.map((theme) => (
        <View key={theme.themeId} style={s.matrixRow}>
          <View style={themeColStyle}>
            <Text style={themeLabelStyle}>{theme.label}</Text>
          </View>
          {reviewers.map((r, ri) => {
            const signal = theme.reviewerSignals.find(rs => rs.sessionId === r.sessionId);
            return (
              <View key={ri} style={s.matrixReviewerCol}>
                {signal ? (
                  <>
                    <Text style={[cellSignalStyle, { color: PDF_SIGNAL_TYPE_COLORS[signal.signalType] ?? '#6c757d' }]}>
                      {capitalize(signal.signalType)}
                    </Text>
                    <Text style={cellQuoteStyle}>"{signal.quote}"</Text>
                  </>
                ) : (
                  <Text style={cellQuoteStyle}>—</Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ─── Document ─────────────────────────────────────────────────────────────────

export function PulseCheckPdf({ data, itemName }: Props) {
  const energy = data.reviewerVerdicts?.[0]?.energy ?? 'neutral';
  const reviewerCount = data.reviewerVerdicts.length;
  const useSignalSummary = data.sessionCount >= 8;
  const useLandscapeMatrix = !useSignalSummary && reviewerCount >= 4;

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <Text style={s.title}>Pulse Check — {itemName}</Text>
        <Text style={s.dateLine}>Generated {formatDate(data.generatedAt)}</Text>
        <View style={s.accentLine} />

        {/* Verdict */}
        <Text style={s.verdictLabel}>Verdict</Text>
        <Text style={s.verdictText}>{data.verdict}</Text>
        {data.narrative ? <Text style={s.narrative}>{data.narrative}</Text> : null}
        <Text style={s.metaLine}>
          Based on {data.sessionCount} session(s) · Energy: {energy}
        </Text>

        {/* Signal sections */}
        <SignalSection type="conviction" items={data.sharedConviction} />
        <SignalSection type="tension" items={data.repeatedTension} />
        <SignalSection type="uncertainty" items={data.openQuestions} />

        {/* Tier 2 (8+ sessions): Signal Summary format */}
        {useSignalSummary && data.themes.length > 0 && (
          <View break>
            <PdfSignalSummary data={data} />
          </View>
        )}

        {/* Tier 1 (<8 sessions): Full theme list */}
        {!useSignalSummary && data.themes.length > 0 && (
          <View break>
            <Text style={s.sectionHeader}>{labels.pulseCheck.synthesisHeading}</Text>
            {data.themes.map((theme) => (
              <View key={theme.themeId} style={s.themeGroup} wrap={false}>
                <Text style={s.themeLabel}>{theme.label}</Text>
                {theme.reviewerSignals.map((sig, i) => (
                  <View key={i} style={s.tableRow}>
                    <View style={s.tableColLeft}>
                      <Text style={[s.signalTypeLabel, { color: PDF_SIGNAL_TYPE_COLORS[sig.signalType] ?? '#6c757d' }]}>
                        [{capitalize(sig.signalType)}]
                      </Text>
                    </View>
                    <View style={s.tableColRight}>
                      <Text style={s.signalQuote}>"{sig.quote}"</Text>
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {/* Signal Matrix — inline for < 4 reviewers, < 8 sessions (portrait) */}
        {!useSignalSummary && !useLandscapeMatrix && data.sessionCount >= 2 && data.themes.length > 0 && (
          <View break>
            <PdfSignalMatrix data={data} />
          </View>
        )}

        {/* Tier 2 (8+ sessions): Grouped revisions by type */}
        {useSignalSummary && data.proposedRevisions.length > 0 && (
          <View break>
            <PdfGroupedRevisions revisions={data.proposedRevisions} />
          </View>
        )}

        {/* Tier 1 (<8 sessions): Flat revision list */}
        {!useSignalSummary && data.proposedRevisions.length > 0 && (
          <View break>
            <Text style={s.sectionHeader}>Proposed Revisions</Text>
            {data.proposedRevisions.map((rev, i) => (
              <View
                key={i}
                style={i < data.proposedRevisions.length - 1 ? s.revisionBlock : s.revisionBlockLast}
                wrap={false}
              >
                <Text style={s.revisionTypeBadge}>{capitalize(rev.revisionType)}</Text>
                <Text style={s.revisionProposal}>{rev.proposal}</Text>
                <Text style={s.revisionRationale}>{rev.rationale}</Text>
              </View>
            ))}
          </View>
        )}

        <Footer />
      </Page>

      {/* Signal Matrix — separate landscape page for 4-7 reviewers only */}
      {useLandscapeMatrix && data.sessionCount >= 2 && data.themes.length > 0 && (
        <Page size="A4" orientation="landscape" style={s.page}>
          <PdfSignalMatrix data={data} />
          <Footer />
        </Page>
      )}
    </Document>
  );
}
