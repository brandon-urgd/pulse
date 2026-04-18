import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { PDF_COLORS, PDF_FONTS } from '../../config/pdf-brand';
import { parseChangeList, type ChangeItem } from '../AnnotatedChangeList';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
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

  // Change card
  changeCard: {
    marginBottom: 14,
    borderWidth: 1,
    borderColor: PDF_COLORS.border,
    borderRadius: 4,
    padding: 12,
  },
  locationBadge: {
    fontSize: 8,
    fontWeight: 500,
    color: PDF_COLORS.textMuted,
    backgroundColor: PDF_COLORS.bgSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 7,
    fontWeight: 500,
    color: PDF_COLORS.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  originalBlock: {
    backgroundColor: '#fef2f2',
    borderLeftWidth: 2,
    borderLeftColor: '#ef4444',
    padding: 8,
    borderRadius: 3,
    marginBottom: 6,
  },
  replacementBlock: {
    backgroundColor: '#f0fdf4',
    borderLeftWidth: 2,
    borderLeftColor: '#22c55e',
    padding: 8,
    borderRadius: 3,
    marginBottom: 6,
  },
  changeText: {
    fontSize: 9,
    lineHeight: 1.5,
    color: PDF_COLORS.text,
  },
  rationale: {
    fontSize: 8,
    color: PDF_COLORS.textMuted,
    lineHeight: 1.4,
    marginTop: 2,
  },

  // Fallback for non-change-list content
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

// ─── Change Card ──────────────────────────────────────────────────────────────

function ChangeCard({ change, index }: { change: ChangeItem; index: number }) {
  return (
    <View style={s.changeCard} wrap={false}>
      <Text style={s.locationBadge}>{change.location || `Change ${index + 1}`}</Text>

      {change.original && (
        <View style={s.originalBlock}>
          <Text style={s.fieldLabel}>Original</Text>
          <Text style={s.changeText}>{change.original}</Text>
        </View>
      )}

      {change.replacement && (
        <View style={s.replacementBlock}>
          <Text style={s.fieldLabel}>Replacement</Text>
          <Text style={s.changeText}>{change.replacement}</Text>
        </View>
      )}

      {change.rationale && (
        <Text style={s.rationale}>{change.rationale}</Text>
      )}
    </View>
  );
}

// ─── Document ─────────────────────────────────────────────────────────────────

export function RevisionPdf({ revisionContent, itemName, revisionNumber }: Props) {
  const changes = parseChangeList(revisionContent);

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <Text style={s.title}>Revision {revisionNumber} — {itemName}</Text>
        <View style={s.accentLine} />

        {/* Change cards or fallback */}
        {changes.length > 0
          ? changes.map((change, i) => (
              <ChangeCard key={i} change={change} index={i} />
            ))
          : <Text style={s.contentBlock}>{revisionContent || '(no content)'}</Text>
        }

        {/* Footer */}
        <View style={s.footer} fixed>
          <Text style={s.footerBrand}>© 2026 ur/gd Studios LLC. All rights reserved. | Pulse</Text>
          <Text style={s.footerPage} render={({ pageNumber }) => `${pageNumber}`} />
        </View>
      </Page>
    </Document>
  );
}
