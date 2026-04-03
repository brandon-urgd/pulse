import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  originalContent: string;
  revisionContent: string;
  itemName: string;
  revisionNumber: number;
}

// ─── Colors ───────────────────────────────────────────────────────────────────

const SAGE = '#7a9e87';

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
  accentLine: { height: 1, backgroundColor: SAGE, marginTop: 8, marginBottom: 16 },
  sectionHeader: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: SAGE, marginTop: 16, marginBottom: 8 },
  contentBlock: {
    fontSize: 10,
    color: '#212529',
    lineHeight: 1.6,
    backgroundColor: '#f8f9fa',
    padding: 12,
    borderRadius: 4,
  },
  footer: { position: 'absolute', bottom: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between' },
  footerBrand: { fontSize: 8, color: '#adb5bd' },
  footerPage: { fontSize: 8, color: '#adb5bd' },
});

// ─── Document ─────────────────────────────────────────────────────────────────

export function RevisionPdf({ originalContent, revisionContent, itemName, revisionNumber }: Props) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <Text style={s.title}>Revision {revisionNumber} — {itemName}</Text>
        <View style={s.accentLine} />

        {/* Original */}
        <Text style={s.sectionHeader}>Original</Text>
        <Text style={s.contentBlock}>{originalContent || '(no content)'}</Text>

        {/* Revision */}
        <Text style={s.sectionHeader}>Revision</Text>
        <Text style={s.contentBlock}>{revisionContent || '(no content)'}</Text>

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>Pulse by ur/gd Studios</Text>
          <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}
