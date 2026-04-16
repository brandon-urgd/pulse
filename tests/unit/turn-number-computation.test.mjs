// Unit tests for turn number computation in the Chat Lambda
// Task 3.7: Verify turn number computation for 0, 1, 2, 3, 5 prior user messages
// Validates: Requirement 2.5

import { describe, it, expect, vi, beforeEach } from 'vitest'

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

/**
 * Build transcript items with a specific number of prior user messages.
 * Each user message has a corresponding agent response.
 */
function buildTranscriptItems(priorUserMessages) {
  const items = []
  // Agent greeting (always present after session start)
  items.push({
    sessionId: { S: 'session-xyz' },
    messageId: { S: 'msg-greeting' },
    role: { S: 'agent' },
    content: { S: 'Welcome!' },
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

// ═══════════════════════════════════════════════════════════════════════════
// Turn number computation unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Turn number computation', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  function setupMocks(priorUserMessages) {
    const transcriptItems = buildTranscriptItems(priorUserMessages)

    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
      .mockResolvedValueOnce({ Items: transcriptItems })         // Query transcript
      .mockResolvedValueOnce({ Item: makeItemRecord() })         // GetItem item
      .mockResolvedValueOnce({})  // streamingLock
      .mockResolvedValueOnce({})  // TransactWrite
      .mockResolvedValueOnce({})  // session state update

    s3Spy.mockImplementation((cmd) => {
      const key = cmd.input?.Key || ''
      if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text'))
      if (key.endsWith('.pdf')) return Promise.resolve(makeS3Body('fake-pdf-bytes'))
      if (key.includes('/pages/page-')) return Promise.resolve(makeS3Body('fake-png-bytes'))
      return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
    })

    bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response'))
  }

  it('0 prior user messages → turn 1 (no document injection)', async () => {
    setupMocks(0)
    const event = makeChatEvent('__session_start__')
    const result = await chatHandler(event)

    expect(result.statusCode).toBe(200)

    // Turn 1: no document or image blocks should be present
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const messages = bedrockCall.input.messages
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        expect(msg.content.find(b => b.document)).toBeUndefined()
        expect(msg.content.find(b => b.image)).toBeUndefined()
      }
    }
  })

  it('1 prior user message → turn 2 (no document injection)', async () => {
    setupMocks(1)
    const event = makeChatEvent('Tell me more about the content')
    const result = await chatHandler(event)

    expect(result.statusCode).toBe(200)

    // Turn 2: no document or image blocks should be present
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const messages = bedrockCall.input.messages
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        expect(msg.content.find(b => b.document)).toBeUndefined()
        expect(msg.content.find(b => b.image)).toBeUndefined()
      }
    }
  })

  it('2 prior user messages → turn 3 (document injection)', async () => {
    setupMocks(2)
    const event = makeChatEvent('What about the formatting?')
    const result = await chatHandler(event)

    expect(result.statusCode).toBe(200)

    // Turn 3: document and image blocks should be present in first user message
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const messages = bedrockCall.input.messages
    const firstUserMsg = messages.find(m => m.role === 'user')
    expect(firstUserMsg).toBeDefined()
    expect(Array.isArray(firstUserMsg.content)).toBe(true)
    expect(firstUserMsg.content.some(b => b.document)).toBe(true)
    expect(firstUserMsg.content.some(b => b.image)).toBe(true)
  })

  it('3 prior user messages → turn 4 (no document re-injection)', async () => {
    setupMocks(3)
    const event = makeChatEvent('Can you elaborate on section 2?')
    const result = await chatHandler(event)

    expect(result.statusCode).toBe(200)

    // Turn 4: isDocumentAttachmentTurn is false (turnNumber !== 3), so no document
    // bytes are loaded or attached. The document was already injected at turn 3
    // and is in the conversation history — send-once pattern.
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const messages = bedrockCall.input.messages
    const firstUserMsg = messages.find(m => m.role === 'user')
    expect(firstUserMsg).toBeDefined()
    // On turn 4+, NO document or image blocks should be present (send-once)
    if (Array.isArray(firstUserMsg.content)) {
      expect(firstUserMsg.content.find(b => b.document)).toBeUndefined()
      expect(firstUserMsg.content.find(b => b.image)).toBeUndefined()
    }
  })

  it('5 prior user messages → turn 6 (no document re-injection)', async () => {
    setupMocks(5)
    const event = makeChatEvent('Final thoughts?')
    const result = await chatHandler(event)

    expect(result.statusCode).toBe(200)

    // Turn 6: same as turn 4+ — no document blocks (send-once pattern)
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const messages = bedrockCall.input.messages
    const firstUserMsg = messages.find(m => m.role === 'user')
    expect(firstUserMsg).toBeDefined()
    // On turn 6, NO document or image blocks should be present (send-once)
    if (Array.isArray(firstUserMsg.content)) {
      expect(firstUserMsg.content.find(b => b.document)).toBeUndefined()
      expect(firstUserMsg.content.find(b => b.image)).toBeUndefined()
    }
  })
})
