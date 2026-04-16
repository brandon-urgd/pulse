// Unit tests for Chat Lambda — __template_init__ handler REMOVED
// Validates: Requirement 13.1 (Phased Cache Priming — template greeting infrastructure removal)
// Updated: The __template_init__ handler has been removed. These tests verify it is no longer handled.
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

describe('Chat Lambda — __template_init__ handler removed (R13.1)', () => {
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

  describe('__template_init__ is treated as a regular message (R13.1)', () => {
    it('routes __template_init__ through Bedrock instead of the old handler', async () => {
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
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse.",
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      // It went through Bedrock (regular message path)
      expect(bedrockSendSpy).toHaveBeenCalledOnce()

      const body = JSON.parse(result.body)
      expect(body.data.message).toBe('Agent response')
      // Old handler response fields are absent
      expect(body.data.greeting).toBeUndefined()
      expect(body.data.alreadyInitialized).toBeUndefined()
    })
  })

  describe('__init_pregenerated__ is no longer handled (R8.4)', () => {
    it('__init_pregenerated__ is not in SPECIAL_MESSAGES and falls through to Bedrock path', async () => {
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

      expect(bedrockSendSpy).toHaveBeenCalledOnce()

      const body = JSON.parse(result.body)
      expect(body.data.message).toBe('Agent response')
      expect(body.data.alreadyInitialized).toBeUndefined()
    })
  })
})
