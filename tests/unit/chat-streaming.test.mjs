// Unit tests for urgd-pulse-chat (non-streaming path)
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cloudwatchSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send(...args) { return bedrockSendSpy(...args) }
  }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  class InvokeModelWithResponseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient {
    send(...args) { return cloudwatchSendSpy(...args) }
  }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send(...args) { return lambdaSendSpy(...args) }
  }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Math.random().toString(36).slice(2, 8)),
}))

function makeEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId, tenantId },
      // NO .http property → non-streaming path
    },
    body: JSON.stringify({ message }),
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
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    ...overrides,
  }
}

function makeItemRecord() {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Please review this document.' },
    itemType: { S: 'document' },
  }
}

const { handler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

describe('urgd-pulse-chat (non-streaming)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cloudwatchSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cloudwatchSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
    s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })

  describe('concurrent request guard: streamingLock < 60s → 409', () => {
    it('returns 409 when streamingLock is recent', async () => {
      const recentLock = new Date(Date.now() - 5000).toISOString() // 5 seconds ago
      dynamoSendSpy.mockResolvedValueOnce({
        Item: makeSessionItem({ streamingLock: { S: recentLock } }),
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(409)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('concurrent request guard: no lock → proceeds normally', () => {
    it('proceeds when no streamingLock is set', async () => {
      // Session (no lock), transcripts, item, bedrock
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Agent response here' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
    })
  })

  describe('session not found → 404', () => {
    it('returns 404 when session does not exist', async () => {
      dynamoSendSpy.mockResolvedValueOnce({ Item: null })

      const event = makeEvent('session-not-found', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('session expired → 410', () => {
    it('returns 410 when session status is expired', async () => {
      dynamoSendSpy.mockResolvedValueOnce({
        Item: makeSessionItem({ status: { S: 'expired' } }),
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(410)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })

    it('returns 410 when session status is completed', async () => {
      dynamoSendSpy.mockResolvedValueOnce({
        Item: makeSessionItem({ status: { S: 'completed' } }),
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(410)
    })
  })

  describe('confidentiality not accepted → 403', () => {
    it('returns 403 when confidentialityAcceptedAt is missing', async () => {
      dynamoSendSpy.mockResolvedValueOnce({
        Item: makeSessionItem({ confidentialityAcceptedAt: undefined }),
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('successful non-streaming chat → 200 with message', () => {
    it('returns 200 with agent message in response body', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Agent response here' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.message).toBe('Agent response here')
    })
  })

  describe('TransactWrite called after Bedrock response', () => {
    it('calls TransactWriteItemsCommand to write transcript entries', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Agent response here' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const transactCall = dynamoCalls.find(c => c.constructor.name === 'TransactWriteItemsCommand')
      expect(transactCall).toBeDefined()

      // Verify both reviewer and agent messages are written
      const items = transactCall.input.TransactItems
      expect(items).toHaveLength(2)
      const roles = items.map(i => i.Put.Item.role.S)
      expect(roles).toContain('reviewer')
      expect(roles).toContain('agent')
    })
  })

  describe('session state updated (currentSection, closingState)', () => {
    it('calls UpdateItemCommand to update session state after Bedrock response', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: makeItemRecord() }) // GetItem item
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Agent response here' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })

      const event = makeEvent('session-xyz', 'tenant-abc', 'Hello')
      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const updateCalls = dynamoCalls.filter(c => c.constructor.name === 'UpdateItemCommand')
      // At least one UpdateItemCommand for session state
      expect(updateCalls.length).toBeGreaterThanOrEqual(1)

      // Find the session state update (has closingState)
      const sessionStateUpdate = updateCalls.find(c =>
        c.input.ExpressionAttributeValues?.[':closingState']
      )
      expect(sessionStateUpdate).toBeDefined()
      expect(sessionStateUpdate.input.Key.sessionId.S).toBe('session-xyz')
    })
  })
})
