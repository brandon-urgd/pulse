// Unit tests for template greeting infrastructure removal
// Validates: Requirements 13.1, 13.3 (Phased Cache Priming — Task 6)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// Task 6.7: Verify __template_init__ is no longer handled by the Chat Lambda
// ═══════════════════════════════════════════════════════════════════════════

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

describe('Template greeting infrastructure removal (Task 6)', () => {
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

  // ── Task 6.7: __template_init__ is no longer handled ──────────────────────
  describe('__template_init__ is no longer handled by the Chat Lambda (R13.1)', () => {
    it('treats __template_init__ as a regular message and routes through Bedrock', async () => {
      // Setup: session exists, item exists, Bedrock returns a response
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

      // It went through Bedrock (regular message path), not the old template init handler
      expect(bedrockSendSpy).toHaveBeenCalledOnce()

      const body = JSON.parse(result.body)
      // Response is from Bedrock, not the old template init handler
      expect(body.data.message).toBe('Agent response')
      expect(body.data.greeting).toBeUndefined()
      expect(body.data.alreadyInitialized).toBeUndefined()
    })

    it('__template_init__ is not in the SPECIAL_MESSAGES array', async () => {
      // Send __template_init__ — if it were still special, it would be wrapped in brackets
      // in the transcript. Since it's no longer special, it goes through as a regular message.
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: makeSessionItem() }) // GetItem session
        .mockResolvedValueOnce({ Items: [] }) // Query transcripts
        .mockResolvedValueOnce({ Item: { // GetItem item
          tenantId: { S: 'tenant-abc' },
          itemId: { S: 'item-123' },
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

      const event = makeEvent('session-xyz', 'tenant-abc', {
        message: '__template_init__',
      })

      await handler(event)

      // Verify the message was sent to Bedrock as a regular user message (not wrapped in brackets)
      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const messages = bedrockCall.input.messages
      const lastUserMsg = messages.filter(m => m.role === 'user').pop()
      const textContent = lastUserMsg.content.find(b => b.text)?.text
      expect(textContent).toBe('__template_init__')
      // If it were still special, it would be '[__template_init__]'
      expect(textContent).not.toBe('[__template_init__]')
    })
  })

  // ── Task 6.8: buildSystemPrompt no longer accepts templateGreeting ────────
  describe('buildSystemPrompt no longer accepts templateGreeting parameter (R13.3)', () => {
    it('does not include GREETING CONTEXT section in the system prompt', async () => {
      const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

      // Even if templateGreeting is passed, it should be ignored
      const prompt = buildSystemPrompt({
        itemName: 'Test Document',
        itemDescription: '',
        itemContent: 'Some content here.',
        itemType: 'document',
        totalSections: 3,
        currentSection: 1,
        closingState: 'exploring',
        windingDown: false,
        message: 'Hello',
        isSpecial: false,
        frozenSnapshot: null,
        coverageMap: null,
        imageBase64: null,
        isSelfReview: false,
        timeLimitMinutes: 17,
        nativeDocumentAvailable: false,
        templateGreeting: "Hey! I'm Pulse — an AI feedback guide.",
      })

      expect(prompt).not.toContain('GREETING CONTEXT')
      expect(prompt).not.toContain('You already delivered the following greeting')
    })

    it('builds a valid system prompt without templateGreeting parameter', async () => {
      const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

      const prompt = buildSystemPrompt({
        itemName: 'Test Document',
        itemDescription: 'Review this document for clarity.',
        itemContent: 'Some content here.',
        itemType: 'document',
        totalSections: 3,
        currentSection: 1,
        closingState: 'exploring',
        windingDown: false,
        message: '__session_start__',
        isSpecial: true,
        frozenSnapshot: null,
        coverageMap: null,
        imageBase64: null,
        isSelfReview: false,
        timeLimitMinutes: 17,
        nativeDocumentAvailable: false,
      })

      // Prompt should still contain core sections
      expect(prompt).toContain('BEHAVIORAL GUARDRAILS')
      expect(prompt).toContain('Test Document')
      expect(prompt).toContain('Review this document for clarity.')
      expect(prompt).not.toContain('GREETING CONTEXT')
    })
  })
})
