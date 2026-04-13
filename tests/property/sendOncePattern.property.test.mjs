// Property-based tests for Session Fast Start — Send-once pattern
// Task 14.1
// Uses fast-check for property-based testing

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Spies ──

const dynamoSpy = vi.fn()
const s3Spy = vi.fn()
const bedrockSpy = vi.fn()
const cwSpy = vi.fn()
const lambdaSpy = vi.fn()

// ── AWS SDK mocks ──

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input; this.name = 'TransactWriteItemsCommand' } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3Spy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  class PutObjectCommand { constructor(input) { this.input = input; this.name = 'PutObjectCommand' } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input; this.name = 'ConverseCommand' } }
  class ConverseStreamCommand { constructor(input) { this.input = input; this.name = 'ConverseStreamCommand' } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input; this.name = 'PutMetricDataCommand' } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Math.random().toString(36).slice(2, 8)),
}))

// ── Helpers ──

function makeS3Body(content) {
  return {
    Body: {
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(content) },
    },
  }
}

function makeConverseResponse(text) {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

function makeSessionItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'not_started' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    currentSection: { N: '1' },
    totalSections: { N: '3' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    ...overrides,
  }
}

function makeItemRecord(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Review this.' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
    ...overrides,
  }
}

function makeChatEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId, tenantId },
    },
    body: JSON.stringify({ message }),
  }
}

const { handler: chatHandler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

// ═══════════════════════════════════════════════════════════════════════════
// Property 1: Send-once pattern — no content blocks on subsequent turns
// **Validates: Requirements 3.3, 6.5, 10.3**
//
// When history.length > 0 (not first turn), verify no document/image
// content blocks are attached to the Bedrock payload.
// When history.length === 0 (first turn), verify content blocks ARE attached.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 1: Send-once pattern — no content blocks on subsequent turns', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('subsequent turns (history.length > 0) have no document or image content blocks', async () => {
    // **Validates: Requirements 3.3, 6.5, 10.3**
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),  // pageCount
        fc.integer({ min: 1, max: 10 }),   // history length (prior message pairs)
        async (pageCount, historyPairs) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          // Build transcript with prior messages (history.length > 0)
          const transcriptItems = []
          for (let i = 0; i < historyPairs; i++) {
            transcriptItems.push(
              { sessionId: { S: 'session-xyz' }, messageId: { S: `msg-r${i}` }, role: { S: 'reviewer' }, content: { S: `Question ${i}` }, timestamp: { S: `2024-01-01T00:0${i}:00Z` } },
              { sessionId: { S: 'session-xyz' }, messageId: { S: `msg-a${i}` }, role: { S: 'agent' }, content: { S: `Answer ${i}` }, timestamp: { S: `2024-01-01T00:0${i}:01Z` } },
            )
          }

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: transcriptItems })         // Query transcript
            .mockResolvedValueOnce({ Item: makeItemRecord({ pageCount: { N: String(pageCount) } }) }) // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          s3Spy.mockResolvedValueOnce(makeS3Body('# Extracted text'))

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', 'What do you think?')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Verify no document or image blocks in any message sent to Bedrock
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              const docBlock = msg.content.find(b => b.document)
              const imgBlock = msg.content.find(b => b.image)
              expect(docBlock).toBeUndefined()
              expect(imgBlock).toBeUndefined()
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('first turn (history.length === 0) attaches document content blocks', async () => {
    // **Validates: Requirements 3.3, 6.5, 10.3**
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),  // pageCount
        async (pageCount) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: [] })                      // Query transcript (empty = first turn)
            .mockResolvedValueOnce({ Item: makeItemRecord({ pageCount: { N: String(pageCount) } }) }) // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          // S3: extracted text
          s3Spy.mockResolvedValueOnce(makeS3Body('# Extracted text'))
          // S3: original document bytes (for native document block)
          s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
          // S3: page images
          for (let p = 0; p < pageCount; p++) {
            s3Spy.mockResolvedValueOnce(makeS3Body('fake-png-bytes'))
          }

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Welcome to the session!'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', '__session_start__')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Verify the first user message has document and/or image content blocks
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages
          const firstUserMsg = messages.find(m => m.role === 'user')
          expect(firstUserMsg).toBeDefined()
          expect(Array.isArray(firstUserMsg.content)).toBe(true)

          // Should have at least a document block or image blocks (content blocks present)
          const hasDocOrImage = firstUserMsg.content.some(b => b.document || b.image)
          expect(hasDocOrImage).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})
