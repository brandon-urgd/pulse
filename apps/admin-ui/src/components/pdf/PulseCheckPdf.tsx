import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PulseCheckPdfData {
  verdict: string;
  narrative: string;
  themes: Array<{
    themeId: string;
    label: string;
    reviewerSignals: Array<{ signalType: string; quote: string }>;
  }>;
  sharedConviction: string[];
  repeatedTension: string[];
  openQuestions: string[];
  proposedRevisions: Array<{
    proposal: string;
    rationale: string;
    revisionType: string;
  }>;
  reviewerVerdicts: Array<{ verdict: string; energy: string; isSelfReview: boolean }>;
  sessionCount: number;
  generatedAt: string;
}

interface Props {
  data: PulseCheckPdfData;
  itemName: string;
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const SAGE = '#7a9e87';
const AMBER = '#d4a843';
const BLUE = '#5b8db8';

const SIGNAL_STYLES = {
  conviction: { border: SAGE, bg: '#f0f7f2', heading: '#5a7e67', icon: '✓', label: 'What Landed' },
  tension:    { border: AMBER, bg: '#fdf8ed', heading: '#8a6d2b', icon: '⚠', label: 'Where It Struggled' },
  uncertainty:{ border: BLUE,  bg: '#edf4fa', heading: '#3d6d94', icon: '', label: 'Open Questions' },
} as const;

const SIGNAL_TYPE_COLORS: Record<string, string> = {
  conviction: '#5a7e67',
  tension: '#8a6d2b',
  uncertainty: '#3d6d94',
};


// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    padding: 40,
    backgroundColor: '#ffffff',
    fontFamily: 'Rubik',
    fontSize: 10,
    color: '#212529',
  },
  // Header
  title: { fontSize: 24, fontFamily: 'Archivo', fontWeight: 700, color: '#1a1a1a' },
  dateLine: { fontSize: 9, color: '#868e96', marginTop: 4 },
  accentLine: { height: 1, backgroundColor: SAGE, marginTop: 8, marginBottom: 24 },
  // Verdict
  verdictLabel: { fontSize: 9, color: '#868e96', textTransform: 'uppercase', letterSpacing: 1 },
  verdictText: { fontSize: 18, fontFamily: 'Archivo', fontWeight: 700, color: '#1a1a1a', marginTop: 4 },
  narrative: { fontSize: 11, color: '#212529', marginTop: 8 },
  metaLine: { fontSize: 9, color: '#868e96', marginTop: 8, marginBottom: 28 },
  // Signal section
  signalBlock: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, paddingRight: 10, marginBottom: 20 },
  signalHeading: { fontSize: 13, fontFamily: 'Archivo', fontWeight: 700, marginBottom: 6 },
  bullet: { fontSize: 10, color: '#212529', marginBottom: 3, paddingLeft: 8 },
  // Themes
  sectionHeader: { fontSize: 16, fontFamily: 'Archivo', fontWeight: 700, color: SAGE, marginTop: 16, marginBottom: 8 },
  themeLabel: { fontSize: 12, fontFamily: 'Archivo', fontWeight: 700, color: '#1a1a1a', marginBottom: 6 },
  themeGroup: { marginBottom: 12 },
  // Theme table
  tableRow: { flexDirection: 'row', marginBottom: 4 },
  tableColLeft: { width: 80 },
  tableColRight: { flex: 1 },
  signalTypeLabel: { fontSize: 10, fontFamily: 'Rubik', fontWeight: 500 },
  signalQuote: { fontSize: 10, color: '#495057' },
  // Revisions
  revisionBlock: { marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#e9ecef' },
  revisionBlockLast: { marginBottom: 12, paddingBottom: 0, borderBottomWidth: 0 },
  revisionTypeBadge: { fontSize: 8, textTransform: 'uppercase', letterSpacing: 0.5, color: '#868e96', marginBottom: 4 },
  revisionProposal: { fontSize: 11, fontFamily: 'Rubik', fontWeight: 500, color: '#1a1a1a' },
  revisionRationale: { fontSize: 10, color: '#868e96', paddingLeft: 12, marginTop: 4 },
  // Footer
  footer: { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between' },
  footerBrand: { fontSize: 8, color: '#868e96' },
  footerPage: { fontSize: 8, color: '#868e96' },
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

function SignalSection({ type, items }: { type: keyof typeof SIGNAL_STYLES; items: string[] }) {
  if (items.length === 0) return null;
  const cfg = SIGNAL_STYLES[type];
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

// ─── Document ─────────────────────────────────────────────────────────────────

export function PulseCheckPdf({ data, itemName }: Props) {
  const energy = data.reviewerVerdicts?.[0]?.energy ?? 'neutral';

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

        {/* Themes */}
        {data.themes.length > 0 && (
          <View>
            <Text style={s.sectionHeader}>Themes</Text>
            {data.themes.map((theme) => (
              <View key={theme.themeId} style={s.themeGroup} wrap={false}>
                <Text style={s.themeLabel}>{theme.label}</Text>
                {theme.reviewerSignals.map((sig, i) => (
                  <View key={i} style={s.tableRow}>
                    <View style={s.tableColLeft}>
                      <Text style={[s.signalTypeLabel, { color: SIGNAL_TYPE_COLORS[sig.signalType] ?? '#6c757d' }]}>
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

        {/* Proposed Revisions */}
        {data.proposedRevisions.length > 0 && (
          <View>
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
    </Document>
  );
}
