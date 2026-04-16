// Property-based tests for Phased Cache Priming — Property 3: Turn-aware document injection
// Feature: phased-cache-priming, Property 3: turn-aware document injection
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.3**
//
// For any document session with a native document, the Chat Lambda SHALL determine the turn
// number by counting prior user messages in the transcript. On turns 1-2 (0-1 prior user
// messages), the Bedrock request SHALL NOT contain document or image content blocks, and
// nativeDocumentAvailable SHALL be false. On turn 3+ (2+ prior user messages), the native
// document block and page images SHALL be attached to the first user message, and
// nativeDocumentAvailable SHALL be true. For non-document sessions (image, text-only),
// this turn-awareness logic SHALL not apply.

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

function makeItemRecord(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Review this.' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
    pageCount: { N: '2' },
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

/**
 * Build transcript items representing prior user/agent exchanges.
 * Each pair = 1 reviewer message + 1 agent response.
 */
function buildTranscriptItems(priorUserMessages) {
  const items = []
  // First entry is always the agent greeting (from __session_start__)
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

// Prior user messages: 0 = turn 1, 1 = turn 2, 2+ = turn 3+
const priorUserMessagesArb = fc.integer({ min: 0, max: 10 })

const itemTypeArb = fc.constantFrom('document', 'image')

const pageCountArb = fc.integer({ min: 1, max: 5 })

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 3: Turn-aware document injection
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 9.3**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 3: turn-aware document injection', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('document sessions: turns 1-2 have no document/image blocks, turn 3+ has them', async () => {
    // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
    await fc.assert(
      fc.asyncProperty(
        priorUserMessagesArb,
        pageCountArb,
        async (priorUserMsgs, pageCount) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          const turnNumber = priorUserMsgs + 1
          const isDocInjectionTurn = turnNumber >= 3
          const transcriptItems = buildTranscriptItems(priorUserMsgs)

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: transcriptItems })         // Query transcript
            .mockResolvedValueOnce({ Item: makeItemRecord({ pageCount: { N: String(pageCount) } }) }) // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          // S3: extracted text (always loaded for non-image items)
          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text content'))
            if (key.endsWith('document.md')) return Promise.resolve(makeS3Body('# Document text'))
            if (key.endsWith('.pdf')) return Promise.resolve(makeS3Body('fake-pdf-bytes'))
            if (key.includes('/pages/page-')) return Promise.resolve(makeS3Body('fake-png-bytes'))
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', priorUserMsgs === 0 ? '__session_start__' : 'What do you think?')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Inspect the Bedrock call
          const bedrockCall = bedrockSpy.mock.calls[0][0]
          const messages = bedrockCall.input.messages

          if (isDocInjectionTurn) {
            // Turn 3+: first user message should have document and/or image content blocks
            const firstUserMsg = messages.find(m => m.role === 'user')
            expect(firstUserMsg).toBeDefined()
            expect(Array.isArray(firstUserMsg.content)).toBe(true)
            const hasDocBlock = firstUserMsg.content.some(b => b.document)
            const hasImageBlock = firstUserMsg.content.some(b => b.image)
            expect(hasDocBlock).toBe(true)
            expect(hasImageBlock).toBe(true)
          } else {
            // Turns 1-2: NO document or image blocks in any message
            for (const msg of messages) {
              if (Array.isArray(msg.content)) {
                const docBlock = msg.content.find(b => b.document)
                const imgBlock = msg.content.find(b => b.image)
                expect(docBlock).toBeUndefined()
                expect(imgBlock).toBeUndefined()
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document sessions: nativeDocumentAvailable is false for turns 1-2, true for turn 3+', async () => {
    // **Validates: Requirements 2.2, 2.4**
    await fc.assert(
      fc.asyncProperty(
        priorUserMessagesArb,
        async (priorUserMsgs) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          const turnNumber = priorUserMsgs + 1
          const transcriptItems = buildTranscriptItems(priorUserMsgs)

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })
            .mockResolvedValueOnce({ Items: transcriptItems })
            .mockResolvedValueOnce({ Item: makeItemRecord() })
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})

          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text'))
            if (key.endsWith('.pdf')) return Promise.resolve(makeS3Body('fake-pdf-bytes'))
            if (key.includes('/pages/page-')) return Promise.resolve(makeS3Body('fake-png-bytes'))
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          // Capture the system prompt to check nativeDocumentAvailable
          let capturedSystemPrompt = null
          bedrockSpy.mockImplementation((cmd) => {
            capturedSystemPrompt = cmd.input.system?.[0]?.text || ''
            return Promise.resolve(makeConverseResponse('Agent response'))
          })

          const event = makeChatEvent('session-xyz', 'tenant-abc', priorUserMsgs === 0 ? '__session_start__' : 'Tell me more')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)
          expect(capturedSystemPrompt).toBeTruthy()

          if (turnNumber >= 3) {
            // Turn 3+: system prompt should reflect nativeDocumentAvailable: true
            // The prompt should contain native document instructions (not text-only instructions)
            expect(capturedSystemPrompt).toContain('native file attachment')
          } else {
            // Turns 1-2: system prompt should reflect nativeDocumentAvailable: false
            // The prompt should NOT contain native document instructions
            expect(capturedSystemPrompt).not.toContain('native file attachment')
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('image sessions are unaffected by turn-awareness — no document injection on any turn', async () => {
    // **Validates: Requirements 2.6, 9.3**
    await fc.assert(
      fc.asyncProperty(
        priorUserMessagesArb,
        async (priorUserMsgs) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          const transcriptItems = buildTranscriptItems(priorUserMsgs)

          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })
            .mockResolvedValueOnce({ Items: transcriptItems })
            .mockResolvedValueOnce({
              Item: makeItemRecord({
                itemType: { S: 'image' },
                documentKey: { S: 'pulse/tenant-abc/items/item-123/image.jpg' },
                pageCount: { N: '0' },
              }),
            })
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({})

          // S3: image bytes for image sessions
          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('.jpg')) return Promise.resolve(makeS3Body('fake-jpg-bytes'))
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))

          const event = makeChatEvent('session-xyz', 'tenant-abc', priorUserMsgs === 0 ? '__session_start__' : 'What about the image?')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Image sessions should never have document blocks (PDF/DOCX) injected
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
