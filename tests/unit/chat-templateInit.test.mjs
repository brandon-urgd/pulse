// Unit tests for Chat Lambda — __template_init__ handler
// Validates: Requirements 6.1, 6.4, 8.4
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
  class ConverseCommand { constructor(input) { this.input = input } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
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

function makeEvent(sessionId, tenantId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId, tenantId },
      // NO .http property → non-streaming path
    },
    body: JSON.stringify(body),
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

const { handler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

describe('Chat Lambda — __template_init__ handler', () => {
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

  describe('__template_init__ writes transcript + updates status atomically (R6.1, R6.4)', () => {
    it('uses TransactWriteItemsCommand to write greeting transcript and update session status', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Test Doc."

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts (idempotency check — empty)
        .mockResolvedValueOnce({}) // TransactWriteItemsCommand

      const event = makeEvent('session-xyz', 'tenant-abc', {
        message: '__template_init__',
        templateGreeting: greeting,
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.greeting).toBe(greeting)
      expect(body.data.alreadyInitialized).toBeUndefined()

      // Verify TransactWriteItemsCommand was called
      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const transactCall = dynamoCalls.find(c => c.constructor.name === 'TransactWriteItemsCommand')
      expect(transactCall).toBeDefined()

      const items = transactCall.input.TransactItems
      expect(items).toHaveLength(2)

      // First item: Put transcript entry
      const putItem = items.find(i => i.Put)
      expect(putItem.Put.Item.role.S).toBe('agent')
      expect(putItem.Put.Item.content.S).toBe(greeting)
      expect(putItem.Put.Item.sessionId.S).toBe('session-xyz')
      expect(putItem.Put.Item.messageId).toBeDefined()
      expect(putItem.Put.Item.timestamp).toBeDefined()

      // Second item: Update session status with ConditionExpression
      const updateItem = items.find(i => i.Update)
      expect(updateItem.Update.ExpressionAttributeValues[':status'].S).toBe('in_progress')
      expect(updateItem.Update.ExpressionAttributeValues[':startedAt']).toBeDefined()
      // Race condition prevention: ConditionExpression prevents overwriting terminal states
      expect(updateItem.Update.ConditionExpression).toBe('#status = :not_started')
      expect(updateItem.Update.ExpressionAttributeValues[':not_started'].S).toBe('not_started')
    })

    it('uses ConsistentRead on idempotency check to prevent duplicate writes', async () => {
      const greeting = "Hey! I'm Pulse."

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({}) // TransactWriteItemsCommand

      const event = makeEvent('session-xyz', 'tenant-abc', {
        message: '__template_init__',
        templateGreeting: greeting,
      })

      await handler(event)

      // Find the Query call (second DynamoDB call)
      const queryCall = dynamoSendSpy.mock.calls
        .map(c => c[0])
        .find(c => c.constructor.name === 'QueryCommand')
      expect(queryCall).toBeDefined()
      expect(queryCall.input.ConsistentRead).toBe(true)
    })
  })

  describe('idempotency: returns alreadyInitialized when transcript exists (R6.1)', () => {
    it('returns alreadyInitialized: true when transcript already has entries', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide."

      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem({ status: { S: 'in_progress' } }) }) // GetItem session
        .mockResolvedValueOnce({ Items: [{ sessionId: { S: 'session-xyz' }, messageId: { S: 'existing-msg' } }] }) // Query transcripts — already has entries

      const event = makeEvent('session-xyz', 'tenant-abc', {
        message: '__template_init__',
        templateGreeting: greeting,
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.alreadyInitialized).toBe(true)
      expect(body.data.greeting).toBe(greeting)

      // TransactWriteItemsCommand should NOT have been called
      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const transactCall = dynamoCalls.find(c => c.constructor.name === 'TransactWriteItemsCommand')
      expect(transactCall).toBeUndefined()
    })
  })

  describe('__init_pregenerated__ is no longer handled (R8.4)', () => {
    it('__init_pregenerated__ is not in SPECIAL_MESSAGES and falls through to Bedrock path', async () => {
      // __init_pregenerated__ is no longer a special message, so it will be treated as a
      // regular user message and go through the Bedrock path. We verify it does NOT trigger
      // the template init path (no idempotency check, no TransactWrite for greeting).
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts (history)
        .mockResolvedValueOnce({ Item: { // GetItem item
          tenantId: { S: 'tenant-abc' },
          itemId: { S: 'item-123' },
          itemName: { S: 'Test Doc' },
          itemType: { S: 'document' },
        }})
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite (reviewer + agent messages)
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        output: { message: { content: [{ text: 'Agent response' }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
      })

      const event = makeEvent('session-xyz', 'tenant-abc', {
        message: '__init_pregenerated__',
        preGeneratedGreeting: 'Old greeting',
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      // It went through Bedrock (regular message path), not the template init path
      expect(bedrockSendSpy).toHaveBeenCalledOnce()

      const body = JSON.parse(result.body)
      // Response is from Bedrock, not the template init handler
      expect(body.data.message).toBe('Agent response')
      expect(body.data.alreadyInitialized).toBeUndefined()
    })
  })
})
