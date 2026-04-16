// Unit tests for urgd-pulse-chat — Session Fast Start features
// Requirements: 2.2, 3.1–3.3, 6.1–6.6
// Updated: Phased Cache Priming — turns 1-2 are text-only, document injection at turn 3+
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({ ulid: () => '01HTEST000000000000000001' }))

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: vi.fn((code, body) => ({ statusCode: code, body: JSON.stringify(body) })),
  errorResponse: vi.fn((code, msg) => ({ statusCode: code, body: JSON.stringify({ error: true, message: msg }) })),
}))

vi.mock('./shared/buildSystemPrompt.mjs', async () => {
  const actual = await vi.importActual('../../lambdas/shared/buildSystemPrompt.mjs')
  return actual
})

const { handler } = await import('./index.mjs')

// ── Helpers ──

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
    },
    body: JSON.stringify({ message: '__session_start__', ...overrides }),
  }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    status: { S: 'not_started' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    itemId: { S: 'item-1' },
    currentSection: { N: '1' },
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    frozenSnapshot: { M: {} },
    ...overrides,
  }
}

function makeItemRecord(overrides = {}) {
  return {
    Item: {
      tenantId: { S: 'tenant-1' },
      itemId: { S: 'item-1' },
      itemName: { S: 'Test Document' },
      description: { S: 'A test document for review' },
      documentKey: { S: 'pulse/tenant-1/items/item-1/document.pdf' },
      ...overrides,
    },
  }
}

function makeBedrockResponse(text = 'Agent response') {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

function makeS3Bytes(content) {
  return {
    Body: (async function* () { yield Buffer.from(content) })(),
  }
}

// ── Tests ──

describe('urgd-pulse-chat — Session Fast Start (Phased Cache Priming)', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('turn 1 (text-only phase) — no page images or document attached', () => {
    it('does not attach page images on turn 1 (__session_start__)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })                    // GetItem session
        .mockResolvedValueOnce({ Items: [] })                              // Query transcripts (empty = turn 1)
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } })) // GetItem item with pageCount
        .mockResolvedValueOnce({})                                         // UpdateItem streamingLock
        .mockResolvedValueOnce({})                                         // TransactWriteItems
        .mockResolvedValueOnce({})                                         // UpdateItem session

      // S3: only extracted.md is loaded (no document.pdf or page images on turn 1)
      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))   // extracted.md
        .mockRejectedValue(new Error('NoSuchKey'))                // any other S3 calls fail

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      // Bedrock was called without image blocks (text-only phase)
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const userContent = bedrockCall.input.messages[0].content
      const imageBlocks = userContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(0)

      // No document block either
      const docBlocks = userContent.filter(b => b.document)
      expect(docBlocks).toHaveLength(0)
    })

    it('does not attach page images when pageCount is absent', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())  // no pageCount
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))
        .mockRejectedValue(new Error('NoSuchKey'))

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const userContent = bedrockCall.input.messages[0].content
      const imageBlocks = userContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(0)
    })
  })

  describe('turn 2 (text-only phase) — no page images or document attached', () => {
    it('does not attach page images on turn 2 (1 prior user message)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ status: { S: 'in_progress' } }) })
        .mockResolvedValueOnce({ Items: [
          // 1 prior user message = turn 2
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-1' }, role: { S: 'reviewer' }, content: { S: '[__session_start__]' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-2' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))
        .mockRejectedValue(new Error('NoSuchKey'))

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Response'))

      const res = await handler(makeEvent({ message: 'My first real message' }))
      expect(res.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const allContent = bedrockCall.input.messages.flatMap(m =>
        Array.isArray(m.content) ? m.content : [m.content]
      )
      const imageBlocks = allContent.filter(b => b?.image)
      expect(imageBlocks).toHaveLength(0)
    })
  })

  describe('turn 3+ (document injection phase) — page images attached', () => {
    it('attaches page images on turn 3 (2 prior user messages)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ status: { S: 'in_progress' } }) })
        .mockResolvedValueOnce({ Items: [
          // 2 prior user messages = turn 3
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-1' }, role: { S: 'reviewer' }, content: { S: '[__session_start__]' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-2' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-3' }, role: { S: 'reviewer' }, content: { S: 'First message' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-4' }, role: { S: 'agent' }, content: { S: 'Response' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))   // extracted.md
        .mockResolvedValueOnce(makeS3Bytes('fake-pdf-bytes'))     // document.pdf
        .mockResolvedValueOnce(makeS3Bytes('page-1-bytes'))       // page-001.png
        .mockResolvedValueOnce(makeS3Bytes('page-2-bytes'))       // page-002.png

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Full doc response'))

      const res = await handler(makeEvent({ message: 'Second message' }))
      expect(res.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const firstUserContent = bedrockCall.input.messages[0].content
      const imageBlocks = firstUserContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(2)

      // Document block should also be present
      const docBlocks = firstUserContent.filter(b => b.document)
      expect(docBlocks).toHaveLength(1)
    })

    it('does not attach page images on turns after injection (turn 4+)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ status: { S: 'in_progress' } }) })
        .mockResolvedValueOnce({ Items: [
          // 3 prior user messages = turn 4 (document already injected at turn 3)
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-1' }, role: { S: 'reviewer' }, content: { S: '[__session_start__]' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-2' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-3' }, role: { S: 'reviewer' }, content: { S: 'First message' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-4' }, role: { S: 'agent' }, content: { S: 'Response' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-5' }, role: { S: 'reviewer' }, content: { S: 'Second message' } },
          { sessionId: { S: 'session-1' }, messageId: { S: 'msg-6' }, role: { S: 'agent' }, content: { S: 'Full doc response' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy.mockRejectedValue(new Error('NoSuchKey'))
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Follow-up response'))

      const res = await handler(makeEvent({ message: 'Third message' }))
      expect(res.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const allContent = bedrockCall.input.messages.flatMap(m =>
        Array.isArray(m.content) ? m.content : [m.content]
      )
      const imageBlocks = allContent.filter(b => b?.image)
      expect(imageBlocks).toHaveLength(0)
    })
  })

  // NOTE: __template_init__ handler was removed in the phased-cache-priming spec.
  // Priming is now handled by entry point Lambdas (validateSession, createSelfSession, previewSession).
  // Tests for entry point priming are in tests/unit/entrypoint-priming.test.mjs.
})
