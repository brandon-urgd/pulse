// Unit tests for prompt cache priming — __template_init__ priming call structure
// Validates: Requirements 3.1, 3.2, 3.3, 3.5, 7.1, 7.2
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

// Track console.warn calls for priming failure logging verification
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

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

// --- Helpers ---

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

function makeDocumentItemRecord(overrides = {}) {
  return {
    Item: {
      tenantId: { S: 'tenant-prime' },
      itemId: { S: 'item-doc-1' },
      itemName: { S: 'Test PDF Document' },
      description: { S: 'A test PDF for priming' },
      itemType: { S: 'document' },
      documentKey: { S: 'pulse/tenant-prime/items/item-doc-1/document.pdf' },
      pageCount: { N: '2' },
      ...overrides,
    },
  }
}

function makePrimingBedrockResponse() {
  return {
    output: { message: { content: [{ text: '' }] } },
    usage: {
      inputTokens: 5000,
      outputTokens: 1,
      cacheWriteInputTokens: 4800,
      cacheReadInputTokens: 0,
    },
  }
}

/** Creates a fake S3 readable stream from a Buffer */
function fakeS3Body(buf) {
  return {
    Body: {
      async *[Symbol.asyncIterator]() { yield buf },
    },
  }
}

const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4 fake document content')
const FAKE_PAGE_BYTES = Buffer.from('fake-png-page-image')

/**
 * Sets up S3 mock to return document bytes and page images.
 * The S3 mock routes based on the key in the GetObjectCommand input.
 */
function setupS3ForDocumentPriming() {
  s3SendSpy.mockImplementation((cmd) => {
    const key = cmd.input?.Key || ''
    if (key.endsWith('.pdf')) {
      return Promise.resolve(fakeS3Body(FAKE_PDF_BYTES))
    }
    if (key.includes('/pages/page-')) {
      return Promise.resolve(fakeS3Body(FAKE_PAGE_BYTES))
    }
    return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })
}

/**
 * Sets up DynamoDB mocks for a standard __template_init__ flow that triggers priming.
 * Call order: GetItem session → Query transcripts → TransactWrite → GetItem item (for priming)
 */
function setupDynamoForPriming(sessionOverrides = {}, itemOverrides = {}) {
  dynamoSendSpy
    .mockResolvedValueOnce({ Item: makeSessionItem(sessionOverrides) }) // GetItem session
    .mockResolvedValueOnce({ Items: [] })                               // Query transcripts (empty — first init)
    .mockResolvedValueOnce({})                                          // TransactWriteItemsCommand
    .mockResolvedValueOnce(makeDocumentItemRecord(itemOverrides))       // GetItem item (for priming)
}

describe('Prompt Cache Priming — unit tests', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cloudwatchSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    consoleWarnSpy.mockClear()
    cloudwatchSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
    s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })

  describe('priming uses ConverseCommand (not ConverseStreamCommand)', () => {
    it('calls Bedrock with ConverseCommand for the priming call', async () => {
      setupDynamoForPriming()
      setupS3ForDocumentPriming()
      bedrockSendSpy.mockResolvedValueOnce(makePrimingBedrockResponse())

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review of Test PDF Document.",
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      // Verify Bedrock was called exactly once (the priming call)
      expect(bedrockSendSpy).toHaveBeenCalledTimes(1)

      // Verify the command is ConverseCommand, not ConverseStreamCommand
      const { ConverseCommand, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime')
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      expect(bedrockCall).toBeInstanceOf(ConverseCommand)
      expect(bedrockCall).not.toBeInstanceOf(ConverseStreamCommand)
    })
  })

  describe('priming call has maxTokens: 1', () => {
    it('sets inferenceConfig.maxTokens to 1 to minimize cost', async () => {
      setupDynamoForPriming()
      setupS3ForDocumentPriming()
      bedrockSendSpy.mockResolvedValueOnce(makePrimingBedrockResponse())

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review.",
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      expect(bedrockCall.input.inferenceConfig).toBeDefined()
      expect(bedrockCall.input.inferenceConfig.maxTokens).toBe(1)
    })
  })

  describe('priming call uses same modelId as real calls', () => {
    it('uses BEDROCK_MODEL_ID environment variable for the priming call', async () => {
      setupDynamoForPriming()
      setupS3ForDocumentPriming()
      bedrockSendSpy.mockResolvedValueOnce(makePrimingBedrockResponse())

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review.",
      })

      const result = await handler(event)
      expect(result.statusCode).toBe(200)

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      expect(bedrockCall.input.modelId).toBe('us.anthropic.claude-sonnet-4-6')
    })
  })

  describe('priming failure logs warning but response is still 200', () => {
    it('returns 200 when priming call throws ThrottlingException', async () => {
      setupDynamoForPriming()
      setupS3ForDocumentPriming()

      const throttleErr = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' })
      bedrockSendSpy.mockRejectedValueOnce(throttleErr)

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review.",
      })

      const result = await handler(event)

      // Response is still 200 — priming failure does not affect the client
      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.greeting).toBe("Hey! I'm Pulse — here to guide your review.")

      // Verify a warning was logged about the priming failure
      const warnCalls = consoleWarnSpy.mock.calls.map(c => c[0])
      const primingWarn = warnCalls.find(msg =>
        typeof msg === 'string' && msg.includes('priming call failed')
      )
      expect(primingWarn).toBeDefined()
    })

    it('returns 200 when priming call throws a generic error', async () => {
      setupDynamoForPriming()
      setupS3ForDocumentPriming()

      bedrockSendSpy.mockRejectedValueOnce(new Error('Bedrock unavailable'))

      const event = makeEvent({
        message: '__template_init__',
        templateGreeting: "Hey! I'm Pulse — here to guide your review.",
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.greeting).toBe("Hey! I'm Pulse — here to guide your review.")
    })
  })
})
