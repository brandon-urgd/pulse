import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { PDF_COLORS, PDF_FONTS } from '../../config/pdf-brand';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  originalContent: string;
  revisionContent: string;
  itemName: string;
  revisionNumber: number;
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
  accentLine: { height: 1, backgroundColor: PDF_COLORS.accent, marginTop: 8, marginBottom: 16 },
  sectionHeader: { fontSize: 16, fontFamily: PDF_FONTS.heading, fontWeight: 700, color: PDF_COLORS.accent, marginTop: 16, marginBottom: 8 },
  contentBlock: {
    fontSize: 10,
    color: PDF_COLORS.text,
    lineHeight: 1.6,
    backgroundColor: PDF_COLORS.bgSubtle,
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
          <Text style={s.footerBrand}>© 2026 ur/gd Studios LLC. All rights reserved. | Pulse</Text>
          <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}
