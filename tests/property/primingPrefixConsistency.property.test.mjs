// Property-based tests for Phased Cache Priming — Property 2: Priming prefix matches turn 3
// Feature: phased-cache-priming, Property 2: priming call prefix matches turn 3 prefix
// **Validates: Requirements 1.7, 5.1, 5.2, 5.3, 5.4, 5.6**
//
// For any document session with a native document, the system prompt, document content block,
// page image blocks, and cache point markers in the priming call SHALL be identical to those
// in the Chat Lambda's turn 3 request for the same session — ensuring a cache hit.

import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('AWS_REGION', 'us-west-2')

// ── AWS SDK mocks (needed for buildSystemPrompt import chain) ──

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ── Generators ──

const itemNameArb = fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0)
const itemDescriptionArb = fc.string({ minLength: 0, maxLength: 300 })
const itemContentArb = fc.string({ minLength: 0, maxLength: 500 })
const pageCountArb = fc.integer({ min: 0, max: 15 })
const docFormatArb = fc.constantFrom('pdf', 'docx')
const totalSectionsArb = fc.integer({ min: 1, max: 10 })
const timeLimitArb = fc.integer({ min: 5, max: 60 })
const isSelfReviewArb = fc.boolean()

// Generate a frozen snapshot with feedback sections and depth preferences
const frozenSnapshotArb = fc.tuple(
  fc.integer({ min: 1, max: 8 }),
  fc.constantFrom('deep', 'explore', 'skim'),
).chain(([numSections, defaultDepth]) => {
  const sectionIds = Array.from({ length: numSections }, (_, i) => `section-${i + 1}`)
  const feedbackSections = sectionIds
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
    feedbackSections,
    sectionDepthPreferences,
    sectionMap: { sections },
  })
})

// Coverage map generator (may be null)
const coverageMapArb = fc.oneof(
  fc.constant(null),
  fc.constant({ 'section-1': { sessionCount: 1, avgDepth: 'explore', reviewerIds: ['r1'] } }),
)

// Generate fake document bytes (deterministic for a given format)
function fakeDocBytes(format) {
  return Buffer.from(`fake-${format}-document-bytes`)
}

// Generate fake page image bytes (deterministic for a given page number)
function fakePageBytes(pageNum) {
  return Buffer.from(`fake-page-image-${pageNum}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 2: Priming call prefix matches turn 3 prefix
// **Validates: Requirements 1.7, 5.1, 5.2, 5.3, 5.4, 5.6**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 2: priming call prefix matches turn 3 prefix', () => {

  /**
   * Builds the priming request exactly as primeCacheAsync.mjs does.
   *
   * The priming module:
   *   1. Builds system prompt with nativeDocumentAvailable: true, initial session state
   *   2. Constructs system blocks: [{ text: systemPrompt }, { cachePoint }]
   *   3. Constructs user content: [document, ...images, cachePoint, text]
   */
  function buildPrimingRequest({
    itemName, itemDescription, itemType, docFormat, nativeDocBytes,
    pageCount, tenantId, itemId,
    frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
  }) {
    // Determine totalSections from frozenSnapshot (same as primeCacheAsync.mjs)
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = 5
    }

    // Build system prompt with same parameters as primeCacheAsync.mjs
    const systemPrompt = buildSystemPrompt({
      itemName: itemName || 'this item',
      itemDescription: itemDescription || '',
      itemContent: '',  // Not needed when nativeDocumentAvailable is true
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
    })

    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    // Build user content blocks — same structure as primeCacheAsync.mjs
    const userContent = []

    // Document block
    userContent.push({ document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } })

    // Page images (same order as primeCacheAsync)
    for (let p = 1; p <= (pageCount || 0); p++) {
      const pageBytes = fakePageBytes(p)
      userContent.push({ image: { format: 'png', source: { bytes: pageBytes } } })
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
   * Builds the turn 3 request exactly as the Chat Lambda does.
   *
   * At turn 3:
   *   - turnNumber >= 3, so isDocumentInjectionTurn = true
   *   - nativeDocumentAvailable = true (nativeDocBytes loaded)
   *   - System prompt built with nativeDocumentAvailable: true
   *   - templateGreeting removed (no longer a parameter)
   *   - Document block + page images + cachePoint inserted into first user message
   *
   * The Chat Lambda builds the first user message content as:
   *   1. Start with [document, text] (native doc attachment)
   *   2. Insert page images before the text block
   *   3. Insert cachePoint before the text block (after all doc/image blocks)
   */
  function buildTurn3Request({
    itemName, itemDescription, itemContent, itemType, docFormat, nativeDocBytes,
    pageCount, tenantId, itemId,
    frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
    userMessage, history,
  }) {
    // Determine totalSections from frozenSnapshot (same as Chat Lambda)
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = 5
    }

    // Build system prompt with same parameters as Chat Lambda at turn 3
    // At turn 3: currentSection=1 (initial), closingState='exploring' (initial),
    // nativeDocumentAvailable=true
    const systemPrompt = buildSystemPrompt({
      itemName,
      itemDescription,
      itemContent,
      itemType,
      totalSections,
      currentSection: 1,
      closingState: 'exploring',
      windingDown: undefined,
      message: userMessage,
      isSpecial: false,
      frozenSnapshot: frozenSnapshot || null,
      coverageMap: coverageMap || null,
      imageBase64: null,
      isSelfReview,
      timeLimitMinutes,
      nativeDocumentAvailable: true,
    })

    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    // Build messages from history + new user message (same as Chat Lambda)
    const bedrockMessages = [...history]
    bedrockMessages.push({ role: 'user', content: userMessage })

    // Coalesce consecutive same-role messages (same as Chat Lambda)
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

    // Attach page images on document injection turn (same as Chat Lambda)
    if (pageCount > 0) {
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
      // pageCount === 0: separate cache point insertion (same as Chat Lambda)
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
  function extractCachePrefix(contentBlocks) {
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

  // Generator: turn 3 conversation history (2 prior user messages + 2 assistant responses)
  // At turn 3, there are exactly 2 prior user messages in the transcript.
  const turn3HistoryArb = fc.tuple(
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // greeting (assistant)
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // user msg 1
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // assistant response 1
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // user msg 2
    fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),  // assistant response 2
  ).map(([greeting, userMsg1, assistantResp1, userMsg2, assistantResp2]) => [
    { role: 'assistant', content: greeting },
    { role: 'user', content: `[__session_start__]` },
    { role: 'assistant', content: assistantResp1 },
    { role: 'user', content: userMsg1 },
    { role: 'assistant', content: assistantResp2 },
  ])

  // Generator: the turn 3 user message
  const userMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  it('for any document session, priming and turn 3 have identical system prompt text', () => {
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        itemContentArb,
        docFormatArb,
        pageCountArb,
        timeLimitArb,
        isSelfReviewArb,
        fc.oneof(frozenSnapshotArb, fc.constant(null)),
        coverageMapArb,
        turn3HistoryArb,
        userMessageArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, frozenSnapshot, coverageMap, history, userMessage) => {
          const tenantId = 'tenant-test'
          const itemId = 'item-test'
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId, itemId,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId, itemId,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            userMessage, history,
          })

          // Property: system prompt text is identical
          expect(priming.systemBlocks[0].text).toBe(turn3.systemBlocks[0].text)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any document session, priming and turn 3 have identical system-level cache point', () => {
    fc.assert(
      fc.property(
        itemNameArb,
        docFormatArb,
        pageCountArb,
        timeLimitArb,
        isSelfReviewArb,
        (itemName, docFormat, pageCount, timeLimitMinutes, isSelfReview) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes, isSelfReview, coverageMap: null,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription: '', itemContent: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes, isSelfReview, coverageMap: null,
            userMessage: 'test message',
            history: [
              { role: 'assistant', content: 'greeting' },
              { role: 'user', content: '[__session_start__]' },
              { role: 'assistant', content: 'response 1' },
              { role: 'user', content: 'msg 1' },
              { role: 'assistant', content: 'response 2' },
            ],
          })

          // Property: both system blocks have exactly 2 elements
          expect(priming.systemBlocks).toHaveLength(2)
          expect(turn3.systemBlocks).toHaveLength(2)

          // Property: system-level cache point is identical
          expect(priming.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })
          expect(turn3.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any document session, priming and turn 3 have identical document/image cache prefix', () => {
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        itemContentArb,
        docFormatArb,
        pageCountArb,
        timeLimitArb,
        isSelfReviewArb,
        fc.oneof(frozenSnapshotArb, fc.constant(null)),
        coverageMapArb,
        turn3HistoryArb,
        userMessageArb,
        (itemName, itemDescription, itemContent, docFormat, pageCount, timeLimitMinutes, isSelfReview, frozenSnapshot, coverageMap, history, userMessage) => {
          const tenantId = 'tenant-test'
          const itemId = 'item-test'
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId, itemId,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription, itemContent, itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId, itemId,
            frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
            userMessage, history,
          })

          // Extract the first user message content from both
          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          expect(turn3FirstUserIdx).toBeGreaterThanOrEqual(0)
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          // Extract cache prefix (everything up to and including the document-level cachePoint)
          const primingPrefix = extractCachePrefix(primingContent)
          const turn3Prefix = extractCachePrefix(turn3Content)

          // Property: cache prefixes have the same length
          expect(primingPrefix.length).toBe(turn3Prefix.length)

          // Property: cache prefixes are identical (document bytes, image bytes, cache point)
          expect(contentBlocksEqual(primingPrefix, turn3Prefix)).toBe(true)

          // Property: prefix structure is [document, image*, cachePoint]
          expect(primingPrefix.length).toBe(1 + pageCount + 1) // doc + images + cachePoint

          // Property: first block is a document block
          expect(primingPrefix[0]).toHaveProperty('document')
          expect(turn3Prefix[0]).toHaveProperty('document')

          // Property: last block in prefix is a cachePoint
          expect(primingPrefix[primingPrefix.length - 1]).toEqual({ cachePoint: { type: 'default' } })
          expect(turn3Prefix[turn3Prefix.length - 1]).toEqual({ cachePoint: { type: 'default' } })

          // Property: all middle blocks are image blocks
          for (let i = 1; i < primingPrefix.length - 1; i++) {
            expect(primingPrefix[i]).toHaveProperty('image')
            expect(turn3Prefix[i]).toHaveProperty('image')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any document session, page images are in the same order in priming and turn 3', () => {
    fc.assert(
      fc.property(
        docFormatArb,
        fc.integer({ min: 1, max: 20 }),  // at least 1 page to verify ordering
        (docFormat, pageCount) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName: 'Test', itemDescription: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes: 30, isSelfReview: false, coverageMap: null,
          })

          const turn3 = buildTurn3Request({
            itemName: 'Test', itemDescription: '', itemContent: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes: 30, isSelfReview: false, coverageMap: null,
            userMessage: 'test',
            history: [
              { role: 'assistant', content: 'greeting' },
              { role: 'user', content: '[__session_start__]' },
              { role: 'assistant', content: 'r1' },
              { role: 'user', content: 'm1' },
              { role: 'assistant', content: 'r2' },
            ],
          })

          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          // Extract image blocks from both
          const primingImages = primingContent.filter(b => 'image' in b)
          const turn3Images = turn3Content.filter(b => 'image' in b)

          // Property: same number of images
          expect(primingImages.length).toBe(pageCount)
          expect(turn3Images.length).toBe(pageCount)

          // Property: images are in the same order (same bytes)
          for (let i = 0; i < primingImages.length; i++) {
            expect(primingImages[i].image.format).toBe(turn3Images[i].image.format)
            expect(
              Buffer.from(primingImages[i].image.source.bytes).equals(
                Buffer.from(turn3Images[i].image.source.bytes)
              )
            ).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any document session with 0 pages, cache prefix still matches between priming and turn 3', () => {
    fc.assert(
      fc.property(
        itemNameArb,
        docFormatArb,
        timeLimitArb,
        isSelfReviewArb,
        (itemName, docFormat, timeLimitMinutes, isSelfReview) => {
          const nativeDocBytes = fakeDocBytes(docFormat)

          const priming = buildPrimingRequest({
            itemName, itemDescription: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount: 0, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes, isSelfReview, coverageMap: null,
          })

          const turn3 = buildTurn3Request({
            itemName, itemDescription: '', itemContent: '', itemType: 'document', docFormat, nativeDocBytes,
            pageCount: 0, tenantId: 't', itemId: 'i',
            frozenSnapshot: null, timeLimitMinutes, isSelfReview, coverageMap: null,
            userMessage: 'test',
            history: [
              { role: 'assistant', content: 'greeting' },
              { role: 'user', content: '[__session_start__]' },
              { role: 'assistant', content: 'r1' },
              { role: 'user', content: 'm1' },
              { role: 'assistant', content: 'r2' },
            ],
          })

          const primingContent = priming.messages[0].content
          const turn3FirstUserIdx = turn3.messages.findIndex(m => m.role === 'user')
          const turn3Content = turn3.messages[turn3FirstUserIdx].content

          const primingPrefix = extractCachePrefix(primingContent)
          const turn3Prefix = extractCachePrefix(turn3Content)

          // Property: prefix is [document, cachePoint] when 0 pages
          expect(primingPrefix.length).toBe(2)
          expect(turn3Prefix.length).toBe(2)

          // Property: prefixes are identical
          expect(contentBlocksEqual(primingPrefix, turn3Prefix)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})
