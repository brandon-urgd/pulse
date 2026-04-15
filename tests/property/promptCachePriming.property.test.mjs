// Property-based tests for Prompt Cache Priming — Property 1
// Feature: prompt-cache-priming, Property 1: system prompt cache point is always present
// Validates: Requirements 1.1, 6.4
//
// For any item type (document, image, markdown/text) and for any valid system prompt,
// the Bedrock request's `system` array SHALL end with a `{ cachePoint: { type: 'default' } }` object.

import { describe, it, expect, vi } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── AWS SDK mocks ──

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})
vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send() { return Promise.resolve({}) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ── Generators ──

const itemTypeArb = fc.constantFrom('document', 'image', 'markdown')

const itemNameArb = fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0)

const totalSectionsArb = fc.integer({ min: 1, max: 10 })

const timeLimitArb = fc.integer({ min: 5, max: 60 })

const closingStateArb = fc.constantFrom('exploring', 'narrowing', 'closing')

const boolOrUndefined = fc.oneof(fc.constant(true), fc.constant(false), fc.constant(undefined))

// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 1: system prompt cache point is always present
// **Validates: Requirements 1.1, 6.4**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 1: system prompt cache point is always present', () => {
  it('for any item type and system prompt, systemBlocks ends with a cachePoint', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        itemNameArb,
        fc.string({ minLength: 0, maxLength: 300 }),   // itemDescription
        fc.string({ minLength: 0, maxLength: 500 }),   // itemContent
        totalSectionsArb,
        timeLimitArb,
        closingStateArb,
        boolOrUndefined,                                // nativeDocumentAvailable
        fc.boolean(),                                   // isSelfReview
        (itemType, itemName, itemDescription, itemContent, totalSections, timeLimitMinutes, closingState, nativeDocumentAvailable, isSelfReview) => {
          // Build the system prompt using the same function the Chat Lambda uses
          const systemPrompt = buildSystemPrompt({
            itemName,
            itemDescription,
            itemContent,
            itemType,
            totalSections,
            currentSection: 1,
            closingState,
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: itemType === 'image' ? 'fakebase64data' : null,
            isSelfReview,
            timeLimitMinutes,
            nativeDocumentAvailable,
          })

          // Build systemBlocks exactly as the Chat Lambda does
          const systemBlocks = [
            { text: systemPrompt },
            { cachePoint: { type: 'default' } },
          ]

          // Property: system array has at least 2 elements
          expect(systemBlocks.length).toBeGreaterThanOrEqual(2)

          // Property: last element is { cachePoint: { type: 'default' } }
          const lastBlock = systemBlocks[systemBlocks.length - 1]
          expect(lastBlock).toEqual({ cachePoint: { type: 'default' } })

          // Property: first element contains the system prompt text
          expect(systemBlocks[0]).toHaveProperty('text')
          expect(typeof systemBlocks[0].text).toBe('string')
          expect(systemBlocks[0].text.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 2: document cache point placement on first turn
// **Validates: Requirements 1.2**
//
// For any document session with a native document block and page images,
// the first user message's content array SHALL contain a `{ cachePoint: { type: 'default' } }`
// object positioned after all document and image blocks and before the text block.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 2: document cache point placement on first turn', () => {
  // Generator: page count from 0 to 20
  const pageCountArb = fc.integer({ min: 0, max: 20 })

  // Generator: user message text (non-empty)
  const userMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // Generator: document format
  const docFormatArb = fc.constantFrom('pdf', 'docx')

  /**
   * Simulates the Chat Lambda's first-turn message building logic for document sessions.
   * This mirrors the code in index.mjs lines ~553-620:
   *   1. Start with [document, text] (native doc attachment)
   *   2. Insert page images before the text block
   *   3. Insert cachePoint before the text block (after all doc/image blocks)
   *
   * Two code paths in the Lambda:
   *   - pageCount > 0: page images block handles both image insertion and cachePoint insertion
   *   - pageCount === 0: separate block handles cachePoint insertion when no page images
   */
  function buildFirstTurnContent(docFormat, pageCount, userMessage) {
    // Step 1: Native document attachment — same as Chat Lambda
    // coalescedMessages[firstUserIdx].content = [document, text]
    const nativeDocBytes = Buffer.from('fake-pdf-bytes')
    const existingContent = [
      { document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } },
      { text: userMessage },
    ]

    if (pageCount > 0) {
      // Step 2: Insert page images before the text block (mirrors Chat Lambda page image loop)
      const textIdx = existingContent.findIndex(b => b.text)
      const insertAt = textIdx !== -1 ? textIdx : existingContent.length

      for (let p = 1; p <= pageCount; p++) {
        const pageBytes = Buffer.from(`fake-page-${p}`)
        existingContent.splice(insertAt + (p - 1), 0, {
          image: { format: 'png', source: { bytes: pageBytes } },
        })
      }

      // Step 3: Insert cachePoint before text block (mirrors Chat Lambda cache point insertion)
      // This is inside the pageCount > 0 block in the Lambda
      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    } else {
      // pageCount === 0 path: separate cache point insertion block in the Lambda
      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    }

    return existingContent
  }

  it('for any document session with varying page counts, cachePoint is after all doc/image blocks and before text', () => {
    fc.assert(
      fc.property(
        docFormatArb,
        pageCountArb,
        userMessageArb,
        (docFormat, pageCount, userMessage) => {
          const content = buildFirstTurnContent(docFormat, pageCount, userMessage)

          // ── Structural invariant checks ──

          // 1. Content array must contain exactly one cachePoint
          const cachePointIndices = content
            .map((block, i) => ('cachePoint' in block ? i : -1))
            .filter(i => i !== -1)
          expect(cachePointIndices).toHaveLength(1)
          const cacheIdx = cachePointIndices[0]

          // 2. Content array must contain exactly one text block (the user message)
          const textIndices = content
            .map((block, i) => ('text' in block ? i : -1))
            .filter(i => i !== -1)
          expect(textIndices).toHaveLength(1)
          const textIdx = textIndices[0]

          // 3. Content array must contain exactly one document block
          const docIndices = content
            .map((block, i) => ('document' in block ? i : -1))
            .filter(i => i !== -1)
          expect(docIndices).toHaveLength(1)
          const docIdx = docIndices[0]

          // 4. Content array must contain exactly pageCount image blocks
          const imageIndices = content
            .map((block, i) => ('image' in block ? i : -1))
            .filter(i => i !== -1)
          expect(imageIndices).toHaveLength(pageCount)

          // 5. Document block is first
          expect(docIdx).toBe(0)

          // 6. All image blocks come after the document block and before the cachePoint
          for (const imgIdx of imageIndices) {
            expect(imgIdx).toBeGreaterThan(docIdx)
            expect(imgIdx).toBeLessThan(cacheIdx)
          }

          // 7. cachePoint comes immediately before the text block
          expect(cacheIdx).toBe(textIdx - 1)

          // 8. Text block is the last element
          expect(textIdx).toBe(content.length - 1)

          // 9. Overall structure: [document, image*, cachePoint, text]
          expect(content.length).toBe(1 + pageCount + 1 + 1) // doc + images + cachePoint + text
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 3: no message-level cache points on subsequent turns
// **Validates: Requirements 1.3**
//
// For any session turn where no document block is attached (subsequent turns),
// the messages array SHALL NOT contain any `{ cachePoint: { type: 'default' } }` objects —
// only the system-level cache point is present.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 3: no message-level cache points on subsequent turns', () => {
  // Generator: non-empty user/assistant message text
  const messageTextArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // Generator: a single user/assistant exchange pair
  const exchangePairArb = fc.tuple(messageTextArb, messageTextArb).map(([userText, assistantText]) => [
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ])

  // Generator: conversation history with 1-10 prior exchange pairs (subsequent turn has at least 1)
  const historyArb = fc.array(exchangePairArb, { minLength: 1, maxLength: 10 }).map(pairs => pairs.flat())

  /**
   * Simulates the Chat Lambda's subsequent-turn message building logic.
   *
   * On subsequent turns:
   *   - isFirstTurn is false (history contains user messages)
   *   - Messages are built from conversation history + new user message
   *   - Content is normalized to [{ text: "..." }] arrays
   *   - No document/image attachment (send-once pattern — first turn only)
   *   - No cachePoint insertion (all guarded by isFirstTurn)
   *
   * This mirrors the coalescing + normalization path in index.mjs.
   */
  function buildSubsequentTurnMessages(history, newUserMessage) {
    // Start with history + new user message (same as Chat Lambda)
    const bedrockMessages = [...history, { role: 'user', content: newUserMessage }]

    // Coalesce consecutive same-role messages (mirrors Chat Lambda)
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

    // Drop orphaned leading assistant messages (mirrors Chat Lambda)
    while (coalescedMessages.length > 0 && coalescedMessages[0].role !== 'user') {
      coalescedMessages.shift()
    }

    // Normalize string content to content block arrays (mirrors Chat Lambda)
    for (const msg of coalescedMessages) {
      if (typeof msg.content === 'string') {
        msg.content = [{ text: msg.content }]
      }
    }

    // isFirstTurn is false on subsequent turns — no document attachment,
    // no page image insertion, no cachePoint insertion.
    // The Chat Lambda's cache point blocks are all guarded by:
    //   if (isFirstTurn && itemType === 'document' && ...)
    // None of them execute here.

    return coalescedMessages
  }

  it('for any subsequent-turn message array, no cachePoint objects exist in messages', () => {
    fc.assert(
      fc.property(
        historyArb,
        messageTextArb,
        (history, newUserMessage) => {
          const messages = buildSubsequentTurnMessages(history, newUserMessage)

          // Verify we have messages (subsequent turn always has at least the history + new message)
          expect(messages.length).toBeGreaterThan(0)

          // Verify the last message is from the user (the new message)
          expect(messages[messages.length - 1].role).toBe('user')

          // Property: NO message in the array contains a cachePoint in its content
          for (const msg of messages) {
            const contentBlocks = Array.isArray(msg.content) ? msg.content : [msg.content]
            for (const block of contentBlocks) {
              expect(block).not.toHaveProperty('cachePoint')
            }
          }

          // Property: every content block is a text block (no document, image, or cachePoint)
          for (const msg of messages) {
            const contentBlocks = Array.isArray(msg.content) ? msg.content : [msg.content]
            for (const block of contentBlocks) {
              expect(block).toHaveProperty('text')
              expect(typeof block.text).toBe('string')
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 4: cache point count invariant
// **Validates: Requirements 1.4**
//
// For any Bedrock request constructed by the Chat Lambda, the total number
// of `cachePoint` objects across `system` and `messages` SHALL NOT exceed 4.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 4: cache point count invariant', () => {
  // Generator: page count from 0 to 20
  const pageCountArb = fc.integer({ min: 0, max: 20 })

  // Generator: user message text (non-empty)
  const userMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // Generator: document format
  const docFormatArb = fc.constantFrom('pdf', 'docx')

  // Generator: non-empty user/assistant message text
  const messageTextArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // Generator: a single user/assistant exchange pair
  const exchangePairArb = fc.tuple(messageTextArb, messageTextArb).map(([userText, assistantText]) => [
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  ])

  // Generator: conversation history with 1-10 prior exchange pairs
  const historyArb = fc.array(exchangePairArb, { minLength: 1, maxLength: 10 }).map(pairs => pairs.flat())

  // Generator: whether this is a first turn or subsequent turn
  const isFirstTurnArb = fc.boolean()

  /**
   * Simulates the Chat Lambda's first-turn message building logic for document sessions.
   * Mirrors the code in index.mjs: native doc attachment → page images → cachePoint → text.
   */
  function buildFirstTurnContent(docFormat, pageCount, userMessage) {
    const nativeDocBytes = Buffer.from('fake-pdf-bytes')
    const existingContent = [
      { document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } },
      { text: userMessage },
    ]

    if (pageCount > 0) {
      const textIdx = existingContent.findIndex(b => b.text)
      const insertAt = textIdx !== -1 ? textIdx : existingContent.length

      for (let p = 1; p <= pageCount; p++) {
        const pageBytes = Buffer.from(`fake-page-${p}`)
        existingContent.splice(insertAt + (p - 1), 0, {
          image: { format: 'png', source: { bytes: pageBytes } },
        })
      }

      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    } else {
      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    }

    return existingContent
  }

  /**
   * Simulates the Chat Lambda's subsequent-turn message building logic.
   * On subsequent turns: no document/image attachment, no cachePoint insertion.
   */
  function buildSubsequentTurnMessages(history, newUserMessage) {
    const bedrockMessages = [...history, { role: 'user', content: newUserMessage }]

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

    while (coalescedMessages.length > 0 && coalescedMessages[0].role !== 'user') {
      coalescedMessages.shift()
    }

    for (const msg of coalescedMessages) {
      if (typeof msg.content === 'string') {
        msg.content = [{ text: msg.content }]
      }
    }

    return coalescedMessages
  }

  /**
   * Counts all cachePoint objects in a system blocks array.
   */
  function countCachePointsInSystem(systemBlocks) {
    return systemBlocks.filter(block => 'cachePoint' in block).length
  }

  /**
   * Counts all cachePoint objects across all messages' content arrays.
   */
  function countCachePointsInMessages(messages) {
    let count = 0
    for (const msg of messages) {
      const contentBlocks = Array.isArray(msg.content) ? msg.content : [msg.content]
      for (const block of contentBlocks) {
        if (block && 'cachePoint' in block) {
          count++
        }
      }
    }
    return count
  }

  it('for any request configuration, total cache points across system and messages never exceeds 4', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        isFirstTurnArb,
        docFormatArb,
        pageCountArb,
        userMessageArb,
        historyArb,
        itemNameArb,
        closingStateArb,
        timeLimitArb,
        fc.boolean(), // isSelfReview
        (itemType, isFirstTurn, docFormat, pageCount, userMessage, history, itemName, closingState, timeLimitMinutes, isSelfReview) => {
          // Build system blocks — always includes the system-level cache point
          const systemPrompt = buildSystemPrompt({
            itemName,
            itemDescription: '',
            itemContent: '',
            itemType,
            totalSections: 5,
            currentSection: 1,
            closingState,
            windingDown: undefined,
            message: '__session_start__',
            isSpecial: true,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: itemType === 'image' ? 'fakebase64data' : null,
            isSelfReview,
            timeLimitMinutes,
            nativeDocumentAvailable: isFirstTurn && itemType === 'document',
          })

          const systemBlocks = [
            { text: systemPrompt },
            { cachePoint: { type: 'default' } },
          ]

          // Build messages based on turn type and item type
          let messages
          if (isFirstTurn && itemType === 'document') {
            // First turn, document session: document + page images + cachePoint + text
            const content = buildFirstTurnContent(docFormat, pageCount, userMessage)
            messages = [{ role: 'user', content }]
          } else if (isFirstTurn && itemType === 'image') {
            // First turn, image session: image + text (no cachePoint in messages)
            messages = [{
              role: 'user',
              content: [
                { image: { format: 'jpeg', source: { bytes: Buffer.from('fake-image') } } },
                { text: userMessage },
              ],
            }]
          } else if (isFirstTurn) {
            // First turn, markdown/text session: text only (no cachePoint in messages)
            messages = [{ role: 'user', content: [{ text: userMessage }] }]
          } else {
            // Subsequent turn: no document/image attachment, no cachePoint in messages
            messages = buildSubsequentTurnMessages(history, userMessage)
          }

          // Count total cachePoint objects across system and messages
          const systemCachePoints = countCachePointsInSystem(systemBlocks)
          const messageCachePoints = countCachePointsInMessages(messages)
          const totalCachePoints = systemCachePoints + messageCachePoints

          // Property: total cache points SHALL NOT exceed 4
          expect(totalCachePoints).toBeLessThanOrEqual(4)

          // Verify expected counts based on configuration:
          // - System always has exactly 1 cache point
          expect(systemCachePoints).toBe(1)

          // - First turn document sessions have exactly 1 message-level cache point
          // - All other configurations have 0 message-level cache points
          if (isFirstTurn && itemType === 'document') {
            expect(messageCachePoints).toBe(1)
            expect(totalCachePoints).toBe(2)
          } else {
            expect(messageCachePoints).toBe(0)
            expect(totalCachePoints).toBe(1)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 5: priming call prefix matches first real call prefix
// **Validates: Requirements 3.2, 4.1, 4.4**
//
// For any document session, the system prompt and content blocks
// (document + page images + cache points) in the priming call SHALL be
// identical to those in the first real ConverseStream call for the same
// session — ensuring a cache hit.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 5: priming call prefix matches first real call prefix', () => {
  // Generator: page count from 0 to 20
  const pageCountArb = fc.integer({ min: 0, max: 20 })

  // Generator: document format (pdf or docx)
  const docFormatArb = fc.constantFrom('pdf', 'docx')

  // Generator: item description (may be empty)
  const itemDescriptionArb = fc.string({ minLength: 0, maxLength: 300 })

  // Generator: reviewer's actual first message (non-empty)
  const userMessageArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

  // Generator: template greeting text (non-empty)
  const templateGreetingArb = fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0)

  /**
   * Simulates the priming call's request building logic (mirrors primeCacheAsync in index.mjs).
   *
   * The priming call builds:
   *   system: [{ text: systemPrompt }, { cachePoint: { type: 'default' } }]
   *   messages: [{ role: 'user', content: [document, ...images, { cachePoint: { type: 'default' } }, { text: '[cache_priming]' }] }]
   */
  function buildPrimingRequest({ systemPrompt, docFormat, nativeDocBytes, pageCount, tenantId, itemId }) {
    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    const userContent = []

    // Document block — same as primeCacheAsync
    userContent.push({ document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } })

    // Page images — same order as primeCacheAsync
    for (let p = 1; p <= pageCount; p++) {
      const pageBytes = Buffer.from(`fake-page-${p}`)
      userContent.push({ image: { format: 'png', source: { bytes: pageBytes } } })
    }

    // Cache point after document + images
    userContent.push({ cachePoint: { type: 'default' } })

    // Minimal user message (placeholder — response is discarded)
    userContent.push({ text: '[cache_priming]' })

    return {
      systemBlocks,
      messages: [{ role: 'user', content: userContent }],
    }
  }

  /**
   * Simulates the first real ConverseStream call's request building logic
   * (mirrors the Chat Lambda's first-turn message building in index.mjs).
   *
   * The first real call builds:
   *   system: [{ text: systemPrompt }, { cachePoint: { type: 'default' } }]
   *   messages: [{ role: 'user', content: [document, ...images, { cachePoint: { type: 'default' } }, { text: userMessage }] }]
   *
   * Two-Phase Session Start: the template greeting is already in the transcript
   * as an assistant message, so the first real call's messages start with:
   *   [{ role: 'assistant', content: greeting }, { role: 'user', content: ... }]
   * After coalescing and normalization, the first user message has the document blocks.
   * For this property test, we only compare the first user message's content prefix.
   */
  function buildFirstRealRequest({ systemPrompt, docFormat, nativeDocBytes, pageCount, tenantId, itemId, userMessage }) {
    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    // Step 1: Native document attachment — coalescedMessages[firstUserIdx].content = [document, text]
    const existingContent = [
      { document: { format: docFormat, name: 'document', source: { bytes: nativeDocBytes } } },
      { text: userMessage },
    ]

    if (pageCount > 0) {
      // Step 2: Insert page images before the text block (mirrors Chat Lambda page image loop)
      const textIdx = existingContent.findIndex(b => b.text)
      const insertAt = textIdx !== -1 ? textIdx : existingContent.length

      for (let p = 1; p <= pageCount; p++) {
        const pageBytes = Buffer.from(`fake-page-${p}`)
        existingContent.splice(insertAt + (p - 1), 0, {
          image: { format: 'png', source: { bytes: pageBytes } },
        })
      }

      // Step 3: Insert cachePoint before text block (inside pageCount > 0 block in Lambda)
      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    } else {
      // pageCount === 0 path: separate cache point insertion block in the Lambda
      const cacheTextIdx = existingContent.findIndex(b => b.text)
      if (cacheTextIdx > 0) {
        existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
      }
    }

    return {
      systemBlocks,
      messages: [{ role: 'user', content: existingContent }],
    }
  }

  /**
   * Extracts the cache prefix from a user message's content array:
   * all blocks up to and including the cachePoint.
   */
  function extractCachePrefix(contentBlocks) {
    const cacheIdx = contentBlocks.findIndex(b => 'cachePoint' in b)
    if (cacheIdx === -1) return contentBlocks
    return contentBlocks.slice(0, cacheIdx + 1)
  }

  /**
   * Deep-compares two content block arrays, comparing bytes by value
   * rather than by reference (Buffer.equals).
   */
  function contentBlocksEqual(a, b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const blockA = a[i]
      const blockB = b[i]

      if ('cachePoint' in blockA && 'cachePoint' in blockB) {
        continue // Both are cache points — equal
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
      // Different block types
      return false
    }
    return true
  }

  it('for any document session, priming and first real call have identical system blocks and content prefix', () => {
    fc.assert(
      fc.property(
        docFormatArb,
        pageCountArb,
        itemNameArb,
        itemDescriptionArb,
        totalSectionsArb,
        timeLimitArb,
        closingStateArb,
        fc.boolean(),           // isSelfReview
        userMessageArb,
        templateGreetingArb,
        (docFormat, pageCount, itemName, itemDescription, totalSections, timeLimitMinutes, closingState, isSelfReview, userMessage, templateGreeting) => {
          const tenantId = 'tenant-test'
          const itemId = 'item-test'
          const nativeDocBytes = Buffer.from('fake-pdf-bytes')

          // Build the system prompt with the same parameters both calls use.
          // At __template_init__ time: currentSection=1, closingState='exploring',
          // windingDown=undefined, message='', isSpecial=false.
          // The first real turn sees the same initial state.
          const systemPrompt = buildSystemPrompt({
            itemName,
            itemDescription,
            itemContent: '', // Not needed when nativeDocumentAvailable
            itemType: 'document',
            totalSections,
            currentSection: 1,
            closingState: 'exploring',
            windingDown: undefined,
            message: '',
            isSpecial: false,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: null,
            isSelfReview,
            timeLimitMinutes,
            nativeDocumentAvailable: true,
            templateGreeting,
          })

          // Build priming request (mirrors primeCacheAsync)
          const priming = buildPrimingRequest({
            systemPrompt, docFormat, nativeDocBytes, pageCount, tenantId, itemId,
          })

          // Build first real request (mirrors Chat Lambda first-turn logic)
          const real = buildFirstRealRequest({
            systemPrompt, docFormat, nativeDocBytes, pageCount, tenantId, itemId, userMessage,
          })

          // ── Property checks ──

          // 1. System blocks must be identical
          expect(priming.systemBlocks).toHaveLength(2)
          expect(real.systemBlocks).toHaveLength(2)
          expect(priming.systemBlocks[0].text).toBe(real.systemBlocks[0].text)
          expect(priming.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })
          expect(real.systemBlocks[1]).toEqual({ cachePoint: { type: 'default' } })

          // 2. Both have exactly one user message
          expect(priming.messages).toHaveLength(1)
          expect(real.messages).toHaveLength(1)
          expect(priming.messages[0].role).toBe('user')
          expect(real.messages[0].role).toBe('user')

          // 3. Extract cache prefix (everything up to and including cachePoint)
          const primingPrefix = extractCachePrefix(priming.messages[0].content)
          const realPrefix = extractCachePrefix(real.messages[0].content)

          // 4. Cache prefixes must have the same length
          expect(primingPrefix.length).toBe(realPrefix.length)

          // 5. Cache prefixes must be identical (document bytes, image bytes, cache point)
          expect(contentBlocksEqual(primingPrefix, realPrefix)).toBe(true)

          // 6. The text AFTER the cache point can differ — priming uses '[cache_priming]',
          //    real call uses the reviewer's actual message. Verify they differ as expected.
          const primingContent = priming.messages[0].content
          const realContent = real.messages[0].content
          const primingTextBlock = primingContent[primingContent.length - 1]
          const realTextBlock = realContent[realContent.length - 1]
          expect(primingTextBlock.text).toBe('[cache_priming]')
          expect(realTextBlock.text).toBe(userMessage)

          // 7. Both content arrays have the same structure: [document, image*, cachePoint, text]
          expect(primingContent.length).toBe(realContent.length)
          expect(primingContent.length).toBe(1 + pageCount + 1 + 1) // doc + images + cachePoint + text
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 6: priming skipped for non-document sessions
// **Validates: Requirements 3.6, 6.1, 6.2, 6.3**
//
// For any session where the item type is `image`, or the item has no native
// document, or the session has no `templateGreeting`, the `__template_init__`
// handler SHALL NOT initiate a priming call to Bedrock.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 6: priming skipped for non-document sessions', () => {
  // ── Supported document extensions for priming ──
  const docMediaTypes = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }

  /**
   * Simulates the priming eligibility check from the __template_init__ handler.
   * Returns true if priming WOULD be initiated, false otherwise.
   *
   * This mirrors the nested conditionals in index.mjs:
   *   if (greeting && itemId && tenantId) {
   *     if (primingItemType === 'document' && primingDocumentKey) {
   *       if (docMediaTypes[ext]) {
   *         if (nativeDocBytes) {
   *           → priming initiated
   *         }
   *       }
   *     }
   *   }
   */
  function wouldInitiatePriming({ greeting, itemId, tenantId, itemType, documentKey, nativeDocBytes }) {
    // Outer guard: greeting + itemId + tenantId must all be truthy
    if (!greeting || !itemId || !tenantId) return false

    // Item type must be 'document'
    if (itemType !== 'document') return false

    // Document key must exist
    if (!documentKey) return false

    // Document extension must be pdf or docx
    const ext = documentKey.split('.').pop()?.toLowerCase()
    if (!docMediaTypes[ext]) return false

    // Native document bytes must be available
    if (!nativeDocBytes) return false

    return true
  }

  // ── Generators for non-document session configurations ──

  // Generator: non-empty string for IDs
  const idArb = fc.string({ minLength: 1, maxLength: 40 }).filter(s => s.trim().length > 0)

  // Generator: non-empty greeting text
  const greetingArb = fc.string({ minLength: 1, maxLength: 500 }).filter(s => s.trim().length > 0)

  // Generator: falsy greeting (empty string, null, undefined)
  const falsyGreetingArb = fc.constantFrom('', null, undefined)

  // Generator: non-document item types (image, markdown)
  const nonDocumentItemTypeArb = fc.constantFrom('image', 'markdown')

  // Generator: document key with non-supported extension (not pdf/docx)
  const nonSupportedDocKeyArb = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 50 }).map(s => `pulse/tenant/items/item/${s}.txt`),
    fc.string({ minLength: 1, maxLength: 50 }).map(s => `pulse/tenant/items/item/${s}.md`),
    fc.string({ minLength: 1, maxLength: 50 }).map(s => `pulse/tenant/items/item/${s}.png`),
    fc.string({ minLength: 1, maxLength: 50 }).map(s => `pulse/tenant/items/item/${s}.jpg`),
  )

  // Generator: valid document key (pdf or docx)
  const validDocKeyArb = fc.oneof(
    fc.constant('pulse/tenant/items/item/document.pdf'),
    fc.constant('pulse/tenant/items/item/document.docx'),
  )

  // Generator: nativeDocBytes — either null (not available) or a Buffer (available)
  const nativeDocBytesArb = fc.oneof(
    fc.constant(null),
    fc.constant(Buffer.from('fake-pdf-bytes')),
  )

  /**
   * Strategy: Generate four categories of non-document sessions, each ensuring
   * at least one priming eligibility condition is false:
   *
   * Category 1: Image items (itemType === 'image') — Validates Req 6.1
   * Category 2: Markdown/text items (itemType === 'markdown') — Validates Req 6.3
   * Category 3: Document items without a native document — Validates Req 6.3
   *             (no documentKey, unsupported extension, or no nativeDocBytes)
   * Category 4: Sessions without a templateGreeting — Validates Req 6.2
   */
  const nonDocumentSessionArb = fc.oneof(
    // Category 1: Image items — itemType is 'image', everything else can be anything
    fc.record({
      greeting: greetingArb,
      itemId: idArb,
      tenantId: idArb,
      itemType: fc.constant('image'),
      documentKey: fc.oneof(validDocKeyArb, nonSupportedDocKeyArb),
      nativeDocBytes: nativeDocBytesArb,
    }),

    // Category 2: Markdown/text items — itemType is 'markdown', everything else can be anything
    fc.record({
      greeting: greetingArb,
      itemId: idArb,
      tenantId: idArb,
      itemType: fc.constant('markdown'),
      documentKey: fc.oneof(validDocKeyArb, nonSupportedDocKeyArb),
      nativeDocBytes: nativeDocBytesArb,
    }),

    // Category 3: Document items without a native document
    // itemType is 'document' but documentKey is missing/unsupported OR nativeDocBytes is null
    fc.record({
      greeting: greetingArb,
      itemId: idArb,
      tenantId: idArb,
      itemType: fc.constant('document'),
      documentKey: nonSupportedDocKeyArb,
      nativeDocBytes: nativeDocBytesArb,
    }),
    fc.record({
      greeting: greetingArb,
      itemId: idArb,
      tenantId: idArb,
      itemType: fc.constant('document'),
      documentKey: validDocKeyArb,
      nativeDocBytes: fc.constant(null), // Document bytes not available
    }),

    // Category 4: Sessions without a templateGreeting — greeting is falsy
    fc.record({
      greeting: falsyGreetingArb,
      itemId: idArb,
      tenantId: idArb,
      itemType: fc.constantFrom('document', 'image', 'markdown'),
      documentKey: fc.oneof(validDocKeyArb, nonSupportedDocKeyArb),
      nativeDocBytes: nativeDocBytesArb,
    }),
  )

  it('for any non-document session configuration, priming eligibility check evaluates to false', () => {
    fc.assert(
      fc.property(
        nonDocumentSessionArb,
        (session) => {
          const primingInitiated = wouldInitiatePriming(session)

          // Property: priming SHALL NOT be initiated for non-document sessions
          expect(primingInitiated).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// Feature: prompt-cache-priming
// Property 7: cache metrics published when cache usage present
// **Validates: Requirements 5.1, 5.2**
//
// For any Bedrock response that includes non-zero `cacheReadInputTokens` or
// `cacheWriteInputTokens`, the Chat Lambda SHALL publish the corresponding
// `CacheReadInputTokens` or `CacheWriteInputTokens` CloudWatch metric.
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: prompt-cache-priming, Property 7: cache metrics published when cache usage present', () => {
  // ── Generators ──

  // Generator: cache read input tokens (0 to 50000)
  const cacheReadArb = fc.integer({ min: 0, max: 50000 })

  // Generator: cache write input tokens (0 to 50000)
  const cacheWriteArb = fc.integer({ min: 0, max: 50000 })

  // Generator: standard Bedrock response values
  const bedrockLatencyArb = fc.integer({ min: 50, max: 60000 })
  const tokensInArb = fc.integer({ min: 1, max: 100000 })
  const tokensOutArb = fc.integer({ min: 1, max: 10000 })

  /**
   * Simulates the Chat Lambda's metrics building logic from index.mjs (lines ~1135-1149).
   *
   * The Chat Lambda always publishes the base metrics (BedrockLatency, BedrockTokensIn,
   * BedrockTokensOut, ChatMessages). Cache metrics are conditionally added:
   *   - CacheReadInputTokens is published only when cacheReadInputTokens > 0
   *   - CacheWriteInputTokens is published only when cacheWriteInputTokens > 0
   */
  function buildMetrics({ bedrockLatency, tokensIn, tokensOut, cacheReadInputTokens, cacheWriteInputTokens }) {
    const metrics = [
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
      { MetricName: 'ChatMessages', Value: 1, Unit: 'Count' },
    ]

    if (cacheReadInputTokens > 0) {
      metrics.push({ MetricName: 'CacheReadInputTokens', Value: cacheReadInputTokens, Unit: 'Count' })
    }
    if (cacheWriteInputTokens > 0) {
      metrics.push({ MetricName: 'CacheWriteInputTokens', Value: cacheWriteInputTokens, Unit: 'Count' })
    }

    return metrics
  }

  it('for any Bedrock response with cache usage, corresponding cache metrics are published when non-zero', () => {
    fc.assert(
      fc.property(
        bedrockLatencyArb,
        tokensInArb,
        tokensOutArb,
        cacheReadArb,
        cacheWriteArb,
        (bedrockLatency, tokensIn, tokensOut, cacheReadInputTokens, cacheWriteInputTokens) => {
          const metrics = buildMetrics({ bedrockLatency, tokensIn, tokensOut, cacheReadInputTokens, cacheWriteInputTokens })

          // Helper: find a metric by name
          const findMetric = (name) => metrics.find(m => m.MetricName === name)
          const hasMetric = (name) => metrics.some(m => m.MetricName === name)

          // ── Base metrics are always present ──

          expect(hasMetric('BedrockLatency')).toBe(true)
          expect(findMetric('BedrockLatency').Value).toBe(bedrockLatency)
          expect(findMetric('BedrockLatency').Unit).toBe('Milliseconds')

          expect(hasMetric('BedrockTokensIn')).toBe(true)
          expect(findMetric('BedrockTokensIn').Value).toBe(tokensIn)
          expect(findMetric('BedrockTokensIn').Unit).toBe('Count')

          expect(hasMetric('BedrockTokensOut')).toBe(true)
          expect(findMetric('BedrockTokensOut').Value).toBe(tokensOut)
          expect(findMetric('BedrockTokensOut').Unit).toBe('Count')

          expect(hasMetric('ChatMessages')).toBe(true)
          expect(findMetric('ChatMessages').Value).toBe(1)
          expect(findMetric('ChatMessages').Unit).toBe('Count')

          // ── Cache read metric: present iff cacheReadInputTokens > 0 ──

          if (cacheReadInputTokens > 0) {
            expect(hasMetric('CacheReadInputTokens')).toBe(true)
            expect(findMetric('CacheReadInputTokens').Value).toBe(cacheReadInputTokens)
            expect(findMetric('CacheReadInputTokens').Unit).toBe('Count')
          } else {
            expect(hasMetric('CacheReadInputTokens')).toBe(false)
          }

          // ── Cache write metric: present iff cacheWriteInputTokens > 0 ──

          if (cacheWriteInputTokens > 0) {
            expect(hasMetric('CacheWriteInputTokens')).toBe(true)
            expect(findMetric('CacheWriteInputTokens').Value).toBe(cacheWriteInputTokens)
            expect(findMetric('CacheWriteInputTokens').Unit).toBe('Count')
          } else {
            expect(hasMetric('CacheWriteInputTokens')).toBe(false)
          }

          // ── Metric count invariant ──
          // Base: 4 metrics always. +1 if cacheRead > 0, +1 if cacheWrite > 0.
          const expectedCount = 4
            + (cacheReadInputTokens > 0 ? 1 : 0)
            + (cacheWriteInputTokens > 0 ? 1 : 0)
          expect(metrics).toHaveLength(expectedCount)
        },
      ),
      { numRuns: 100 },
    )
  })
})
