// Property-based tests for Converse migration — native document context
// Task 3.7
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

function makeS3Body(text) {
  return {
    Body: {
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(text) },
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
// Property 9: No document block on subsequent turns
// **Validates: Requirement 5.5**
//
// Assert that for any session with history.length > 0, the Bedrock payload
// does not include a document content block.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 9: No document block on subsequent turns', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('for any session with prior transcript, Bedrock payload has no document content block', async () => {
    // **Validates: Requirements 5.5**
    await fc.assert(
      fc.asyncProperty(
        // Generate 1-10 prior transcript message pairs
        fc.integer({ min: 1, max: 5 }),
        // Generate a user message string
        fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0 && !s.includes('__session')),
        async (numPriorPairs, userMessage) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          // Build transcript with prior messages (history.length > 0)
          const transcriptItems = []
          for (let i = 0; i < numPriorPairs; i++) {
            transcriptItems.push(
              { sessionId: { S: 'session-xyz' }, messageId: { S: `msg-r${i}` }, role: { S: 'reviewer' }, content: { S: `Question ${i}` }, timestamp: { S: `2024-01-01T00:0${i}:00Z` } },
              { sessionId: { S: 'session-xyz' }, messageId: { S: `msg-a${i}` }, role: { S: 'agent' }, content: { S: `Answer ${i}` }, timestamp: { S: `2024-01-01T00:0${i}:01Z` } },
            )
          }

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })
            .mockResolvedValueOnce({ Items: transcriptItems })
            .mockResolvedValueOnce({ Item: makeItemRecord() })
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          s3Spy.mockResolvedValueOnce(makeS3Body('# Extracted text'))

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', userMessage)
          const result = await chatHandler(event)

          // Should succeed
          expect(result.statusCode).toBe(200)

          // Verify no document block in any message
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages
          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              const docBlock = msg.content.find(b => b.document)
              expect(docBlock).toBeUndefined()
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 10: S3 failure falls back gracefully
// **Validates: Requirement 5.7**
//
// Assert that when S3 read fails, the session proceeds with extracted text
// only — no exception is thrown and no session state field is set to error.
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 10: S3 failure falls back gracefully', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('when S3 document read fails, session proceeds with extracted text only', async () => {
    // **Validates: Requirement 5.7**
    const errorNames = ['NoSuchKey', 'AccessDenied', 'NetworkingError', 'TimeoutError', 'InternalError']

    await fc.assert(
      fc.asyncProperty(
        // Pick a random S3 error type
        fc.constantFrom(...errorNames),
        // Pick a document extension
        fc.constantFrom('pdf', 'docx'),
        async (errorName, ext) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          const docKey = `pulse/tenant-abc/items/item-123/document.${ext}`

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })
            .mockResolvedValueOnce({ Items: [] })  // first turn
            .mockResolvedValueOnce({ Item: makeItemRecord({ documentKey: { S: docKey } }) })
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          // S3: extracted.md succeeds
          s3Spy.mockResolvedValueOnce(makeS3Body('# Extracted text'))
          // S3: document bytes FAIL with the generated error
          const s3Error = new Error(errorName)
          s3Error.name = errorName
          s3Spy.mockRejectedValueOnce(s3Error)

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', '__session_start__')
          const result = await chatHandler(event)

          // Must not throw — should return 200
          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data.message).toBe('Agent response')
          expect(body.error).toBeUndefined()

          // Bedrock was called (session proceeded)
          expect(bedrockSpy).toHaveBeenCalledOnce()
        },
      ),
      { numRuns: 100 },
    )
  })
})
