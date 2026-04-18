// Property-based tests for Drop Page Images — Property 4: System prompt content varies correctly with flag
// Feature: drop-page-images, Property 4: System prompt content varies correctly with flag
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 8.1, 8.2**
//
// For any document session where nativeDocumentAvailable is true:
// - When includePageImages is false, the system prompt SHALL contain the PDF structure
//   capability description, the layout inference instruction, and the honesty guardrail
//   for photo/graphic questions, and SHALL NOT contain claims of visual access to page images.
// - When includePageImages is true, the system prompt SHALL contain the existing full
//   visual access description.
// - Regardless of flag value, the system prompt SHALL contain the "reference it directly"
//   instruction and the invisible transition guardrail prohibiting "I haven't seen the
//   document yet" language.

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
const totalSectionsArb = fc.integer({ min: 1, max: 10 })
const currentSectionArb = fc.integer({ min: 1, max: 10 })
const closingStateArb = fc.constantFrom('exploring', 'narrowing', 'closing', 'closed')
const isSelfReviewArb = fc.boolean()
const timeLimitArb = fc.integer({ min: 5, max: 60 })
const messageArb = fc.constantFrom('__session_start__', '__session_resume__', '__session_end__', 'Hello', 'What do you think?')

/** Build a minimal valid params object for buildSystemPrompt with nativeDocumentAvailable: true */
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
    nativeDocumentAvailable: true,
    includePageImages: false,
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: drop-page-images
// Property 4: System prompt content varies correctly with flag
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 8.1, 8.2**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: drop-page-images, Property 4: System prompt content varies correctly with flag', () => {

  it('includePageImages=false: prompt contains PDF structure capability description', () => {
    // **Validates: Requirements 3.1, 3.5**
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
            totalSections,
            currentSection: Math.min(currentSection, totalSections),
            closingState,
            isSelfReview,
            timeLimitMinutes,
            message,
            includePageImages: false,
          }))

          // SHALL contain the PDF structure capability description
          expect(prompt).toContain('full text content, document structure, page boundaries, layout coordinates, font sizing, column structure, and image placement positions')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('includePageImages=false: prompt contains layout inference instruction', () => {
    // **Validates: Requirements 3.5**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages: false,
          }))

          // SHALL contain the layout inference instruction
          expect(prompt).toContain('Use the PDF block\'s underlying structure and spatial coordinates to make confident observations about layout, hierarchy, visual weight')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('includePageImages=false: prompt contains honesty guardrail for photo/graphic questions', () => {
    // **Validates: Requirements 4.1, 4.2, 4.3**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages: false,
          }))

          // SHALL contain the honesty guardrail for photo/graphic questions (Req 4.1)
          expect(prompt).toContain('cannot see the visual content of the image itself')
          // SHALL redirect to observable information (Req 4.2)
          expect(prompt).toContain('Redirect to what you can observe')
          // SHALL NOT explain in technical terms (Req 4.3)
          expect(prompt).toContain('Do not explain why in technical terms')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('includePageImages=false: prompt does NOT contain claims of visual access to page images', () => {
    // **Validates: Requirements 3.2, 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages: false,
          }))

          // SHALL NOT contain claims of visual access to page images
          expect(prompt).not.toContain('native file attachment and page images')
          expect(prompt).not.toContain('full access to its content, layout, and visual elements')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('includePageImages=true: prompt contains full visual access description', () => {
    // **Validates: Requirements 3.3, 3.4**
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
            totalSections,
            currentSection: Math.min(currentSection, totalSections),
            closingState,
            isSelfReview,
            timeLimitMinutes,
            message,
            includePageImages: true,
          }))

          // SHALL contain the existing full visual access description
          expect(prompt).toContain('native file attachment and page images')
          expect(prompt).toContain('full access to its content, layout, and visual elements')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('includePageImages=true: prompt does NOT contain no-images guardrails', () => {
    // **Validates: Requirements 3.3**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages: true,
          }))

          // SHALL NOT contain the no-images honesty guardrail or layout inference instruction
          expect(prompt).not.toContain('cannot see the visual content of the image itself')
          expect(prompt).not.toContain('Use the PDF block\'s underlying structure and spatial coordinates')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('regardless of flag: prompt contains "reference it directly" instruction', () => {
    // **Validates: Requirements 3.4, 8.1**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        fc.boolean(),
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, includePageImages, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages,
          }))

          // SHALL contain the "reference it directly" instruction regardless of flag
          expect(prompt.toLowerCase()).toContain('reference')
          expect(prompt.toLowerCase()).toContain('do not ask the reviewer to describe')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('regardless of flag: prompt contains invisible transition guardrail', () => {
    // **Validates: Requirements 8.1, 8.2**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        fc.boolean(),
        isSelfReviewArb,
        messageArb,
        (itemName, itemDescription, includePageImages, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            isSelfReview,
            message,
            includePageImages,
          }))

          // SHALL contain the invisible transition guardrail (Req 8.1)
          expect(prompt).toContain('Never say "I haven\'t seen the document yet,"')
          expect(prompt).toContain('reveals progressive context loading')

          // SHALL NOT introduce language revealing absence of page images (Req 8.2)
          expect(prompt).not.toContain('page images are not available')
          expect(prompt).not.toContain('page images have been removed')
          expect(prompt).not.toContain('visual capabilities have changed')
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: drop-page-images
// Property 1: Feature flag controls page image inclusion in Turn 3
// **Validates: Requirements 1.1, 1.2, 1.3, 5.1, 5.2, 7.2, 7.3**
//
// For any document session (PDF or DOCX) with any pageCount (0-20), the
// number of image content blocks in the Chat Lambda's Turn 3 Bedrock request
// SHALL equal pageCount when INCLUDE_PAGE_IMAGES_ON_INJECTION is 'true',
// and SHALL equal 0 when the flag is 'false' or unset.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simulate the Chat Lambda's Turn 3 message building logic for document sessions.
 *
 * This replicates the exact conditional logic from index.mjs:
 * 1. Attach native document block (always on Turn 3 for document sessions)
 * 2. Conditionally attach page images based on includePageImages flag
 * 3. Insert cache point after document/image blocks and before text block
 *
 * Returns the first user message's content array as it would be sent to Bedrock.
 */
function buildTurn3UserContent({ documentFormat, nativeDocBytes, pageCount, includePageImages, pageImageBytes, userMessageText }) {
  // Step 1: Start with document block + text block (native document attachment)
  const content = [
    { document: { format: documentFormat, name: 'document', source: { bytes: nativeDocBytes } } },
    { text: userMessageText },
  ]

  // Step 2: Conditionally attach page images (replicates the Chat Lambda's page image loop)
  // Condition: isDocumentAttachmentTurn && itemType === 'document' && pageCount > 0 && includePageImages
  if (pageCount > 0 && includePageImages) {
    const textIdx = content.findIndex(b => b.text)
    const insertAt = textIdx !== -1 ? textIdx : content.length

    for (let p = 0; p < pageCount; p++) {
      const bytes = pageImageBytes[p]
      if (bytes) {
        content.splice(insertAt + p, 0, { image: { format: 'png', source: { bytes } } })
      }
    }

    // Cache point after page images, before text
    const cacheTextIdx = content.findIndex(b => b.text)
    if (cacheTextIdx > 0) {
      content.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
    }
  }

  // Step 3: Cache point when page images were NOT attached
  // Condition: isDocumentAttachmentTurn && itemType === 'document' && nativeDocBytes && !(pageCount > 0 && includePageImages)
  if (nativeDocBytes && !(pageCount > 0 && includePageImages)) {
    const cacheTextIdx = content.findIndex(b => b.text)
    if (cacheTextIdx > 0) {
      content.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
    }
  }

  return content
}

// ── Generators for Property 1 ──

const pageCountArb = fc.integer({ min: 0, max: 20 })
const documentFormatArb = fc.constantFrom('pdf', 'docx')
const flagValueArb = fc.constantFrom('true', 'false', undefined)
const userMessageTextArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

/** Generate fake page image bytes for a given pageCount */
function makePageImageBytes(pageCount) {
  const bytes = []
  for (let i = 0; i < pageCount; i++) {
    bytes.push(Buffer.from(`page-${String(i + 1).padStart(3, '0')}-data`))
  }
  return bytes
}

describe('Feature: drop-page-images, Property 1: Feature flag controls page image inclusion in Turn 3', () => {

  it('image block count equals pageCount when flag is true, 0 when flag is false or unset', () => {
    // **Validates: Requirements 1.1, 1.2, 1.3, 5.1, 5.2, 7.2, 7.3**
    fc.assert(
      fc.property(
        pageCountArb,
        documentFormatArb,
        flagValueArb,
        userMessageTextArb,
        (pageCount, documentFormat, flagValue, userMessageText) => {
          const includePageImages = flagValue === 'true'
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages,
            pageImageBytes,
            userMessageText,
          })

          // Count image content blocks
          const imageBlocks = content.filter(b => b.image)

          if (includePageImages) {
            // Flag is 'true': image block count SHALL equal pageCount
            expect(imageBlocks.length).toBe(pageCount)
          } else {
            // Flag is 'false' or unset: image block count SHALL equal 0
            expect(imageBlocks.length).toBe(0)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document block is always present regardless of flag value (PDF sessions)', () => {
    // **Validates: Requirements 1.1, 5.1**
    fc.assert(
      fc.property(
        pageCountArb,
        fc.boolean(),
        userMessageTextArb,
        (pageCount, includePageImages, userMessageText) => {
          const nativeDocBytes = Buffer.from('fake-pdf-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat: 'pdf',
            nativeDocBytes,
            pageCount,
            includePageImages,
            pageImageBytes,
            userMessageText,
          })

          // Native PDF block SHALL always be present
          const docBlocks = content.filter(b => b.document)
          expect(docBlocks.length).toBe(1)
          expect(docBlocks[0].document.format).toBe('pdf')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document block is always present regardless of flag value (DOCX sessions)', () => {
    // **Validates: Requirements 1.2, 5.2**
    fc.assert(
      fc.property(
        pageCountArb,
        fc.boolean(),
        userMessageTextArb,
        (pageCount, includePageImages, userMessageText) => {
          const nativeDocBytes = Buffer.from('fake-docx-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat: 'docx',
            nativeDocBytes,
            pageCount,
            includePageImages,
            pageImageBytes,
            userMessageText,
          })

          // Native DOCX block SHALL always be present
          const docBlocks = content.filter(b => b.document)
          expect(docBlocks.length).toBe(1)
          expect(docBlocks[0].document.format).toBe('docx')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('flag value false and unset produce identical results (no images)', () => {
    // **Validates: Requirements 7.2, 7.3**
    fc.assert(
      fc.property(
        pageCountArb,
        documentFormatArb,
        userMessageTextArb,
        (pageCount, documentFormat, userMessageText) => {
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          // Flag = 'false'
          const contentFalse = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages: false,
            pageImageBytes,
            userMessageText,
          })

          // Flag = undefined (unset)
          const contentUnset = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages: undefined === 'true', // false
            pageImageBytes,
            userMessageText,
          })

          const imageBlocksFalse = contentFalse.filter(b => b.image)
          const imageBlocksUnset = contentUnset.filter(b => b.image)

          // Both SHALL produce 0 image blocks
          expect(imageBlocksFalse.length).toBe(0)
          expect(imageBlocksUnset.length).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: drop-page-images
// Property 2: Cache point position invariant
// **Validates: Requirements 1.4, 2.4**
//
// For any document session with a native document and any feature flag value,
// the document-level cache point in the first user message SHALL be positioned
// immediately after the last document or image content block and immediately
// before the text content block.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: drop-page-images, Property 2: Cache point position invariant', () => {

  it('cache point exists and is positioned between last doc/image block and text block', () => {
    // **Validates: Requirements 1.4, 2.4**
    fc.assert(
      fc.property(
        pageCountArb,
        documentFormatArb,
        flagValueArb,
        userMessageTextArb,
        (pageCount, documentFormat, flagValue, userMessageText) => {
          const includePageImages = flagValue === 'true'
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages,
            pageImageBytes,
            userMessageText,
          })

          // Find the cache point block
          const cachePointIdx = content.findIndex(b => b.cachePoint)
          expect(cachePointIdx).toBeGreaterThan(0) // cache point must exist and not be first

          // Block immediately before the cache point must be a document or image block
          const blockBefore = content[cachePointIdx - 1]
          const isDocOrImage = blockBefore.document !== undefined || blockBefore.image !== undefined
          expect(isDocOrImage).toBe(true)

          // Block immediately after the cache point must be a text block
          const blockAfter = content[cachePointIdx + 1]
          expect(blockAfter).toBeDefined()
          expect(blockAfter.text).toBeDefined()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('cache point is positioned after ALL image blocks when flag is true', () => {
    // **Validates: Requirements 1.4, 2.4**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // at least 1 page to ensure images exist
        documentFormatArb,
        userMessageTextArb,
        (pageCount, documentFormat, userMessageText) => {
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages: true,
            pageImageBytes,
            userMessageText,
          })

          const cachePointIdx = content.findIndex(b => b.cachePoint)

          // Every image block must appear before the cache point
          content.forEach((block, idx) => {
            if (block.image) {
              expect(idx).toBeLessThan(cachePointIdx)
            }
          })

          // The block immediately before the cache point should be the last image block
          const lastImageIdx = content.reduce((acc, b, i) => (b.image ? i : acc), -1)
          expect(lastImageIdx).toBe(cachePointIdx - 1)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('cache point is positioned directly after document block when flag is false', () => {
    // **Validates: Requirements 1.4, 2.4**
    fc.assert(
      fc.property(
        pageCountArb,
        documentFormatArb,
        userMessageTextArb,
        (pageCount, documentFormat, userMessageText) => {
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages: false,
            pageImageBytes,
            userMessageText,
          })

          const cachePointIdx = content.findIndex(b => b.cachePoint)

          // No image blocks should exist
          const imageBlocks = content.filter(b => b.image)
          expect(imageBlocks.length).toBe(0)

          // Block before cache point must be the document block
          const blockBefore = content[cachePointIdx - 1]
          expect(blockBefore.document).toBeDefined()
          expect(blockBefore.document.format).toBe(documentFormat)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('exactly one cache point exists in the content array', () => {
    // **Validates: Requirements 1.4, 2.4**
    fc.assert(
      fc.property(
        pageCountArb,
        documentFormatArb,
        flagValueArb,
        userMessageTextArb,
        (pageCount, documentFormat, flagValue, userMessageText) => {
          const includePageImages = flagValue === 'true'
          const nativeDocBytes = Buffer.from('fake-document-bytes')
          const pageImageBytes = makePageImageBytes(pageCount)

          const content = buildTurn3UserContent({
            documentFormat,
            nativeDocBytes,
            pageCount,
            includePageImages,
            pageImageBytes,
            userMessageText,
          })

          const cachePointCount = content.filter(b => b.cachePoint).length
          expect(cachePointCount).toBe(1)
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: drop-page-images
// Property 3: Cache prefix consistency across flag values
// **Validates: Requirements 2.3, 2.5, 7.4, 8.3**
//
// For any document session with any feature flag value, any pageCount, any
// document format, and any session state (currentSection, closingState,
// windingDown), the cache prefix (system prompt text + system cache point +
// document content blocks up to and including the document-level cache point)
// SHALL be byte-identical between the Priming Worker and the Chat Lambda's
// Turn 3 request.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: drop-page-images, Property 3: Cache prefix consistency across flag values', () => {

  // ── Generators ──

  const p3ItemNameArb = fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0)
  const p3ItemDescriptionArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
    fc.constant(''),
  )
  const p3ItemContentArb = fc.string({ minLength: 0, maxLength: 300 })
  const p3PageCountArb = fc.integer({ min: 0, max: 15 })
  const p3DocFormatArb = fc.constantFrom('pdf', 'docx')
  const p3TimeLimitArb = fc.integer({ min: 5, max: 60 })
  const p3IsSelfReviewArb = fc.boolean()
  const p3IncludePageImagesArb = fc.boolean()

  // Session state generators — by turn 3, these may have changed from initial values
  const p3CurrentSectionArb = fc.integer({ min: 1, max: 5 })
  const p3ClosingStateArb = fc.constantFrom('exploring', 'narrowing', 'closing')
  const p3WindingDownArb = fc.constantFrom(undefined, 'true', 'final')

  // Frozen snapshot generator
  const p3FrozenSnapshotArb = fc.tuple(
    fc.integer({ min: 1, max: 8 }),
    fc.constantFrom('deep', 'explore', 'skim'),
  ).chain(([numSections, defaultDepth]) => {
    const sectionIds = Array.from({ length: numSections }, (_, i) => `section-${i + 1}`)
    const sectionDepthPreferences = {}
    const sections = sectionIds.map((id, i) => ({
      id,
      title: `Section ${i + 1}`,
      wordCount: 100 + i * 50,
    }))
    for (const id of sectionIds) {
      sectionDepthPreferences[id] = defaultDepth
    }
    return fc.constant({
      feedbackSections: sectionIds,
      sectionDepthPreferences,
      sectionMap: { sections },
    })
  })

  // Coverage map generator (may be null)
  const p3CoverageMapArb = fc.oneof(
    fc.constant(null),
    fc.constant({ 'section-1': { sessionCount: 1, avgDepth: 'explore', reviewerIds: ['r1'] } }),
  )

  // Turn 3 conversation history generator
  const p3Turn3HistoryArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
  ).map(([greeting, userMsg1, assistantResp1, userMsg2, assistantResp2]) => [
    { role: 'assistant', content: greeting },
    { role: 'user', content: '[__session_start__]' },
    { role: 'assistant', content: assistantResp1 },
    { role: 'user', content: userMsg1 },
    { role: 'assistant', content: assistantResp2 },
  ])

  const p3UserMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // ── Helpers ──

  /** Generate deterministic fake document bytes for a given format */
  function fakeDocBytes(format) {
    return Buffer.from(`fake-${format}-document-bytes`)
  }

  /** Generate deterministic fake page image bytes for a given page number */
  function fakePageBytes(pageNum) {
    return Buffer.from(`fake-page-image-${pageNum}`)
  }

  /**
   * Builds the priming request exactly as primeCacheAsync.mjs does,
   * including the includePageImages flag.
   */
  function buildPrimingRequest({
    itemName, itemDescription, itemType, docFormat, nativeDocBytes,
    pageCount, includePageImages,
    frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
  }) {
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = 5
    }

    const systemPrompt = buildSystemPrompt({
      itemName: itemName || 'this item',
      itemDescription: itemDescription || '',
      itemContent: '',
      itemType,
      totalSections,
      currentSection: 1,
      closingState: 'exploring',
      windingDown: undefined,
      message: '',
      isSpecial: false,
      frozenSnapshot: frozenSnapshot || null,
      coverageMap: coverageMap || null,
      imageBase64: null,
      isSelfReview: isSelfReview || false,
      timeLimitMinutes: timeLimitMinutes || 30,
      nativeDocumentAvailable: true,
      includePageImages,
    })

    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    const userContent = []

    // Document block
    userContent.push({ document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } })

    // Page images — only when feature flag is enabled (matches primeCacheAsync.mjs)
    if (includePageImages) {
      for (let p = 1; p <= (pageCount || 0); p++) {
        const pageBytes = fakePageBytes(p)
        userContent.push({ image: { format: 'png', source: { bytes: pageBytes } } })
      }
    }

    // Cache point after document + images
    userContent.push({ cachePoint: { type: 'default' } })

    // Minimal placeholder user message
    userContent.push({ text: '[cache_priming]' })

    return {
      systemBlocks,
      messages: [{ role: 'user', content: userContent }],
    }
  }

  /**
   * Builds the turn 3 request exactly as the Chat Lambda does,
   * including the includePageImages flag.
   *
   * Prompt Cache Alignment: On the document injection turn, the Chat Lambda uses
   * initial-state values (currentSection: 1, closingState: 'exploring') for the
   * system prompt to match the priming call.
   */
  function buildTurn3Request({
    itemName, itemDescription, itemContent, itemType, docFormat, nativeDocBytes,
    pageCount, includePageImages,
    frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
    currentSection, closingState, windingDown,
    userMessage, history,
  }) {
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = 5
    }

    // Prompt Cache Alignment: use initial-state values to match priming call
    const systemPrompt = buildSystemPrompt({
      itemName,
      itemDescription,
      itemContent,
      itemType,
      totalSections,
      currentSection: 1,
      closingState: 'exploring',
      windingDown: undefined,
      message: '',
      isSpecial: false,
      frozenSnapshot: frozenSnapshot || null,
      coverageMap: coverageMap || null,
      imageBase64: null,
      isSelfReview,
      timeLimitMinutes,
      nativeDocumentAvailable: true,
      includePageImages,
    })

    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    // Build messages from history + new user message
    const bedrockMessages = [...history]
    bedrockMessages.push({ role: 'user', content: userMessage })

    // Coalesce consecutive same-role messages
    const coalescedMessages = []
    for (const msg of bedrockMessages) {
      const prev = coalescedMessages[coalescedMessages.length - 1]
      if (prev && prev.role === msg.role) {
        if (typeof prev.content === 'string' && typeof msg.content === 'string') {
          prev.content += '\n\n' + msg.content
        }
      } else {
        coalescedMessages.push({ ...msg })
      }
    }

    // Drop orphaned leading assistant messages
    while (coalescedMessages.length > 0 && coalescedMessages[0].role !== 'user') {
      coalescedMessages.shift()
    }

    // Normalize string content to content block arrays
    for (const msg of coalescedMessages) {
      if (typeof msg.content === 'string') {
        msg.content = [{ text: msg.content }]
      }
    }

    // Native document attachment — same as Chat Lambda turn 3
    const ext = docFormat
    const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
    if (firstUserIdx !== -1) {
      const firstMsg = coalescedMessages[firstUserIdx]
      const textContent = Array.isArray(firstMsg.content)
        ? (firstMsg.content.find(b => b.text)?.text || '')
        : (typeof firstMsg.content === 'string' ? firstMsg.content : '')
      coalescedMessages[firstUserIdx] = {
        role: 'user',
        content: [
          { document: { format: ext, name: 'document', source: { bytes: nativeDocBytes } } },
          { text: textContent },
        ],
      }
    }

    // Conditionally attach page images based on feature flag (same as Chat Lambda)
    if (pageCount > 0 && includePageImages) {
      const imgFirstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (imgFirstUserIdx !== -1) {
        const existingContent = [...coalescedMessages[imgFirstUserIdx].content]

        // Insert page images before the text block (after document block)
        const textIdx = existingContent.findIndex(b => b.text)
        const insertAt = textIdx !== -1 ? textIdx : existingContent.length

        for (let p = 1; p <= pageCount; p++) {
          const pageBytes = fakePageBytes(p)
          existingContent.splice(insertAt + (p - 1), 0, { image: { format: 'png', source: { bytes: pageBytes } } })
        }

        // Insert document-level cache point after all doc/image blocks, before text
        const cacheTextIdx = existingContent.findIndex(b => b.text)
        if (cacheTextIdx > 0) {
          existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
        }

        coalescedMessages[imgFirstUserIdx] = { role: 'user', content: existingContent }
      }
    } else {
      // No page images: insert cache point after document block, before text
      const cpFirstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (cpFirstUserIdx !== -1) {
        const existingContent = [...coalescedMessages[cpFirstUserIdx].content]
        const cacheTextIdx = existingContent.findIndex(b => b.text)
        if (cacheTextIdx > 0) {
          existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
        }
        coalescedMessages[cpFirstUserIdx] = { role: 'user', content: existingContent }
      }
    }

    return {
      systemBlocks,
      messages: coalescedMessages,
    }
  }

  /**
   * Extracts the cache prefix from a user message's content array:
   * all blocks up to and including the document-level cachePoint.
   */
  function extractUserCachePrefix(contentBlocks) {
    const cacheIdx = contentBlocks.findIndex(b => 'cachePoint' in b)
    if (cacheIdx === -1) return contentBlocks
    return contentBlocks.slice(0, cacheIdx + 1)
  }

  /**
   * Deep-compares two content block arrays, comparing bytes by value.
   */
  function contentBlocksEqual(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const blockA = a[i]
      const blockB = b[i]

      if ('cachePoint' in blockA && 'cachePoint' in blockB) {
        if (blockA.cachePoint.type !== blockB.cachePoint.type) return false
        continue
      }
      if ('text' in blockA && 'text' in blockB) {
        if (blockA.text !== blockB.text) return false
        continue
      }
      if ('document' in blockA && 'document' in blockB) {
        if (blockA.document.format !== blockB.document.format) return false
        if (blockA.document.name !== blockB.document.name) return false
        if (!Buffer.from(blockA.document.source.bytes).equals(Buffer.from(blockB.document.source.bytes))) return false
        continue
      }
      if ('image' in blockA && 'image' in blockB) {
        if (blockA.image.format !== blockB.image.format) return false
        if (!Buffer.from(blockA.image.source.bytes).equals(Buffer.from(blockB.image.source.bytes))) return false
        continue
      }
      // Different block types at same position
      return false
    }
    return true
  }

  // ── Property tests ──

  it('system prompt text is identical between priming and turn 3 for any flag value and session state', () => {
    // **Validates: Requirements 2.3, 2.5, 8.3**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3ItemDescriptionArb,
        p3ItemContentArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3TimeLimitArb,
        p3IsSelfReviewArb,
        p3IncludePageImagesArb,
        fc.oneof(p3FrozenSnapshotArb, fc.constant(null)),
        p3CoverageMapArb,
        p3Turn3HistoryArb,
        p3UserMessageArb,
        p3CurrentSectionArb,
        p3ClosingStateArb,
        p3WindingDownArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, includePageImages, frozenSnapshot, coverageMap, history, userMessage, currentSection, closingState, windingDown) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            currentSection, closingState, windingDown,
            userMessage, history,
          })

          // Property: system prompt text is identical even when session state has changed
          expect(priming.systemBlocks[0].text).toBe(turn3.systemBlocks[0].text)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('system-level cache point is identical between priming and turn 3 for any flag value', () => {
    // **Validates: Requirements 2.3, 2.5**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3IncludePageImagesArb,
        (itemName, docFormat, pageCount, includePageImages) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot: null, timeLimitMinutes: 30, isSelfReview: false, coverageMap: null,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription: '', itemContent: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot: null, timeLimitMinutes: 30, isSelfReview: false, coverageMap: null,
            currentSection: 2, closingState: 'narrowing', windingDown: 'true',
            userMessage: 'test message',
            history: [
              { role: 'assistant', content: 'greeting' },
              { role: 'user', content: '[__session_start__]' },
              { role: 'assistant', content: 'response 1' },
              { role: 'user', content: 'msg 1' },
              { role: 'assistant', content: 'response 2' },
            ],
          })

          // Both system blocks have exactly 2 elements
          expect(priming.systemBlocks).toHaveLength(2)
          expect(turn3.systemBlocks).toHaveLength(2)

          // System-level cache point is identical
          expect(priming.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })
          expect(turn3.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document/image cache prefix is byte-identical between priming and turn 3 for any flag value', () => {
    // **Validates: Requirements 2.3, 2.5, 7.4, 8.3**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3ItemDescriptionArb,
        p3ItemContentArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3TimeLimitArb,
        p3IsSelfReviewArb,
        p3IncludePageImagesArb,
        fc.oneof(p3FrozenSnapshotArb, fc.constant(null)),
        p3CoverageMapArb,
        p3Turn3HistoryArb,
        p3UserMessageArb,
        p3CurrentSectionArb,
        p3ClosingStateArb,
        p3WindingDownArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, includePageImages, frozenSnapshot, coverageMap, history, userMessage, currentSection, closingState, windingDown) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            currentSection, closingState, windingDown,
            userMessage, history,
          })

          // Extract the first user message content from both
          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          expect(turn3FirstUserIdx).toBeGreaterThanOrEqual(0)
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          // Extract cache prefix (everything up to and including the document-level cachePoint)
          const primingPrefix = extractUserCachePrefix(primingContent)
          const turn3Prefix = extractUserCachePrefix(turn3Content)

          // Cache prefixes have the same length
          expect(primingPrefix.length).toBe(turn3Prefix.length)

          // Cache prefixes are byte-identical (document bytes, image bytes, cache point)
          expect(contentBlocksEqual(primingPrefix, turn3Prefix)).toBe(true)

          // Prefix structure depends on flag value
          if (includePageImages) {
            // [document, image*, cachePoint]
            expect(primingPrefix.length).toBe(1 + pageCount + 1)
          } else {
            // [document, cachePoint]
            expect(primingPrefix.length).toBe(2)
          }

          // First block is always a document block
          expect(primingPrefix[0]).toHaveProperty('document')
          expect(turn3Prefix[0]).toHaveProperty('document')

          // Last block in prefix is always a cachePoint
          expect(primingPrefix[primingPrefix.length - 1]).toEqual({ cachePoint: { type: 'default' } })
          expect(turn3Prefix[turn3Prefix.length - 1]).toEqual({ cachePoint: { type: 'default' } })
        },
      ),
      { numRuns: 100 },
    )
  })

  it('full cache prefix (system + user) is identical for flag=false with varying session state', () => {
    // **Validates: Requirements 2.5, 8.3**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3ItemDescriptionArb,
        p3ItemContentArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3TimeLimitArb,
        p3IsSelfReviewArb,
        fc.oneof(p3FrozenSnapshotArb, fc.constant(null)),
        p3CoverageMapArb,
        p3Turn3HistoryArb,
        p3UserMessageArb,
        p3CurrentSectionArb,
        p3ClosingStateArb,
        p3WindingDownArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, frozenSnapshot, coverageMap, history, userMessage, currentSection, closingState, windingDown) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages: false,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages: false,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            currentSection, closingState, windingDown,
            userMessage, history,
          })

          // System prompt text identical
          expect(priming.systemBlocks[0].text).toBe(turn3.systemBlocks[0].text)

          // System cache point identical
          expect(priming.systemBlocks[1]).toEqual(turn3.systemBlocks[1])

          // User content cache prefix identical
          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          const primingPrefix = extractUserCachePrefix(primingContent)
          const turn3Prefix = extractUserCachePrefix(turn3Content)

          expect(contentBlocksEqual(primingPrefix, turn3Prefix)).toBe(true)

          // No image blocks in prefix when flag=false
          const imageBlocksInPrefix = primingPrefix.filter(b => 'image' in b)
          expect(imageBlocksInPrefix.length).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('full cache prefix (system + user) is identical for flag=true with varying session state', () => {
    // **Validates: Requirements 2.3, 7.4**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3ItemDescriptionArb,
        p3ItemContentArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3TimeLimitArb,
        p3IsSelfReviewArb,
        fc.oneof(p3FrozenSnapshotArb, fc.constant(null)),
        p3CoverageMapArb,
        p3Turn3HistoryArb,
        p3UserMessageArb,
        p3CurrentSectionArb,
        p3ClosingStateArb,
        p3WindingDownArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, frozenSnapshot, coverageMap, history, userMessage, currentSection, closingState, windingDown) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages: true,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages: true,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            currentSection, closingState, windingDown,
            userMessage, history,
          })

          // System prompt text identical
          expect(priming.systemBlocks[0].text).toBe(turn3.systemBlocks[0].text)

          // System cache point identical
          expect(priming.systemBlocks[1]).toEqual(turn3.systemBlocks[1])

          // User content cache prefix identical
          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          const primingPrefix = extractUserCachePrefix(primingContent)
          const turn3Prefix = extractUserCachePrefix(turn3Content)

          expect(contentBlocksEqual(primingPrefix, turn3Prefix)).toBe(true)

          // Image blocks in prefix should equal pageCount when flag=true
          const imageBlocksInPrefix = primingPrefix.filter(b => 'image' in b)
          expect(imageBlocksInPrefix.length).toBe(pageCount)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('no dynamic data appears above the document-level cache point in either request', () => {
    // **Validates: Requirements 2.5**
    fc.assert(
      fc.property(
        p3ItemNameArb,
        p3DocFormatArb,
        p3PageCountArb,
        p3IncludePageImagesArb,
        p3Turn3HistoryArb,
        p3UserMessageArb,
        p3CurrentSectionArb,
        p3ClosingStateArb,
        p3WindingDownArb,
        (itemName, docFormat, pageCount, includePageImages, history, userMessage, currentSection, closingState, windingDown) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const turn3 = buildTurn3Request({
            itemName, itemDescription: '', itemContent: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, includePageImages,
            frozenSnapshot: null, timeLimitMinutes: 30, isSelfReview: false, coverageMap: null,
            currentSection, closingState, windingDown,
            userMessage, history,
          })

          // Extract the first user message content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          // Extract cache prefix
          const turn3Prefix = extractUserCachePrefix(turn3Content)

          // No text blocks should appear in the prefix (text is always after the cache point)
          const textBlocksInPrefix = turn3Prefix.filter(b => 'text' in b)
          expect(textBlocksInPrefix.length).toBe(0)

          // Only document, image, and cachePoint blocks in the prefix
          for (const block of turn3Prefix) {
            const isAllowed = 'document' in block || 'image' in block || 'cachePoint' in block
            expect(isAllowed).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
