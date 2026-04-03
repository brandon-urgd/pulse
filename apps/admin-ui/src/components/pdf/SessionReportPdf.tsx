import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';

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

// ─── Colors ───────────────────────────────────────────────────────────────────

const SAGE = '#7a9e87';
const AMBER = '#d4a843';
const BLUE = '#5b8db8';

const SIGNAL_STYLES = {
  conviction: { border: SAGE, bg: '#f0f7f2', heading: '#5a7e67', icon: '✓', label: 'What Landed' },
  tension:    { border: AMBER, bg: '#fdf8ed', heading: '#8a6d2b', icon: '⚠', label: 'Where It Struggled' },
  uncertainty:{ border: BLUE,  bg: '#edf4fa', heading: '#3d6d94', icon: '?', label: 'Open Questions' },
} as const;

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    padding: 40,
    backgroundColor: '#ffffff',
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: '#212529',
  },
  title: { fontSize: 24, fontFamily: 'Helvetica-Bold', color: '#1a1a1a' },
  dateLine: { fontSize: 9, color: '#adb5bd', marginTop: 4 },
  accentLine: { height: 1, backgroundColor: SAGE, marginTop: 8, marginBottom: 16 },
  verdictLabel: { fontSize: 9, color: '#adb5bd', textTransform: 'uppercase', letterSpacing: 1 },
  verdictText: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', marginTop: 4 },
  metaLine: { fontSize: 9, color: '#adb5bd', marginTop: 8, marginBottom: 16 },
  signalBlock: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 10, paddingRight: 10, marginBottom: 12 },
  signalHeading: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 6 },
  bullet: { fontSize: 10, color: '#212529', marginBottom: 3, paddingLeft: 8 },
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

function SignalSection({ type, items }: { type: keyof typeof SIGNAL_STYLES; items: string[] }) {
  if (items.length === 0) return null;
  const cfg = SIGNAL_STYLES[type];
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
          <Text style={s.footerBrand}>Pulse by ur/gd Studios</Text>
          <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}
