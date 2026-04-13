// Unit tests for urgd-pulse-chat — Session Fast Start features
// Requirements: 2.2, 3.1–3.3, 6.1–6.6
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

describe('urgd-pulse-chat — Session Fast Start', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('page image attachment on first turn', () => {
    it('attaches page images when pageCount > 0 on first turn', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })                    // GetItem session
        .mockResolvedValueOnce({ Items: [] })                              // Query transcripts (empty = first turn)
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } })) // GetItem item with pageCount
        .mockResolvedValueOnce({})                                         // TransactWriteItems
        .mockResolvedValueOnce({})                                         // UpdateItem session

      // S3: extracted.md, document.pdf, page-001.png, page-002.png
      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))   // extracted.md
        .mockResolvedValueOnce(makeS3Bytes('fake-pdf-bytes'))     // document.pdf
        .mockResolvedValueOnce(makeS3Bytes('page-1-bytes'))       // page-001.png
        .mockResolvedValueOnce(makeS3Bytes('page-2-bytes'))       // page-002.png

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      // Bedrock was called with image blocks
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const userContent = bedrockCall.input.messages[0].content
      const imageBlocks = userContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(2)
    })

    it('does not attach page images when pageCount is absent', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())  // no pageCount
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))
        .mockResolvedValueOnce(makeS3Bytes('fake-pdf-bytes'))

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const userContent = bedrockCall.input.messages[0].content
      const imageBlocks = userContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(0)
    })

    it('does not attach page images on subsequent turns', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ status: { S: 'in_progress' } }) })
        .mockResolvedValueOnce({ Items: [                                  // Query transcripts (has history)
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: 'Hello' } },
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000002' }, role: { S: 'agent' }, content: { S: 'Hi there' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '2' } }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy.mockRejectedValue(new Error('NoSuchKey'))
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Response'))

      const res = await handler(makeEvent({ message: 'Follow up question' }))
      expect(res.statusCode).toBe(200)

      // No page image S3 reads should have been attempted for pages
      // (s3 calls are only for extracted.md/document.md which fail)
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const allContent = bedrockCall.input.messages.flatMap(m =>
        Array.isArray(m.content) ? m.content : [m.content]
      )
      const imageBlocks = allContent.filter(b => b?.image)
      expect(imageBlocks).toHaveLength(0)
    })

    it('skips individual page S3 failure and continues', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '3' } }))
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      s3SendSpy
        .mockResolvedValueOnce(makeS3Bytes('# Extracted text'))   // extracted.md
        .mockResolvedValueOnce(makeS3Bytes('fake-pdf-bytes'))     // document.pdf
        .mockResolvedValueOnce(makeS3Bytes('page-1-bytes'))       // page-001.png OK
        .mockResolvedValueOnce(null)                               // page-002.png returns null (getS3Bytes returns null on error)
        .mockResolvedValueOnce(makeS3Bytes('page-3-bytes'))       // page-003.png OK

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      // Should have 2 image blocks (page 2 was null, skipped)
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const userContent = bedrockCall.input.messages[0].content
      const imageBlocks = userContent.filter(b => b.image)
      expect(imageBlocks).toHaveLength(2)
    })
  })

  describe('__init_pregenerated__ path', () => {
    it('writes transcript entries and updates session status atomically', async () => {
      const { TransactWriteItemsCommand } = await import('@aws-sdk/client-dynamodb')

      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })   // GetItem session
        .mockResolvedValueOnce({ Items: [] })              // Query transcripts (empty — idempotency check)
        .mockResolvedValueOnce({})                         // TransactWriteItems

      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: {
          requestId: 'req-test',
          authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
        },
        body: JSON.stringify({
          message: '__init_pregenerated__',
          preGeneratedGreeting: 'Welcome to your session!',
        }),
      }

      const res = await handler(event)
      expect(res.statusCode).toBe(200)

      // Bedrock should NOT be called
      expect(bedrockSendSpy).not.toHaveBeenCalled()

      // TransactWriteItems should have been called
      const transactCall = sendSpy.mock.calls.find(
        ([cmd]) => cmd instanceof TransactWriteItemsCommand
      )
      expect(transactCall).toBeDefined()
      const items = transactCall[0].input.TransactItems
      expect(items).toHaveLength(3) // reviewer msg + agent msg + session update

      // Reviewer message is [__session_start__]
      expect(items[0].Put.Item.role.S).toBe('reviewer')
      expect(items[0].Put.Item.content.S).toBe('[__session_start__]')

      // Agent message is the pre-generated greeting
      expect(items[1].Put.Item.role.S).toBe('agent')
      expect(items[1].Put.Item.content.S).toBe('Welcome to your session!')

      // Session status updated to in_progress
      expect(items[2].Update.ExpressionAttributeValues[':status'].S).toBe('in_progress')
    })

    it('returns early if session already has transcript entries (idempotency)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })   // GetItem session
        .mockResolvedValueOnce({ Items: [                  // Query transcripts — already has entries
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: '[__session_start__]' } },
        ] })

      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: {
          requestId: 'req-test',
          authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
        },
        body: JSON.stringify({
          message: '__init_pregenerated__',
          preGeneratedGreeting: 'Welcome!',
        }),
      }

      const res = await handler(event)
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.alreadyInitialized).toBe(true)

      // No TransactWriteItems — returned early
      expect(sendSpy).toHaveBeenCalledTimes(2) // GetItem + Query only
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })
  })
})
