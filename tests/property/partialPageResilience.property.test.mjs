// Property-based tests for Session Fast Start — Partial page image resilience
// Task 14.5
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
// Property 5: Partial page image resilience
// **Validates: Requirements 7.4**
//
// When some pages fail to load from S3, the remaining pages are still
// attached and the function doesn't throw — it logs and continues.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 5: Partial page image resilience', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('when some pages fail to load, remaining pages are still attached and no throw', async () => {
    // **Validates: Requirements 7.4**
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }),  // pageCount (at least 2 so we can fail some)
        fc.integer({ min: 1, max: 19 }),   // number of failing pages
        async (pageCount, failCountRaw) => {
          // Ensure failCount < pageCount (at least one page succeeds)
          const failCount = Math.min(failCountRaw, pageCount - 1)

          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          // Generate a set of failing page indices (1-based)
          const failingPages = new Set()
          for (let i = 0; i < failCount; i++) {
            failingPages.add((i % pageCount) + 1)
          }
          const expectedSuccessCount = pageCount - failingPages.size

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: [                          // Query transcript (turn 3 — 2 prior user messages)
              { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-1' }, role: { S: 'reviewer' }, content: { S: '[__session_start__]' }, timestamp: { S: new Date().toISOString() } },
              { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-2' }, role: { S: 'agent' }, content: { S: 'Welcome!' }, timestamp: { S: new Date().toISOString() } },
              { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-3' }, role: { S: 'reviewer' }, content: { S: 'Hello' }, timestamp: { S: new Date().toISOString() } },
              { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-4' }, role: { S: 'agent' }, content: { S: 'Hi there!' }, timestamp: { S: new Date().toISOString() } },
            ] })
            .mockResolvedValueOnce({ Item: makeItemRecord({ pageCount: { N: String(pageCount) } }) }) // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          // S3: extracted text
          s3Spy.mockResolvedValueOnce(makeS3Body('# Extracted text'))
          // S3: original document bytes
          s3Spy.mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))

          // S3: page images — some succeed, some fail
          // Track which S3 call index corresponds to which page
          let s3CallIndex = 2 // after extracted text + document bytes
          for (let p = 1; p <= pageCount; p++) {
            if (failingPages.has(p)) {
              const err = new Error('NoSuchKey')
              err.name = 'NoSuchKey'
              s3Spy.mockRejectedValueOnce(err)
            } else {
              s3Spy.mockResolvedValueOnce(makeS3Body(`page-${p}-data`))
            }
          }

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Welcome!'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', 'Tell me more about the document')

          // Must not throw
          const result = await chatHandler(event)
          expect(result.statusCode).toBe(200)

          // Bedrock was called (session proceeded despite partial failures)
          expect(bedrockSpy).toHaveBeenCalledOnce()

          // Verify the successful pages are still attached
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages
          const firstUserMsg = messages.find(m => m.role === 'user')
          expect(firstUserMsg).toBeDefined()
          expect(Array.isArray(firstUserMsg.content)).toBe(true)

          const imageBlocks = firstUserMsg.content.filter(b => b.image)
          // At least the successful pages should be attached
          expect(imageBlocks.length).toBe(expectedSuccessCount)
        },
      ),
      { numRuns: 100 },
    )
  })
})
