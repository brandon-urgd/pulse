// Unit tests for urgd-pulse-chat
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
  describe('atomic transcript writes (23.1)', () => {
    it('writes both reviewer and agent messages via TransactWriteItems on success', async () => {
      const { TransactWriteItemsCommand } = await import('@aws-sdk/client-dynamodb')
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })   // GetItem session
        .mockResolvedValueOnce({ Items: [] })              // Query transcripts (empty)
        .mockResolvedValueOnce(makeItemRecord())           // GetItem item
        .mockResolvedValueOnce({})                         // TransactWriteItems
        .mockResolvedValueOnce({})                         // UpdateItem session

      s3SendSpy.mockRejectedValue(new Error('no file'))
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Hello reviewer!'))
      cwSendSpy.mockResolvedValue({})
      lambdaSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      const transactCall = sendSpy.mock.calls.find(
        ([cmd]) => cmd instanceof TransactWriteItemsCommand
      )
      expect(transactCall).toBeDefined()
      const items = transactCall[0].input.TransactItems
      expect(items).toHaveLength(2)
      expect(items[0].Put.Item.role.S).toBe('reviewer')
      expect(items[1].Put.Item.role.S).toBe('agent')
    })

    it('writes nothing to DynamoDB when Bedrock fails', async () => {
      const { TransactWriteItemsCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb')
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })   // GetItem session
        .mockResolvedValueOnce({ Items: [] })              // Query transcripts
        .mockResolvedValueOnce(makeItemRecord())           // GetItem item

      s3SendSpy.mockRejectedValue(new Error('no file'))
      bedrockSendSpy.mockRejectedValueOnce(new Error('Bedrock unavailable'))
      cwSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)

      const writeCalls = sendSpy.mock.calls.filter(
        ([cmd]) => cmd instanceof TransactWriteItemsCommand || cmd instanceof PutItemCommand
      )
      expect(writeCalls).toHaveLength(0)
    })
  })

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

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
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

// DynamoDB call order for normal message (new atomic flow):
// 0: GetItem session, 1: Query transcripts, 2: GetItem item, [Bedrock], 3: TransactWriteItems, 4: UpdateItem session
// S3 calls (s3SendSpy) happen between Query transcripts and GetItem item but use a separate spy

describe('urgd-pulse-chat', () => {
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

  describe('successful chat exchange', () => {
    it('returns 200 with agent message for valid chat', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() }) // GetItem session
        .mockResolvedValueOnce({ Items: [               // Query transcripts
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: 'Hello' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord())         // GetItem item
        .mockResolvedValueOnce({})                       // TransactWriteItems
        .mockResolvedValueOnce({})                       // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Hello! How can I help?'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.message).toBe('Hello! How can I help?')
      expect(body.data.section).toBe(1)
      expect(body.data.sessionComplete).toBe(false)
    })

    it('handles __session_start__ and saves reviewer message to transcript', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ status: { S: 'not_started' } }) })
        .mockResolvedValueOnce({ Items: [] })             // Query transcripts (empty — first message)
        .mockResolvedValueOnce(makeItemRecord())          // GetItem item
        .mockResolvedValueOnce({})                        // TransactWriteItems
        .mockResolvedValueOnce({})                        // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

      const res = await handler(makeEvent({ message: '__session_start__' }))
      expect(res.statusCode).toBe(200)

      // GetItem session(0), Query(1), GetItem item(2), TransactWriteItems(3), UpdateItem(4) = 5 calls
      expect(sendSpy).toHaveBeenCalledTimes(5)
      // Reviewer message is in the TransactWriteItems call
      const { TransactWriteItemsCommand } = await import('@aws-sdk/client-dynamodb')
      const transactCall = sendSpy.mock.calls.find(([cmd]) => cmd instanceof TransactWriteItemsCommand)
      expect(transactCall).toBeDefined()
      expect(transactCall[0].input.TransactItems[0].Put.Item.role.S).toBe('reviewer')
      expect(transactCall[0].input.TransactItems[0].Put.Item.content.S).toBe('[__session_start__]')
    })

    it('handles __session_resume__ and saves reviewer message to transcript', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [                 // Query transcripts
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: '[__session_resume__]' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord())          // GetItem item
        .mockResolvedValueOnce({})                        // TransactWriteItems
        .mockResolvedValueOnce({})                        // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome back!'))

      const res = await handler(makeEvent({ message: '__session_resume__' }))
      expect(res.statusCode).toBe(200)
    })

    it('marks session complete on __session_end__', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })  // GetItem session
        .mockResolvedValueOnce({ Items: [] })             // Query transcripts
        .mockResolvedValueOnce(makeItemRecord())          // GetItem item
        .mockResolvedValueOnce({})                        // TransactWriteItems
        .mockResolvedValueOnce({})                        // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Thank you for your feedback.'))

      const res = await handler(makeEvent({ message: '__session_end__' }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.sessionComplete).toBe(true)
    })

    it('detects section transition from agent response', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })  // GetItem session
        .mockResolvedValueOnce({ Items: [                 // Query transcripts
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: 'Hello' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord())          // GetItem item
        .mockResolvedValueOnce({})                        // TransactWriteItems
        .mockResolvedValueOnce({})                        // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('Great! [SECTION:2] Now let\'s discuss...'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.section).toBe(2)
    })
  })

  describe('access control', () => {
    it('returns 403 when confidentialityAcceptedAt is not set', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeSession({ confidentialityAcceptedAt: undefined }),
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(403)
    })

    it('returns 410 when session is expired', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeSession({ status: { S: 'expired' } }),
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(410)
    })

    it('returns 410 when session is completed', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeSession({ status: { S: 'completed' } }),
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(410)
    })

    it('returns 401 when sessionId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-1' } },
        body: JSON.stringify({ message: 'Hello' }),
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('error handling', () => {
    it('returns 404 when session not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(404)
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' } },
        body: 'not-json',
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when message is missing', async () => {
      const res = await handler(makeEvent({ message: undefined }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)
    })

    it('returns 500 on Bedrock failure', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })  // GetItem session
        .mockResolvedValueOnce({ Items: [                 // Query transcripts
          { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: 'Hello' } },
        ] })
        .mockResolvedValueOnce(makeItemRecord())          // GetItem item

      bedrockSendSpy.mockRejectedValueOnce(new Error('Bedrock error'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)
    })

    it('returns 503 on Bedrock AccessDeniedException', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      const err = Object.assign(new Error('Access denied'), { name: 'AccessDeniedException' })
      bedrockSendSpy.mockRejectedValueOnce(err)
      cwSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(503)
    })

    it('returns 503 on Bedrock ThrottlingException', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce(makeItemRecord())

      const err = Object.assign(new Error('Throttled'), { name: 'ThrottlingException' })
      bedrockSendSpy.mockRejectedValueOnce(err)
      cwSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(503)
    })
  })
})
