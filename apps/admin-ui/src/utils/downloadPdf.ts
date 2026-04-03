import { jsPDF } from 'jspdf';

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

export interface SessionReportPdfData {
  verdict: string;
  conviction: string[];
  tension: string[];
  uncertainty: string[];
  energy: string;
  generatedAt: string;
  isSelfReview: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MARGIN = 20;
const PAGE_WIDTH = 210; // A4 mm
const PAGE_HEIGHT = 297;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const TEXT_COLOR: [number, number, number] = [26, 26, 26]; // #1a1a1a
const RULE_COLOR: [number, number, number] = [180, 180, 180];
const FONT_BODY = 10;
const FONT_HEADING = 14;
const FONT_TITLE = 18;
const FONT_SMALL = 8;
const BRANDING = 'Pulse by ur/gd Studios';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDoc(): jsPDF {
  return new jsPDF('p', 'mm', 'a4');
}

/** Check if we need a page break; if so, add page and return new Y. */
function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  if (y + needed > PAGE_HEIGHT - MARGIN - 10) {
    doc.addPage();
    return MARGIN;
  }
  return y;
}

/** Draw a horizontal rule at y, return y + spacing. */
function drawRule(doc: jsPDF, y: number): number {
  doc.setDrawColor(...RULE_COLOR);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  return y + 4;
}

/** Write wrapped text, handling page breaks. Returns new Y position. */
function writeText(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  opts?: { fontSize?: number; fontStyle?: string; maxWidth?: number }
): number {
  const fontSize = opts?.fontSize ?? FONT_BODY;
  const fontStyle = opts?.fontStyle ?? 'normal';
  const maxWidth = opts?.maxWidth ?? CONTENT_WIDTH;

  doc.setFont('Helvetica', fontStyle);
  doc.setFontSize(fontSize);
  doc.setTextColor(...TEXT_COLOR);

  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  const lineH = fontSize * 0.45; // approximate mm per line

  for (const line of lines) {
    y = ensureSpace(doc, y, lineH + 1);
    doc.text(line, x, y);
    y += lineH + 1;
  }
  return y;
}

/** Write a section heading like "── What Landed ──" */
function writeSectionHeading(doc: jsPDF, label: string, y: number): number {
  y = ensureSpace(doc, y, 12);
  y += 3;
  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(FONT_HEADING);
  doc.setTextColor(...TEXT_COLOR);
  doc.text(`── ${label} ──`, MARGIN, y);
  y += 8;
  return y;
}

/** Write a bullet list of strings. */
function writeBulletList(doc: jsPDF, items: string[], y: number): number {
  for (const item of items) {
    y = ensureSpace(doc, y, 8);
    y = writeText(doc, `• ${item}`, MARGIN + 2, y);
    y += 1;
  }
  return y;
}

/** Add branding footer to every page. */
function addBranding(doc: jsPDF): void {
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(FONT_SMALL);
    doc.setTextColor(140, 140, 140);
    doc.text(BRANDING, PAGE_WIDTH / 2, PAGE_HEIGHT - 10, { align: 'center' });
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return iso;
  }
}

// ─── Legacy DOM-based export (backward compat) ────────────────────────────────

/**
 * @deprecated Use the data-driven PDF functions instead.
 * Kept for backward compatibility — builds a basic text PDF from element's textContent.
 */
export async function downloadPdf(element: HTMLElement, filename: string): Promise<void> {
  const doc = createDoc();
  const text = element.textContent ?? '';
  let y = MARGIN;
  y = writeText(doc, text, MARGIN, y);
  addBranding(doc);
  doc.save(`${filename}.pdf`);
}


// ─── Pulse Check PDF ──────────────────────────────────────────────────────────

export function downloadPulseCheckPdf(data: PulseCheckPdfData, itemName: string): void {
  const doc = createDoc();
  let y = MARGIN;

  // Title
  y = writeText(doc, `Pulse Check — ${itemName}`, MARGIN, y, { fontSize: FONT_TITLE, fontStyle: 'bold' });
  y = writeText(doc, `Generated ${formatDate(data.generatedAt)}`, MARGIN, y, { fontSize: FONT_SMALL });
  y += 2;
  y = drawRule(doc, y);

  // Verdict + narrative
  y = writeText(doc, `Verdict: ${data.verdict}`, MARGIN, y, { fontSize: FONT_HEADING, fontStyle: 'bold' });
  y += 1;
  if (data.narrative) {
    y = writeText(doc, data.narrative, MARGIN, y);
    y += 2;
  }

  y = writeText(doc, `Based on ${data.sessionCount} session(s)`, MARGIN, y, { fontSize: FONT_SMALL });
  y += 1;

  // Energy from first reviewer verdict
  const energy = data.reviewerVerdicts?.[0]?.energy ?? 'neutral';
  y = writeText(doc, `Energy: ${energy}`, MARGIN, y, { fontSize: FONT_SMALL });
  y += 4;

  // What Landed
  if (data.sharedConviction.length > 0) {
    y = writeSectionHeading(doc, 'What Landed', y);
    y = writeBulletList(doc, data.sharedConviction, y);
    y += 2;
  }

  // Where It Struggled
  if (data.repeatedTension.length > 0) {
    y = writeSectionHeading(doc, 'Where It Struggled', y);
    y = writeBulletList(doc, data.repeatedTension, y);
    y += 2;
  }

  // Open Questions
  if (data.openQuestions.length > 0) {
    y = writeSectionHeading(doc, 'Open Questions', y);
    y = writeBulletList(doc, data.openQuestions, y);
    y += 2;
  }

  // Themes
  if (data.themes.length > 0) {
    y = writeSectionHeading(doc, 'Themes', y);
    for (const theme of data.themes) {
      y = ensureSpace(doc, y, 12);
      y = writeText(doc, theme.label, MARGIN + 2, y, { fontSize: FONT_BODY, fontStyle: 'bold' });
      for (const signal of theme.reviewerSignals) {
        y = ensureSpace(doc, y, 8);
        const label = `[${capitalize(signal.signalType)}]`;
        y = writeText(doc, `${label} "${signal.quote}"`, MARGIN + 6, y, { fontStyle: 'italic', maxWidth: CONTENT_WIDTH - 8 });
      }
      y += 2;
    }
  }

  // Proposed Revisions
  if (data.proposedRevisions.length > 0) {
    y = writeSectionHeading(doc, 'Proposed Revisions', y);
    for (const rev of data.proposedRevisions) {
      y = ensureSpace(doc, y, 12);
      y = writeText(doc, `[${capitalize(rev.revisionType)}] ${rev.proposal}`, MARGIN + 2, y, { fontStyle: 'bold' });
      y = writeText(doc, `Rationale: ${rev.rationale}`, MARGIN + 6, y, { fontSize: FONT_BODY - 1 });
      y += 2;
    }
  }

  // Footer rule + branding
  y = ensureSpace(doc, y, 10);
  drawRule(doc, y);
  addBranding(doc);

  const filename = itemName ? `Pulse Check — ${itemName}` : 'Pulse Check';
  doc.save(`${filename}.pdf`);
}

// ─── Session Report PDF ───────────────────────────────────────────────────────

export function downloadSessionReportPdf(data: SessionReportPdfData): void {
  const doc = createDoc();
  let y = MARGIN;

  // Title
  y = writeText(doc, 'Session Report', MARGIN, y, { fontSize: FONT_TITLE, fontStyle: 'bold' });
  y = writeText(doc, `Generated ${formatDate(data.generatedAt)}`, MARGIN, y, { fontSize: FONT_SMALL });
  y += 2;
  y = drawRule(doc, y);

  // Verdict + Energy
  y = writeText(doc, `Verdict: ${data.verdict}`, MARGIN, y, { fontSize: FONT_HEADING, fontStyle: 'bold' });
  y += 1;
  y = writeText(doc, `Energy: ${data.energy}`, MARGIN, y, { fontSize: FONT_SMALL });
  y += 4;

  // What Landed
  if (data.conviction.length > 0) {
    y = writeSectionHeading(doc, 'What Landed', y);
    y = writeBulletList(doc, data.conviction, y);
    y += 2;
  }

  // Where It Struggled
  if (data.tension.length > 0) {
    y = writeSectionHeading(doc, 'Where It Struggled', y);
    y = writeBulletList(doc, data.tension, y);
    y += 2;
  }

  // Open Questions
  if (data.uncertainty.length > 0) {
    y = writeSectionHeading(doc, 'Open Questions', y);
    y = writeBulletList(doc, data.uncertainty, y);
    y += 2;
  }

  // Footer rule + branding
  y = ensureSpace(doc, y, 10);
  drawRule(doc, y);
  addBranding(doc);

  doc.save('Session Report.pdf');
}

// ─── Revision PDF ─────────────────────────────────────────────────────────────

export function downloadRevisionPdf(
  originalContent: string,
  revisionContent: string,
  itemName: string,
  revisionNumber: number
): void {
  const doc = createDoc();
  let y = MARGIN;

  // Title
  y = writeText(doc, `Revision ${revisionNumber} — ${itemName}`, MARGIN, y, { fontSize: FONT_TITLE, fontStyle: 'bold' });
  y += 2;
  y = drawRule(doc, y);

  // Original
  y = writeSectionHeading(doc, 'Original', y);
  y = writeText(doc, originalContent || '(no content)', MARGIN + 2, y);
  y += 4;

  // Revision
  y = writeSectionHeading(doc, 'Revision', y);
  y = writeText(doc, revisionContent || '(no content)', MARGIN + 2, y);
  y += 4;

  // Footer rule + branding
  y = ensureSpace(doc, y, 10);
  drawRule(doc, y);
  addBranding(doc);

  const filename = itemName ? `Revision — ${itemName}` : 'Revision';
  doc.save(`${filename}.pdf`);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
