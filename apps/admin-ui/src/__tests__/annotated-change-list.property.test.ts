/**
 * Property 5: Annotated change list Markdown round trip
 * Property 6: Format detection returns false for non-annotated content
 *
 * Validates: Requirements 4.3, 5.3
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  buildChangeListMarkdown,
  parseChangeList,
  isAnnotatedChangeList,
  type ChangeItem,
} from '../components/AnnotatedChangeList'

// --- Generators ---

/**
 * Generates a "safe" string for change fields.
 * Avoids characters/patterns that would break the Markdown parser:
 * - No double quotes (builder wraps original/replacement in quotes; parser strips them)
 * - No smart quotes (same reason)
 * - No newlines (would split the regex-based field extraction)
 * - Non-empty to ensure meaningful round-trip
 */
const safeFieldString = fc
  .stringMatching(/^[A-Za-z0-9 ,.:;!?'()\-_/+=@#$%^&]{1,80}$/)
  .filter((s) => s.trim().length > 0)
  .map((s) => s.trim())

/**
 * Generates a ChangeItem with safe field values for round-trip testing.
 */
const changeItemArb: fc.Arbitrary<ChangeItem> = fc.record({
  location: safeFieldString,
  original: safeFieldString,
  replacement: safeFieldString,
  rationale: safeFieldString,
})

// --- Property 5 ---

describe('Feature: async-revision-generation, Property 5: Change list Markdown round trip', () => {
  /**
   * Validates: Requirements 4.3
   *
   * For any list of change objects, building annotated change list Markdown
   * with buildChangeListMarkdown and parsing with parseChangeList recovers
   * an equivalent list of change objects.
   */

  it('round-trips change items through build → parse', () => {
    fc.assert(
      fc.property(
        fc.array(changeItemArb, { minLength: 1, maxLength: 10 }),
        (changes) => {
          const markdown = buildChangeListMarkdown(changes)
          const parsed = parseChangeList(markdown)

          expect(parsed).toHaveLength(changes.length)

          for (let i = 0; i < changes.length; i++) {
            expect(parsed[i].location).toBe(changes[i].location)
            expect(parsed[i].original).toBe(changes[i].original)
            expect(parsed[i].replacement).toBe(changes[i].replacement)
            expect(parsed[i].rationale).toBe(changes[i].rationale)
          }
        }
      ),
      { numRuns: 200 }
    )
  })

  it('round-trips an empty array to an empty result', () => {
    const markdown = buildChangeListMarkdown([])
    const parsed = parseChangeList(markdown)
    expect(parsed).toHaveLength(0)
  })

  it('built Markdown is detected as annotated change list format', () => {
    fc.assert(
      fc.property(
        fc.array(changeItemArb, { minLength: 1, maxLength: 5 }),
        (changes) => {
          const markdown = buildChangeListMarkdown(changes)
          expect(isAnnotatedChangeList(markdown)).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})

// --- Property 6 ---

describe('Feature: async-revision-generation, Property 6: Format detection for non-annotated content', () => {
  /**
   * Validates: Requirements 5.3
   *
   * For any Markdown string that does NOT contain the annotated change list
   * pattern (### Change heading + - **Location:** field), isAnnotatedChangeList
   * returns false, causing the frontend to use the existing side-by-side layout.
   */

  // Generates Markdown-like strings that avoid the annotated pattern.
  // The detector requires BOTH a "### Change N" heading AND a "- **Location:**" field.
  // We generate strings that do not match both conditions simultaneously.
  const nonAnnotatedMarkdown = fc
    .string({ minLength: 0, maxLength: 500 })
    .filter((s) => {
      // Reject strings that match BOTH conditions (the annotated pattern)
      const hasChangeHeading = /###\s+Change\s+\d+/i.test(s)
      const hasLocationField = /- \*\*Location:\*\*/i.test(s)
      return !(hasChangeHeading && hasLocationField)
    })

  it('returns false for arbitrary non-annotated Markdown', () => {
    fc.assert(
      fc.property(nonAnnotatedMarkdown, (content) => {
        expect(isAnnotatedChangeList(content)).toBe(false)
      }),
      { numRuns: 200 }
    )
  })

  it('returns false for typical Markdown content', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Plain paragraphs
          fc.lorem({ maxCount: 5 }).map((text) => text),
          // Headings without "Change" pattern
          fc.lorem({ maxCount: 3 }).map((text) => `## ${text}\n\nSome content here.`),
          // Bullet lists without **Location:**
          fc.array(fc.lorem({ maxCount: 2 }), { minLength: 1, maxLength: 5 }).map(
            (items) => items.map((item) => `- ${item}`).join('\n')
          ),
          // Code blocks
          fc.lorem({ maxCount: 3 }).map((text) => `\`\`\`\n${text}\n\`\`\``),
          // Empty / whitespace
          fc.constant(''),
          fc.constant('   \n\n  ')
        ),
        (content) => {
          expect(isAnnotatedChangeList(content)).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('returns false for content with only a Change heading but no Location field', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 99 }).map((n) => `### Change ${n + 1}\n- **Original:** "some text"\n- **Replacement:** "other text"`),
        (content) => {
          expect(isAnnotatedChangeList(content)).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('returns false for content with only a Location field but no Change heading', () => {
    fc.assert(
      fc.property(
        fc.lorem({ maxCount: 3 }).map((text) => `## Edits\n- **Location:** ${text}\n- **Original:** "foo"`),
        (content) => {
          expect(isAnnotatedChangeList(content)).toBe(false)
        }
      ),
      { numRuns: 100 }
    )
  })
})
