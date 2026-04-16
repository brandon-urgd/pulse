// Unit tests for prompt cache priming — Chat Lambda no longer handles priming
// Validates: Requirement 13.1 (Phased Cache Priming — template greeting infrastructure removal)
// Updated: Priming has moved to entry point Lambdas (validateSession, createSelfSession, previewSession).
// The Chat Lambda's __template_init__ handler and primeCacheAsync function have been removed.
// Entry point priming tests are in tests/unit/entrypoint-priming.test.mjs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cloudwatchSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
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
  class CloudWatchClient { send(...args) { return cloudwatchSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Math.random().toString(36).slice(2, 8)),
}))

const { handler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

function makeEvent(body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-priming-test',
      authorizer: { sessionId: 'session-prime', tenantId: 'tenant-prime' },
    },
    body: JSON.stringify(body),
  }
}

function makeSessionItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-prime' },
    sessionId: { S: 'session-prime' },
    itemId: { S: 'item-doc-1' },
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

describe('Prompt Cache Priming — Chat Lambda no longer handles priming (R13.1)', () => {
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

  describe('__template_init__ no longer triggers priming in Chat Lambda', () => {
    it('__template_init__ is treated as a regular message — goes through Bedrock, not priming', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: { // GetItem item
          tenantId: { S: 'tenant-prime' },
          itemId: { S: 'item-doc-1' },
          itemName: { S: 'Test PDF Document' },
          itemType: { S: 'document' },
          documentKey: { S: 'pulse/tenant-prime/items/item-doc-1/document.pdf' },
          pageCount: { N: '2' },
        }})
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        output: { message: { content: [{ text: 'Agent response' }] } },
        usage: { inputTokens: 100, outputTokens: 50 },
      })

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review.",
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      // Bedrock was called once — for the regular chat response, not priming
      expect(bedrockSendSpy).toHaveBeenCalledTimes(1)

      // The Bedrock call uses maxTokens: 1024 (regular chat), not maxTokens: 1 (priming)
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      expect(bedrockCall.input.inferenceConfig.maxTokens).toBe(1024)

      // Response is a regular chat response, not the old priming response
      const body = JSON.parse(result.body)
      expect(body.data.message).toBe('Agent response')
      expect(body.data.greeting).toBeUndefined()
    })
  })

  describe('Chat Lambda uses BEDROCK_MODEL_ID for regular calls', () => {
    it('uses BEDROCK_MODEL_ID environment variable for Bedrock calls', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: { // GetItem item
          tenantId: { S: 'tenant-prime' },
          itemId: { S: 'item-doc-1' },
          itemName: { S: 'Test Doc' },
          itemType: { S: 'document' },
        }})
        .mockResolvedValueOnce({}) // UpdateItem streamingLock
        .mockResolvedValueOnce({}) // TransactWrite
        .mockResolvedValueOnce({}) // UpdateItem session state

      bedrockSendSpy.mockResolvedValue({
        output: { message: { content: [{ text: 'Response' }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
      })

      const event = makeEvent({ message: '__session_start__' })
      await handler(event)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      expect(bedrockCall.input.modelId).toBe('us.anthropic.claude-sonnet-4-6')
    })
  })
})
