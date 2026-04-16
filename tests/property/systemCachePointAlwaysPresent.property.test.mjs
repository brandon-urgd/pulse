// Property-based tests for Phased Cache Priming — Property 6: System cache point always present
// Feature: phased-cache-priming, Property 6: system cache point always present
// **Validates: Requirements 7.1, 9.4**
//
// For any item type (document, image, text-only) and for any turn number, the Bedrock
// request's system array SHALL end with { cachePoint: { type: 'default' } }.

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
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
  }
}

function makeSessionItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    currentSection: { N: '1' },
    totalSections: { N: '3' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    startedAt: { S: new Date().toISOString() },
    ...overrides,
  }
}

function makeItemRecord(itemType, documentKey, pageCount) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Item' },
    description: { S: 'Review this.' },
    itemType: { S: itemType },
    ...(documentKey ? { documentKey: { S: documentKey } } : {}),
    pageCount: { N: String(pageCount) },
  }
}

function makeChatEvent(message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-xyz', tenantId: 'tenant-abc' },
    },
    body: JSON.stringify({ message }),
  }
}

function buildTranscriptItems(priorUserMessages) {
  const items = []
  items.push({
    sessionId: { S: 'session-xyz' },
    messageId: { S: 'msg-greeting' },
    role: { S: 'agent' },
    content: { S: 'Welcome to the review session!' },
    timestamp: { S: '2024-01-01T00:00:00Z' },
  })
  for (let i = 0; i < priorUserMessages; i++) {
    items.push(
      {
        sessionId: { S: 'session-xyz' },
        messageId: { S: `msg-r${i}` },
        role: { S: 'reviewer' },
        content: { S: `Question ${i}` },
        timestamp: { S: `2024-01-01T00:0${i + 1}:00Z` },
      },
      {
        sessionId: { S: 'session-xyz' },
        messageId: { S: `msg-a${i}` },
        role: { S: 'agent' },
        content: { S: `Answer ${i}` },
        timestamp: { S: `2024-01-01T00:0${i + 1}:01Z` },
      },
    )
  }
  return items
}

const { handler: chatHandler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

// ── Generators ──

const itemTypeArb = fc.constantFrom('document', 'image', 'markdown')
const priorUserMessagesArb = fc.integer({ min: 0, max: 8 })

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 6: System cache point always present
// **Validates: Requirements 7.1, 9.4**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 6: system cache point always present', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('for any item type and turn number, the system array ends with cachePoint', async () => {
    // **Validates: Requirements 7.1, 9.4**
    await fc.assert(
      fc.asyncProperty(
        itemTypeArb,
        priorUserMessagesArb,
        async (itemType, priorUserMsgs) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          const transcriptItems = buildTranscriptItems(priorUserMsgs)

          // Build item record based on item type
          let documentKey = null
          let pageCount = 0
          if (itemType === 'document') {
            documentKey = 'pulse/tenant-abc/items/item-123/document.pdf'
            pageCount = 2
          } else if (itemType === 'image') {
            documentKey = 'pulse/tenant-abc/items/item-123/image.jpg'
            pageCount = 0
          }
          // markdown items have no documentKey

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })                                    // GetItem session
            .mockResolvedValueOnce({ Items: transcriptItems })                                      // Query transcript
            .mockResolvedValueOnce({ Item: makeItemRecord(itemType, documentKey, pageCount) })      // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text content'))
            if (key.endsWith('document.md')) return Promise.resolve(makeS3Body('# Document text'))
            if (key.endsWith('.pdf')) return Promise.resolve(makeS3Body('fake-pdf-bytes'))
            if (key.includes('/pages/page-')) return Promise.resolve(makeS3Body('fake-png-bytes'))
            if (key.endsWith('.jpg')) return Promise.resolve(makeS3Body('fake-jpg-bytes'))
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          // Capture the system blocks sent to Bedrock
          let capturedSystemBlocks = null
          bedrockSpy.mockImplementation((cmd) => {
            capturedSystemBlocks = cmd.input.system
            return Promise.resolve(makeConverseResponse('Agent response'))
          })

          const message = priorUserMsgs === 0 ? '__session_start__' : 'Tell me more about this'
          const event = makeChatEvent(message)
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)
          expect(capturedSystemBlocks).toBeTruthy()
          expect(Array.isArray(capturedSystemBlocks)).toBe(true)

          // The system array SHALL end with { cachePoint: { type: 'default' } }
          const lastBlock = capturedSystemBlocks[capturedSystemBlocks.length - 1]
          expect(lastBlock).toEqual({ cachePoint: { type: 'default' } })

          // There should be exactly one cachePoint in the system array
          const cachePoints = capturedSystemBlocks.filter(b => 'cachePoint' in b)
          expect(cachePoints).toHaveLength(1)

          // The first block should be the text system prompt
          expect(capturedSystemBlocks[0]).toHaveProperty('text')
          expect(typeof capturedSystemBlocks[0].text).toBe('string')
          expect(capturedSystemBlocks[0].text.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
