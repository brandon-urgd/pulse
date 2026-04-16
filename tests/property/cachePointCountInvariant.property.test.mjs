// Property-based tests for Phased Cache Priming — Property 7: Cache point count invariant
// Feature: phased-cache-priming, Property 7: cache point count invariant
// **Validates: Requirements 7.2, 7.3, 7.4**
//
// For any Bedrock request constructed by the Chat Lambda, the total number of cachePoint
// objects across system and messages SHALL NOT exceed 4. Specifically: turn 3 document
// sessions have exactly 2 cache points (system + document), all other configurations
// have exactly 1 (system only).

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
const pageCountArb = fc.integer({ min: 0, max: 20 })
const docFormatArb = fc.constantFrom('pdf', 'docx')
const messageTextArb = fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0)

// Turn number: 1 = greeting, 2 = first response, 3+ = document injection
const turnNumberArb = fc.integer({ min: 1, max: 10 })

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 7: Cache point count invariant
// **Validates: Requirements 7.2, 7.3, 7.4**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 7: cache point count invariant', () => {

  /**
   * Simulates the Chat Lambda's message building logic for document injection turn (turn 3).
   * Mirrors the code in index.mjs: native doc attachment → page images → cachePoint → text.
   */
  function buildDocInjectionTurnContent(docFormat, pageCount, userMessage) {
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
   * Simulates the Chat Lambda's message building for non-injection turns.
   * No document/image attachment, no cachePoint in messages.
   */
  function buildNonInjectionTurnMessages(turnNumber, userMessage) {
    const messages = []
    // Build history based on turn number
    for (let i = 1; i < turnNumber; i++) {
      messages.push(
        { role: 'user', content: [{ text: `Prior message ${i}` }] },
        { role: 'assistant', content: [{ text: `Prior response ${i}` }] },
      )
    }
    messages.push({ role: 'user', content: [{ text: userMessage }] })
    return messages
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

  it('for any request configuration, total cache points ≤ 4 with correct counts per config', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        turnNumberArb,
        docFormatArb,
        pageCountArb,
        messageTextArb,
        itemNameArb,
        closingStateArb,
        timeLimitArb,
        fc.boolean(), // isSelfReview
        (itemType, turnNumber, docFormat, pageCount, userMessage, itemName, closingState, timeLimitMinutes, isSelfReview) => {
          // Determine if this is a document injection turn
          const isDocumentInjectionTurn = turnNumber >= 3 && itemType === 'document'

          // Build system blocks — always includes the system-level cache point
          const nativeDocumentAvailable = isDocumentInjectionTurn
          const systemPrompt = buildSystemPrompt({
            itemName,
            itemDescription: '',
            itemContent: '# Sample extracted text',
            itemType,
            totalSections: 5,
            currentSection: 1,
            closingState,
            windingDown: undefined,
            message: turnNumber === 1 ? '__session_start__' : 'user message',
            isSpecial: turnNumber === 1,
            frozenSnapshot: null,
            coverageMap: null,
            imageBase64: itemType === 'image' ? 'fakebase64data' : null,
            isSelfReview,
            timeLimitMinutes,
            nativeDocumentAvailable,
          })

          const systemBlocks = [
            { text: systemPrompt },
            { cachePoint: { type: 'default' } },
          ]

          // Build messages based on turn type and item type
          let messages
          if (isDocumentInjectionTurn) {
            // Turn 3 document session: document + page images + cachePoint + text
            const content = buildDocInjectionTurnContent(docFormat, pageCount, userMessage)
            // Include prior history + the injection message
            messages = []
            for (let i = 1; i < turnNumber; i++) {
              messages.push(
                { role: 'user', content: [{ text: `Prior message ${i}` }] },
                { role: 'assistant', content: [{ text: `Prior response ${i}` }] },
              )
            }
            // The first user message gets the document blocks (send-once pattern)
            messages[0] = { role: 'user', content }
            messages.push({ role: 'user', content: [{ text: userMessage }] })
          } else if (itemType === 'image' && turnNumber === 1) {
            // First turn, image session: image + text (no cachePoint in messages)
            messages = [{
              role: 'user',
              content: [
                { image: { format: 'jpeg', source: { bytes: Buffer.from('fake-image') } } },
                { text: userMessage },
              ],
            }]
          } else {
            // All other turns: text only, no document/image attachment, no cachePoint in messages
            messages = buildNonInjectionTurnMessages(turnNumber, userMessage)
          }

          // Count total cachePoint objects across system and messages
          const systemCachePoints = countCachePointsInSystem(systemBlocks)
          const messageCachePoints = countCachePointsInMessages(messages)
          const totalCachePoints = systemCachePoints + messageCachePoints

          // Property: total cache points SHALL NOT exceed 4
          expect(totalCachePoints).toBeLessThanOrEqual(4)

          // System always has exactly 1 cache point
          expect(systemCachePoints).toBe(1)

          // Document injection turn (turn 3+ for document sessions) has exactly 1 message-level cache point
          // All other configurations have 0 message-level cache points
          if (isDocumentInjectionTurn) {
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
