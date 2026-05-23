/**
 * AnnotatedChangeList — Renders structured change list revisions for PDF/DOCX items.
 *
 * Detection: If revision Markdown contains `### Change 1` followed by `- **Location:**`,
 * it's treated as an annotated change list. Otherwise, falls through to the existing
 * side-by-side RevisionPane layout.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import styles from './AnnotatedChangeList.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChangeItem {
  location: string;
  original: string;
  replacement: string;
  rationale: string;
}

interface AnnotatedChangeListProps {
  content: string;
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true if the Markdown content follows the annotated change list format.
 * Detection is content-based (not file-extension-based) per Requirement 5.4.
 *
 * Looks for `### Change 1` (or `### Change 1:` etc.) followed somewhere by `- **Location:**`.
 */
export function isAnnotatedChangeList(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  // Must contain a "### Change" heading with a number, followed by a Location field
  return /###\s+Change\s+\d+/i.test(content) && /- \*\*Location:\*\*/i.test(content);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses annotated change list Markdown into structured ChangeItem objects.
 * Each `### Change N` block is expected to contain Location, Original, Replacement,
 * and Rationale fields.
 */
export function parseChangeList(markdown: string): ChangeItem[] {
  if (!markdown || typeof markdown !== 'string') return [];

  // Split on ### Change N headings, keeping the delimiter
  const blocks = markdown.split(/(?=###\s+Change\s+\d+)/i);
  const changes: ChangeItem[] = [];

  for (const block of blocks) {
    // Only process blocks that start with a Change heading
    if (!/^###\s+Change\s+\d+/i.test(block.trim())) continue;

    const location = extractField(block, 'Location');
    const original = extractField(block, 'Original');
    const replacement = extractField(block, 'Replacement');
    const rationale = extractField(block, 'Rationale');

    changes.push({ location, original, replacement, rationale });
  }

  return changes;
}

/**
 * Extracts a field value from a change block.
 * Matches `- **FieldName:** value` or `- **FieldName:** "quoted value"`.
 */
function extractField(block: string, fieldName: string): string {
  // Match the field pattern: - **FieldName:** value (possibly quoted)
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `-\\s*\\*\\*${escaped}:\\*\\*\\s*(.+?)(?=\\n-\\s*\\*\\*|\\n###|$)`,
    'is'
  );
  const match = block.match(regex);
  if (!match) return '';

  let value = match[1].trim();
  // Strip surrounding quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\u201c') && value.endsWith('\u201d'))) {
    value = value.slice(1, -1);
  }
  return value;
}

// ─── Builder (for round-trip testing) ─────────────────────────────────────────

/**
 * Builds annotated change list Markdown from structured ChangeItem objects.
 * Used for round-trip property testing (Property 5).
 */
export function buildChangeListMarkdown(changes: ChangeItem[]): string {
  return changes
    .map((change, index) => {
      const lines = [
        `### Change ${index + 1}`,
        `- **Location:** ${change.location}`,
        `- **Original:** "${change.original}"`,
        `- **Replacement:** "${change.replacement}"`,
        `- **Rationale:** ${change.rationale}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders an annotated change list as a series of cards.
 * Each card shows location, original text (del-styled), replacement text (ins-styled),
 * and rationale. Uses semantic HTML for copy-paste friendliness.
 *
 * Requirements: 5.1, 5.2
 */
export default function AnnotatedChangeList({ content }: AnnotatedChangeListProps) {
  const changes = parseChangeList(content);

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className={styles.wrapper} role="region" aria-label="Annotated change list">
      {changes.map((change, index) => (
        <article key={index} className={styles.card}>
          <p className={styles.locationBadge}>{change.location || `Change ${index + 1}`}</p>

          {change.original && (
            <blockquote className={styles.originalBlock}>
              <p className={styles.fieldLabel}>Original</p>
              <p className={styles.originalText}>
                <del>{change.original}</del>
              </p>
            </blockquote>
          )}

          {change.replacement && (
            <blockquote className={styles.replacementBlock}>
              <p className={styles.fieldLabel}>Replacement</p>
              <p className={styles.replacementText}>
                <ins>{change.replacement}</ins>
              </p>
            </blockquote>
          )}

          {change.rationale && (
            <p className={styles.rationale}>{change.rationale}</p>
          )}
        </article>
      ))}
    </div>
  );
}
