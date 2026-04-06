import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { PDF_COLORS, PDF_SIGNAL_STYLES, PDF_FONTS } from '../../config/pdf-brand';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionReportPdfData {
  verdict: string;
  conviction: string[];
  tension: string[];
  uncertainty: string[];
  energy: string;
  generatedAt: string;
  isSelfReview: boolean;
}

interface Props {
  data: SessionReportPdfData;
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
  title: { fontSize: 24, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: '#1a1a1a' },
  dateLine: { fontSize: 9, color: '#adb5bd', marginTop: 4 },
  accentLine: { height: 1, backgroundColor: PDF_COLORS.accent, marginTop: 8, marginBottom: 16 },
  verdictLabel: { fontSize: 9, color: '#adb5bd', textTransform: 'uppercase', letterSpacing: 1 },
  verdictText: { fontSize: 18, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: '#1a1a1a', marginTop: 4 },
  metaLine: { fontSize: 9, color: '#adb5bd', marginTop: 8, marginBottom: 16 },
  signalBlock: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, paddingRight: 10, marginBottom: 12 },
  signalHeading: { fontSize: 13, fontFamily: PDF_FONTS.heading, fontWeight: 700, marginBottom: 6 },
  bullet: { fontSize: 10, color: PDF_COLORS.text, marginBottom: 3, paddingLeft: 8 },
  footer: { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between' },
  footerBrand: { fontSize: 8, color: '#adb5bd' },
  footerPage: { fontSize: 8, color: '#adb5bd' },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return iso;
  }
}

// ─── Signal Section ───────────────────────────────────────────────────────────

function SignalSection({ type, items }: { type: keyof typeof PDF_SIGNAL_STYLES; items: string[] }) {
  if (items.length === 0) return null;
  const cfg = PDF_SIGNAL_STYLES[type];
  return (
    <View
      style={[s.signalBlock, { borderLeftColor: cfg.border, backgroundColor: cfg.bg }]}
      wrap={false}
    >
      <Text style={[s.signalHeading, { color: cfg.heading }]}>
        {cfg.icon} {cfg.label}
      </Text>
      {items.map((item, i) => (
        <Text key={i} style={s.bullet}>• {item}</Text>
      ))}
    </View>
  );
}

// ─── Document ─────────────────────────────────────────────────────────────────

export function SessionReportPdf({ data }: Props) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <Text style={s.title}>Session Report</Text>
        <Text style={s.dateLine}>Generated {formatDate(data.generatedAt)}</Text>
        <View style={s.accentLine} />

        {/* Verdict + Energy */}
        <Text style={s.verdictLabel}>Verdict</Text>
        <Text style={s.verdictText}>{data.verdict}</Text>
        <Text style={s.metaLine}>Energy: {data.energy}</Text>

        {/* Signal sections */}
        <SignalSection type="conviction" items={data.conviction} />
        <SignalSection type="tension" items={data.tension} />
        <SignalSection type="uncertainty" items={data.uncertainty} />

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>© 2026 ur/gd Studios LLC. All rights reserved. | Pulse</Text>
          <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}
