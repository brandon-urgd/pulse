// Unit tests for urgd-pulse-chat — preview mode behavior
// Requirements: 5.2
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
  class InvokeModelCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand }
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

const { handler } = await import('./index.mjs')

function makePreviewEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: {
        sessionId: 'preview-session-1',
        tenantId: 'tenant-1',
        preview: 'true',  // preview flag from sessionAuth authorizer context
      },
    },
    body: JSON.stringify({ message: 'Hello', ...overrides }),
  }
}

function makeNormalEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: {
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        preview: 'false',  // not a preview session
      },
    },
    body: JSON.stringify({ message: 'Hello', ...overrides }),
  }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    itemId: { S: 'item-1' },
    currentSection: { N: '1' },
    totalSections: { N: '5' },
    ...overrides,
  }
}

function makeItemRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-1' },
      itemId: { S: 'item-1' },
      itemName: { S: 'Test Document' },
      description: { S: 'A test document for review' },
    },
  }
}

function makeBedrockResponse(text = 'Agent response') {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  }
}

describe('urgd-pulse-chat — preview mode', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    s3SendSpy.mockRejectedValue(new Error('NoSuchKey'))
    cwSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('with preview: true context', () => {
    it('calls Bedrock and returns the response normally', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ sessionId: { S: 'preview-session-1' } }) })
        .mockResolvedValueOnce({ Items: [] })   // Query transcripts
        .mockResolvedValueOnce(makeItemRecord()) // GetItem item

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Preview agent response'))

      const res = await handler(makePreviewEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.message).toBe('Preview agent response')
    })

    it('does NOT write transcript to DynamoDB', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ sessionId: { S: 'preview-session-1' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Preview response'))

      await handler(makePreviewEvent())

      // In preview mode: only GetItem (session) + Query (transcripts) + GetItem (item) = 3 DynamoDB calls
      // No TransactWriteItems, no UpdateItem
      const { TransactWriteItemsCommand, UpdateItemCommand } = await import('@aws-sdk/client-dynamodb')
      const writeCalls = sendSpy.mock.calls.filter(
        ([cmd]) => cmd instanceof TransactWriteItemsCommand || cmd instanceof UpdateItemCommand
      )
      expect(writeCalls).toHaveLength(0)
    })

    it('does NOT update session state in DynamoDB', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ sessionId: { S: 'preview-session-1' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Preview response'))

      await handler(makePreviewEvent())

      const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb')
      const updateCalls = sendSpy.mock.calls.filter(([cmd]) => cmd instanceof UpdateItemCommand)
      expect(updateCalls).toHaveLength(0)
    })

    it('does NOT invoke generateSessionSummary or generateReport', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ sessionId: { S: 'preview-session-1' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      // Session complete signal
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Thanks! [SESSION_COMPLETE]'))

      await handler(makePreviewEvent({ message: '__session_end__' }))

      // Lambda should NOT be invoked for summary/report generation
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })

    it('returns section and sessionComplete in response even in preview mode', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ sessionId: { S: 'preview-session-1' } }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Done! [SESSION_COMPLETE]'))

      const res = await handler(makePreviewEvent({ message: '__session_end__' }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.sessionComplete).toBe(true)
    })
  })

  describe('with preview: false context (normal write path)', () => {
    it('calls Bedrock and returns the response', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())
        .mockResolvedValueOnce({})  // TransactWriteItems
        .mockResolvedValueOnce({})  // UpdateItem

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Normal response'))

      const res = await handler(makeNormalEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.message).toBe('Normal response')
    })

    it('writes transcript to DynamoDB via TransactWriteItems', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())
        .mockResolvedValueOnce({})  // TransactWriteItems
        .mockResolvedValueOnce({})  // UpdateItem

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Normal response'))

      await handler(makeNormalEvent())

      const { TransactWriteItemsCommand } = await import('@aws-sdk/client-dynamodb')
      const transactCalls = sendSpy.mock.calls.filter(([cmd]) => cmd instanceof TransactWriteItemsCommand)
      expect(transactCalls).toHaveLength(1)
      const items = transactCalls[0][0].input.TransactItems
      expect(items).toHaveLength(2)
      expect(items[0].Put.Item.role.S).toBe('reviewer')
      expect(items[1].Put.Item.role.S).toBe('agent')
    })

    it('updates session state in DynamoDB', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())
        .mockResolvedValueOnce({})  // TransactWriteItems
        .mockResolvedValueOnce({})  // UpdateItem

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Normal response'))

      await handler(makeNormalEvent())

      const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb')
      const updateCalls = sendSpy.mock.calls.filter(([cmd]) => cmd instanceof UpdateItemCommand)
      expect(updateCalls).toHaveLength(1)
    })
  })
})
