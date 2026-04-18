/**
 * Unit tests for AnnotatedChangeList detection, parsing, and building.
 * Requirements: 5.1, 5.2, 5.3, 5.4
 */

import { describe, it, expect } from 'vitest';
import {
  isAnnotatedChangeList,
  parseChangeList,
  buildChangeListMarkdown,
  type ChangeItem,
} from '../AnnotatedChangeList';

// ─── isAnnotatedChangeList ────────────────────────────────────────────────────

describe('isAnnotatedChangeList', () => {
  it('returns true for well-formed annotated change list Markdown', () => {
    const content = `### Change 1
- **Location:** Page 2, paragraph 3
- **Original:** "The project will be completed by Q3."
- **Replacement:** "The project will be completed by Q4."
- **Rationale:** Aligns timeline with updated resource plan.`;

    expect(isAnnotatedChangeList(content)).toBe(true);
  });

  it('returns true for multi-change content', () => {
    const content = `### Change 1
- **Location:** Page 1
- **Original:** "foo"
- **Replacement:** "bar"
- **Rationale:** Fix typo.

### Change 2
- **Location:** Page 3
- **Original:** "baz"
- **Replacement:** "qux"
- **Rationale:** Clarity.`;

    expect(isAnnotatedChangeList(content)).toBe(true);
  });

  it('returns false for regular Markdown without change headings', () => {
    const content = `# Document Title

This is a regular document with some content.

## Section 1

Some text here.`;

    expect(isAnnotatedChangeList(content)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAnnotatedChangeList('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isAnnotatedChangeList(null as unknown as string)).toBe(false);
    expect(isAnnotatedChangeList(undefined as unknown as string)).toBe(false);
  });

  it('returns false for content with ### Change but no Location field', () => {
    const content = `### Change 1
Some random text without the Location field.`;

    expect(isAnnotatedChangeList(content)).toBe(false);
  });
});

// ─── parseChangeList ──────────────────────────────────────────────────────────

describe('parseChangeList', () => {
  it('parses a single change block', () => {
    const markdown = `### Change 1
- **Location:** Page 2, Section "Introduction"
- **Original:** "The project will be completed by Q3."
- **Replacement:** "The project will be completed by Q4."
- **Rationale:** Aligns timeline with updated resource plan.`;

    const result = parseChangeList(markdown);
    expect(result).toHaveLength(1);
    expect(result[0].location).toBe('Page 2, Section "Introduction"');
    expect(result[0].original).toBe('The project will be completed by Q3.');
    expect(result[0].replacement).toBe('The project will be completed by Q4.');
    expect(result[0].rationale).toBe('Aligns timeline with updated resource plan.');
  });

  it('parses multiple change blocks', () => {
    const markdown = `### Change 1
- **Location:** Page 1
- **Original:** "foo"
- **Replacement:** "bar"
- **Rationale:** Fix typo.

### Change 2
- **Location:** Page 3
- **Original:** "baz"
- **Replacement:** "qux"
- **Rationale:** Clarity.`;

    const result = parseChangeList(markdown);
    expect(result).toHaveLength(2);
    expect(result[0].location).toBe('Page 1');
    expect(result[1].location).toBe('Page 3');
  });

  it('returns empty array for non-change-list content', () => {
    expect(parseChangeList('# Regular heading\nSome text.')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseChangeList('')).toEqual([]);
  });
});

// ─── buildChangeListMarkdown ──────────────────────────────────────────────────

describe('buildChangeListMarkdown', () => {
  it('builds Markdown from change items', () => {
    const changes: ChangeItem[] = [
      {
        location: 'Page 1, paragraph 2',
        original: 'old text',
        replacement: 'new text',
        rationale: 'Improved clarity.',
      },
    ];

    const result = buildChangeListMarkdown(changes);
    expect(result).toContain('### Change 1');
    expect(result).toContain('- **Location:** Page 1, paragraph 2');
    expect(result).toContain('- **Original:** "old text"');
    expect(result).toContain('- **Replacement:** "new text"');
    expect(result).toContain('- **Rationale:** Improved clarity.');
  });

  it('numbers changes sequentially', () => {
    const changes: ChangeItem[] = [
      { location: 'A', original: 'a', replacement: 'b', rationale: 'r1' },
      { location: 'B', original: 'c', replacement: 'd', rationale: 'r2' },
    ];

    const result = buildChangeListMarkdown(changes);
    expect(result).toContain('### Change 1');
    expect(result).toContain('### Change 2');
  });
});

// ─── Round trip ───────────────────────────────────────────────────────────────

describe('buildChangeListMarkdown → parseChangeList round trip', () => {
  it('recovers equivalent change items after build and parse', () => {
    const original: ChangeItem[] = [
      {
        location: 'Page 2, Section "Budget"',
        original: '$150,000',
        replacement: '$175,000',
        rationale: 'Reflects revised cost estimate.',
      },
      {
        location: 'Page 5, paragraph 1',
        original: 'The deadline is March.',
        replacement: 'The deadline is April.',
        rationale: 'Updated per reviewer feedback.',
      },
    ];

    const markdown = buildChangeListMarkdown(original);
    const parsed = parseChangeList(markdown);

    expect(parsed).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(parsed[i].location).toBe(original[i].location);
      expect(parsed[i].original).toBe(original[i].original);
      expect(parsed[i].replacement).toBe(original[i].replacement);
      expect(parsed[i].rationale).toBe(original[i].rationale);
    }
  });
});
