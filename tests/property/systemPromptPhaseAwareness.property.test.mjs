// Property-based tests for Phased Cache Priming — Property 4: System prompt phase-awareness
// Feature: phased-cache-priming, Property 4: system prompt phase-awareness
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.1, 4.5**
//
// For any document session, when nativeDocumentAvailable is false (turns 1-2), the system
// prompt SHALL contain the extracted text content and instructions to focus on content,
// structure, and messaging. It SHALL contain instructions to avoid referencing visual elements,
// page layouts, formatting details, or claiming visual access. When nativeDocumentAvailable
// is true (turn 3+), the system prompt SHALL contain the existing full-document instructions
// referencing the native file attachment and page images.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ── Generators ──

const itemNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0)
const itemDescriptionArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
  fc.constant(''),
  fc.constant(undefined),
)
const itemContentArb = fc.string({ minLength: 10, maxLength: 500 }).filter(s => s.trim().length > 0)
const totalSectionsArb = fc.integer({ min: 1, max: 10 })
const currentSectionArb = fc.integer({ min: 1, max: 10 })
const closingStateArb = fc.constantFrom('exploring', 'narrowing', 'closing', 'closed')
const isSelfReviewArb = fc.boolean()
const timeLimitArb = fc.integer({ min: 5, max: 60 })
const messageArb = fc.constantFrom('__session_start__', '__session_resume__', 'Hello', 'What do you think?')

/** Build a minimal valid params object for buildSystemPrompt */
function makePromptParams(overrides = {}) {
  return {
    itemName: 'Test Document',
    itemDescription: 'Review this document.',
    itemContent: '# Sample extracted text\n\nThis is the body of the document.',
    itemType: 'document',
    totalSections: 3,
    currentSection: 1,
    closingState: 'exploring',
    windingDown: undefined,
    message: 'Hello',
    isSpecial: false,
    frozenSnapshot: null,
    coverageMap: null,
    imageBase64: null,
    isSelfReview: false,
    timeLimitMinutes: 30,
    nativeDocumentAvailable: false,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 4: System prompt phase-awareness
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.1, 4.5**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 4: system prompt phase-awareness', () => {

  it('text-only phase (nativeDocumentAvailable=false): prompt contains extracted text and content-focus instructions', () => {
    // **Validates: Requirements 3.1, 3.2, 4.1**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        itemContentArb,
        totalSectionsArb,
        currentSectionArb,
        closingStateArb,
        isSelfReviewArb,
        timeLimitArb,
        messageArb,
        (itemName, itemDescription, itemContent, totalSections, currentSection, closingState, isSelfReview, timeLimitMinutes, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            itemContent,
            itemType: 'document',
            totalSections,
            currentSection: Math.min(currentSection, totalSections),
            closingState,
            isSelfReview,
            timeLimitMinutes,
            message,
            nativeDocumentAvailable: false,
          }))

          // The extracted text content should be present in the prompt
          expect(prompt).toContain(itemContent)

          // Should contain text-only phase instructions
          expect(prompt).toContain('text extracted from the original document')
          expect(prompt).toContain('content, structure, arguments, and messaging')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('text-only phase: prompt contains visual avoidance instructions', () => {
    // **Validates: Requirements 3.2, 3.3, 4.5**
    fc.assert(
      fc.property(
        itemNameArb,
        itemContentArb,
        isSelfReviewArb,
        (itemName, itemContent, isSelfReview) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            isSelfReview,
            nativeDocumentAvailable: false,
          }))

          // Should instruct model to avoid visual references
          expect(prompt).toContain('Do not reference specific visual elements')
          expect(prompt).toContain('Do not claim you have seen the document visually')
          expect(prompt).toContain('page layouts, formatting details')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('text-only phase: prompt contains visual redirect instructions', () => {
    // **Validates: Requirements 3.2, 4.5**
    fc.assert(
      fc.property(
        itemNameArb,
        itemContentArb,
        (itemName, itemContent) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            nativeDocumentAvailable: false,
          }))

          // Should contain redirect instructions for visual questions
          expect(prompt).toContain('redirect to content-level observations')
          expect(prompt).toContain('what the text says rather than how it looks')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('text-only phase: prompt does NOT contain native document instructions', () => {
    // **Validates: Requirements 3.1, 3.4**
    fc.assert(
      fc.property(
        itemNameArb,
        itemContentArb,
        (itemName, itemContent) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            nativeDocumentAvailable: false,
          }))

          // Should NOT contain full-document instructions
          expect(prompt).not.toContain('native file attachment and page images')
          expect(prompt).not.toContain('full access to its content, layout, and visual elements')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('full-document phase (nativeDocumentAvailable=true): prompt contains native document instructions', () => {
    // **Validates: Requirements 3.4**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        totalSectionsArb,
        currentSectionArb,
        closingStateArb,
        isSelfReviewArb,
        timeLimitArb,
        messageArb,
        (itemName, itemDescription, totalSections, currentSection, closingState, isSelfReview, timeLimitMinutes, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            itemType: 'document',
            totalSections,
            currentSection: Math.min(currentSection, totalSections),
            closingState,
            isSelfReview,
            timeLimitMinutes,
            message,
            nativeDocumentAvailable: true,
          }))

          // Should contain full-document instructions
          expect(prompt).toContain('native file attachment and page images')
          expect(prompt).toContain('full access to its content, layout, and visual elements')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('full-document phase: prompt does NOT contain text-only phase instructions', () => {
    // **Validates: Requirements 3.4**
    fc.assert(
      fc.property(
        itemNameArb,
        itemContentArb,
        (itemName, itemContent) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            nativeDocumentAvailable: true,
          }))

          // Should NOT contain text-only phase instructions
          expect(prompt).not.toContain('text extracted from the original document')
          expect(prompt).not.toContain('redirect to content-level observations')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document items without content fall through to fallback when nativeDocumentAvailable is false', () => {
    // **Validates: Requirements 3.1**
    fc.assert(
      fc.property(
        itemNameArb,
        fc.constantFrom(undefined, null, ''),
        (itemName, itemContent) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            nativeDocumentAvailable: false,
          }))

          // Without content, should fall through to the fallback branch
          // Should NOT contain text-only phase instructions (no itemContent)
          expect(prompt).not.toContain('text extracted from the original document')
          // Should contain fallback content
          expect(prompt).toContain('Document content:')
        },
      ),
      { numRuns: 30 },
    )
  })

  it('image items are unaffected by nativeDocumentAvailable flag', () => {
    // **Validates: Requirements 3.4 (backward compatibility)**
    fc.assert(
      fc.property(
        itemNameArb,
        fc.boolean(),
        (itemName, nativeDocumentAvailable) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemType: 'image',
            nativeDocumentAvailable,
          }))

          // Image sessions should always get image instructions
          expect(prompt).toContain('image feedback session')
          // Should NOT contain document-specific instructions
          expect(prompt).not.toContain('text extracted from the original document')
          expect(prompt).not.toContain('native file attachment and page images')
        },
      ),
      { numRuns: 100 },
    )
  })
})
