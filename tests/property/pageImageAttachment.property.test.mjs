// Property-based tests for Session Fast Start — Page images attached completely and in order
// Task 14.4
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
// Property 4: Page images attached completely and in order
// **Validates: Requirements 6.2, 6.3**
//
// For arbitrary pageCount (1-20), verify all page images are attached
// in order (page-001, page-002, ..., page-NNN) and the count of attached
// image blocks equals pageCount.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 4: Page images attached completely and in order', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('all page images are attached in order and count equals pageCount', async () => {
    // **Validates: Requirements 6.2, 6.3**
    // Phased Cache Priming: document and page image injection now happens at turn 3+
    // (2+ prior user messages), not on the first turn. This test uses 2 prior user
    // messages to trigger document injection.
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

          // Build transcript with 2 prior user messages (turn 3 = document injection turn)
          const transcriptItems = [
            { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-greeting' }, role: { S: 'agent' }, content: { S: 'Welcome!' }, timestamp: { S: '2024-01-01T00:00:00Z' } },
            { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-r0' }, role: { S: 'reviewer' }, content: { S: 'Question 0' }, timestamp: { S: '2024-01-01T00:01:00Z' } },
            { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-a0' }, role: { S: 'agent' }, content: { S: 'Answer 0' }, timestamp: { S: '2024-01-01T00:01:01Z' } },
            { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-r1' }, role: { S: 'reviewer' }, content: { S: 'Question 1' }, timestamp: { S: '2024-01-01T00:02:00Z' } },
            { sessionId: { S: 'session-xyz' }, messageId: { S: 'msg-a1' }, role: { S: 'agent' }, content: { S: 'Answer 1' }, timestamp: { S: '2024-01-01T00:02:01Z' } },
          ]

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: transcriptItems })         // Query transcript (2 prior user messages = turn 3)
            .mockResolvedValueOnce({ Item: makeItemRecord({ pageCount: { N: String(pageCount) } }) }) // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          // S3: extracted text + original document bytes + page images
          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text'))
            if (key.endsWith('document.md')) return Promise.resolve(makeS3Body('# Document text'))
            if (key.endsWith('.pdf')) return Promise.resolve(makeS3Body('fake-pdf-bytes'))
            if (key.includes('/pages/page-')) {
              // Extract page number from key to return unique content for ordering verification
              const match = key.match(/page-(\d+)\.png/)
              const pageNum = match ? parseInt(match[1], 10) : 0
              const pageContent = `page-${String(pageNum).padStart(3, '0')}-data`
              return Promise.resolve(makeS3Body(pageContent))
            }
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Here are my thoughts on the formatting...'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', 'What about the formatting?')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Extract the first user message sent to Bedrock
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages
          const firstUserMsg = messages.find(m => m.role === 'user')
          expect(firstUserMsg).toBeDefined()
          expect(Array.isArray(firstUserMsg.content)).toBe(true)

          // Count image blocks
          const imageBlocks = firstUserMsg.content.filter(b => b.image)
          expect(imageBlocks.length).toBe(pageCount)

          // Verify all image blocks have format 'png'
          for (const block of imageBlocks) {
            expect(block.image.format).toBe('png')
            expect(block.image.source.bytes).toBeDefined()
          }

          // Verify ordering: each image block's bytes should correspond to sequential pages
          for (let i = 0; i < imageBlocks.length; i++) {
            const expectedContent = `page-${String(i + 1).padStart(3, '0')}-data`
            const actualContent = Buffer.from(imageBlocks[i].image.source.bytes).toString()
            expect(actualContent).toBe(expectedContent)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
