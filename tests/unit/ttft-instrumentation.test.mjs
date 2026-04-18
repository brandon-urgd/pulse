// Unit tests for TTFT (Time-to-First-Token) instrumentation in the Chat Lambda
// Task 5.2 — Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Environment variables (must be before dynamic imports) ──

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Spy factories ──

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cloudwatchSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

// ── AWS SDK mocks ──

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input; this.name = 'TransactWriteItemsCommand' } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input; this.name = 'ConverseCommand' } }
  class ConverseStreamCommand { constructor(input) { this.input = input; this.name = 'ConverseStreamCommand' } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cloudwatchSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input; this.name = 'PutMetricDataCommand' } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Math.random().toString(36).slice(2, 8)),
}))

// ── Mock globalThis.awslambda so the handler uses the streaming wrapper ──
// streamifyResponse wraps the handler so it receives (event, responseStream, context)
globalThis.awslambda = {
  streamifyResponse: (fn) => fn,
}

// ── Import AFTER awslambda mock is set ──
const { handler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

// ── Helpers ──

function makeS3Body(text) {
  return {
    Body: {
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(text) },
    },
  }
}

/** Build a Function URL streaming event (has requestContext.http → isStreaming = true) */
function makeStreamingEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-ttft-test',
      authorizer: { sessionId, tenantId },
      http: { method: 'POST' }, // .http present → isStreaming = true
    },
    body: JSON.stringify({ message }),
  }
}

/** Build an API Gateway event (no requestContext.http → isStreaming = false) */
function makeNonStreamingEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-ttft-test',
      authorizer: { sessionId, tenantId },
      // NO .http → non-streaming path
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
    totalSections: { N: '3' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    ...overrides,
  }
}

function makeItemRecord(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Review this document.' },
    itemType: { S: 'document' },
    ...overrides,
  }
}

function makeResponseStream() {
  const writes = []
  return {
    writes,
    write: vi.fn((data) => writes.push(data)),
    end: vi.fn(),
  }
}

/** Set up DynamoDB + S3 mocks for a successful chat call (turn 1, text-only) */
function mockHappyPath() {
  dynamoSendSpy
    .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
    .mockResolvedValueOnce({ Items: [] })                      // Query transcripts (empty = turn 1)
    .mockResolvedValueOnce({ Item: makeItemRecord() })         // GetItem item
    .mockResolvedValueOnce({})                                 // UpdateItem streamingLock
    .mockResolvedValueOnce({})                                 // TransactWrite
    .mockResolvedValueOnce({})                                 // UpdateItem session state

  // S3: extracted.md found, no other S3 calls needed for turn 1
  s3SendSpy.mockResolvedValueOnce(makeS3Body('# Extracted text content'))
}

// ── Tests ──

describe('TTFT instrumentation', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cloudwatchSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cloudwatchSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('streaming path — TTFT is captured and logged (Req 6.1, 6.2, 6.5)', () => {
    it('captures ttftMs on the first contentBlockDelta with text and logs it', async () => {
      mockHappyPath()

      // ConverseStream returns an async iterable with a text delta followed by metadata
      bedrockSendSpy.mockResolvedValueOnce({
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: 'Hello ' } } }
          yield { contentBlockDelta: { delta: { text: 'world' } } }
          yield { metadata: { usage: { inputTokens: 150, outputTokens: 30 } } }
        })(),
      })

      const event = makeStreamingEvent('session-xyz', 'tenant-abc', '__session_start__')
      const responseStream = makeResponseStream()

      await handler(event, responseStream)

      // responseStream should have received the streamed text
      expect(responseStream.write).toHaveBeenCalledWith('Hello ')
      expect(responseStream.write).toHaveBeenCalledWith('world')
      expect(responseStream.end).toHaveBeenCalled()

      // CloudWatch should have been called with metrics including TimeToFirstToken
      expect(cloudwatchSendSpy).toHaveBeenCalled()
      const cwCall = cloudwatchSendSpy.mock.calls[0][0]
      expect(cwCall.name).toBe('PutMetricDataCommand')

      const metricData = cwCall.input.MetricData
      const ttftMetric = metricData.find(m => m.MetricName === 'TimeToFirstToken')
      expect(ttftMetric).toBeDefined()
      expect(ttftMetric.Unit).toBe('Milliseconds')
      expect(typeof ttftMetric.Value).toBe('number')
      expect(ttftMetric.Value).toBeGreaterThanOrEqual(0)
    })
  })

  describe('streaming path — TTFT CloudWatch metric is published (Req 6.3)', () => {
    it('publishes TimeToFirstToken metric in Pulse/Chat namespace with Milliseconds unit', async () => {
      mockHappyPath()

      bedrockSendSpy.mockResolvedValueOnce({
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: 'Response text' } } }
          yield { metadata: { usage: { inputTokens: 200, outputTokens: 40 } } }
        })(),
      })

      const event = makeStreamingEvent('session-xyz', 'tenant-abc', '__session_start__')
      const responseStream = makeResponseStream()

      await handler(event, responseStream)

      expect(cloudwatchSendSpy).toHaveBeenCalled()
      const cwCall = cloudwatchSendSpy.mock.calls[0][0]
      expect(cwCall.input.Namespace).toBe('Pulse/Chat')

      const metricData = cwCall.input.MetricData
      const ttftMetric = metricData.find(m => m.MetricName === 'TimeToFirstToken')
      expect(ttftMetric).toBeDefined()
      expect(ttftMetric.Unit).toBe('Milliseconds')
      expect(typeof ttftMetric.Value).toBe('number')

      // Also verify standard metrics are still published alongside TTFT
      const latencyMetric = metricData.find(m => m.MetricName === 'BedrockLatency')
      expect(latencyMetric).toBeDefined()
      const tokensInMetric = metricData.find(m => m.MetricName === 'BedrockTokensIn')
      expect(tokensInMetric).toBeDefined()
    })
  })

  describe('streaming path — input token count logged alongside TTFT (Req 6.5)', () => {
    it('logs inputTokens alongside ttftMs for latency-per-1K-tokens derivation', async () => {
      mockHappyPath()

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      bedrockSendSpy.mockResolvedValueOnce({
        stream: (async function* () {
          yield { contentBlockDelta: { delta: { text: 'Token response' } } }
          yield { metadata: { usage: { inputTokens: 500, outputTokens: 60 } } }
        })(),
      })

      const event = makeStreamingEvent('session-xyz', 'tenant-abc', '__session_start__')
      const responseStream = makeResponseStream()

      await handler(event, responseStream)

      // Find the TTFT log entry
      const ttftLogCall = consoleSpy.mock.calls.find(call => {
        try {
          const parsed = JSON.parse(call[0])
          return parsed.message === 'Chat: TTFT measured'
        } catch { return false }
      })

      expect(ttftLogCall).toBeDefined()
      const logEntry = JSON.parse(ttftLogCall[0])
      expect(logEntry.level).toBe('info')
      expect(logEntry.ttftMs).toBeDefined()
      expect(typeof logEntry.ttftMs).toBe('number')
      expect(logEntry.inputTokens).toBe(500)
      expect(logEntry.requestId).toBe('req-ttft-test')
      expect(logEntry.sessionId).toBe('session-xyz')
      expect(logEntry.tenantId).toBe('tenant-abc')
      expect(logEntry.turnNumber).toBeDefined()

      consoleSpy.mockRestore()
    })
  })

  describe('non-streaming path — no TTFT metric published (Req 6.4)', () => {
    it('does not publish TimeToFirstToken metric for non-streaming (Converse) path', async () => {
      mockHappyPath()

      // Non-streaming path uses ConverseCommand (not ConverseStreamCommand)
      bedrockSendSpy.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'Agent response' }] } },
        usage: { inputTokens: 100, outputTokens: 25 },
      })

      const event = makeNonStreamingEvent('session-xyz', 'tenant-abc', '__session_start__')
      const responseStream = makeResponseStream()

      // Call with responseStream (since handler is wrapped by streamifyResponse mock)
      // but event has no .http → isStreaming = false, uses Converse path
      await handler(event, responseStream)

      // CloudWatch should still be called (for standard metrics)
      expect(cloudwatchSendSpy).toHaveBeenCalled()
      const cwCall = cloudwatchSendSpy.mock.calls[0][0]
      const metricData = cwCall.input.MetricData

      // TimeToFirstToken should NOT be in the metrics
      const ttftMetric = metricData.find(m => m.MetricName === 'TimeToFirstToken')
      expect(ttftMetric).toBeUndefined()

      // Standard metrics should still be present
      const latencyMetric = metricData.find(m => m.MetricName === 'BedrockLatency')
      expect(latencyMetric).toBeDefined()
      const chatMessagesMetric = metricData.find(m => m.MetricName === 'ChatMessages')
      expect(chatMessagesMetric).toBeDefined()
    })
  })
})
