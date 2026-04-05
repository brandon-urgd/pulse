import { pdf, Font } from '@react-pdf/renderer';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { PulseCheckPdf, type PulseCheckPdfData } from '../components/pdf/PulseCheckPdf';
import { SessionReportPdf, type SessionReportPdfData } from '../components/pdf/SessionReportPdf';
import { RevisionPdf } from '../components/pdf/RevisionPdf';

export type { PulseCheckPdfData, SessionReportPdfData };

// ─── Brand Font Registration ──────────────────────────────────────────────────
// Register Archivo (headings) and Rubik (body) for branded PDF exports.
// Import as Vite assets so they're bundled under /assets/ (served by CloudFront).

import archivoBoldUrl from '/fonts/Archivo-Bold.ttf?url'
import rubikRegularUrl from '/fonts/Rubik-Regular.ttf?url'
import rubikMediumUrl from '/fonts/Rubik-Medium.ttf?url'

Font.register({
  family: 'Archivo',
  src: archivoBoldUrl,
  fontWeight: 700,
});
Font.register({
  family: 'Rubik',
  fonts: [
    { src: rubikRegularUrl, fontWeight: 400 },
    { src: rubikMediumUrl, fontWeight: 500 },
  ],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// @react-pdf/renderer's pdf() expects ReactElement<DocumentProps> but createElement
// returns a generic element. This cast is safe because our components return <Document>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderPdf(element: ReactElement) {
  return pdf(element as any).toBlob();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Pulse Check PDF ──────────────────────────────────────────────────────────

export async function downloadPulseCheckPdf(data: PulseCheckPdfData, itemName: string) {
  const doc = createElement(PulseCheckPdf, { data, itemName });
  const blob = await renderPdf(doc);
  await downloadBlob(blob, `Pulse Check — ${itemName}.pdf`);
}

// ─── Session Report PDF ───────────────────────────────────────────────────────

export async function downloadSessionReportPdf(data: SessionReportPdfData) {
  const doc = createElement(SessionReportPdf, { data });
  const blob = await renderPdf(doc);
  await downloadBlob(blob, 'Session Report.pdf');
}

// ─── Revision PDF ─────────────────────────────────────────────────────────────

export async function downloadRevisionPdf(
  originalContent: string,
  revisionContent: string,
  itemName: string,
  revisionNumber: number,
) {
  const doc = createElement(RevisionPdf, { originalContent, revisionContent, itemName, revisionNumber });
  const blob = await renderPdf(doc);
  const filename = itemName ? `Revision — ${itemName}` : 'Revision';
  await downloadBlob(blob, `${filename}.pdf`);
}
