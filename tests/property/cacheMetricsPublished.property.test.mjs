// Property-based tests for Phased Cache Priming — Property 8: Cache metrics published when present
// Feature: phased-cache-priming, Property 8: cache metrics published when present
// **Validates: Requirements 8.1, 8.2**
//
// For any Bedrock response that includes non-zero cacheReadInputTokens or
// cacheWriteInputTokens, the Chat Lambda SHALL publish the corresponding
// CacheReadInputTokens or CacheWriteInputTokens CloudWatch metric. When both
// values are zero, neither metric SHALL be published.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Spies ──

const dynamoSpy = vi.fn()
const s3Spy = vi.fn()
const bedrockSpy = vi.fn()
const cwSpy = vi.fn()
const lambdaSpy = vi.fn()

// ── AWS SDK mocks ──

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input; this.name = 'TransactWriteItemsCommand' } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3Spy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  class PutObjectCommand { constructor(input) { this.input = input; this.name = 'PutObjectCommand' } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input; this.name = 'ConverseCommand' } }
  class ConverseStreamCommand { constructor(input) { this.input = input; this.name = 'ConverseStreamCommand' } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input; this.name = 'PutMetricDataCommand' } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Math.random().toString(36).slice(2, 8)),
}))

// ── Helpers ──

function makeS3Body(content) {
  return {
    Body: {
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(content) },
    },
  }
}

function makeConverseResponse(text, cacheRead, cacheWrite) {
  return {
    output: { message: { content: [{ text }] } },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
    },
  }
}

function makeSessionItem() {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    currentSection: { N: '1' },
    totalSections: { N: '3' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    startedAt: { S: new Date().toISOString() },
  }
}

function makeItemRecord() {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Review this.' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
    pageCount: { N: '0' },
  }
}

function makeChatEvent(message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-xyz', tenantId: 'tenant-abc' },
    },
    body: JSON.stringify({ message }),
  }
}

const { handler: chatHandler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

// ── Generators ──

// Cache token values: 0 means no cache activity, positive means cache hit/write
const cacheReadArb = fc.integer({ min: 0, max: 50000 })
const cacheWriteArb = fc.integer({ min: 0, max: 50000 })

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 8: Cache metrics published when present
// **Validates: Requirements 8.1, 8.2**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 8: cache metrics published when present', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
    cwSpy.mockReset()
    lambdaSpy.mockReset()
    cwSpy.mockResolvedValue({})
    lambdaSpy.mockResolvedValue({})
  })

  it('publishes CacheReadInputTokens when non-zero, CacheWriteInputTokens when non-zero, neither when both zero', async () => {
    // **Validates: Requirements 8.1, 8.2**
    await fc.assert(
      fc.asyncProperty(
        cacheReadArb,
        cacheWriteArb,
        async (cacheRead, cacheWrite) => {
          dynamoSpy.mockReset()
          s3Spy.mockReset()
          bedrockSpy.mockReset()
          cwSpy.mockReset()
          lambdaSpy.mockReset()
          cwSpy.mockResolvedValue({})
          lambdaSpy.mockResolvedValue({})

          // Simple turn 1 setup — __session_start__ with no prior transcript
          dynamoSpy
            .mockResolvedValueOnce({ Item: makeSessionItem() })       // GetItem session
            .mockResolvedValueOnce({ Items: [] })                      // Query transcript (empty = turn 1)
            .mockResolvedValueOnce({ Item: makeItemRecord() })         // GetItem item
            .mockResolvedValueOnce({})  // streamingLock
            .mockResolvedValueOnce({})  // TransactWrite
            .mockResolvedValueOnce({})  // session state update

          s3Spy.mockImplementation((cmd) => {
            const key = cmd.input?.Key || ''
            if (key.endsWith('extracted.md')) return Promise.resolve(makeS3Body('# Extracted text'))
            return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
          })

          // Return Bedrock response with the generated cache token values
          bedrockSpy.mockResolvedValueOnce(makeConverseResponse('Agent response', cacheRead, cacheWrite))

          const event = makeChatEvent('__session_start__')
          const result = await chatHandler(event)

          expect(result.statusCode).toBe(200)

          // Inspect the CloudWatch PutMetricData call
          expect(cwSpy).toHaveBeenCalled()
          const cwCall = cwSpy.mock.calls[0][0]
          const metricData = cwCall.input.MetricData
          expect(Array.isArray(metricData)).toBe(true)

          const metricNames = metricData.map(m => m.MetricName)

          // CacheReadInputTokens: published when non-zero, absent when zero
          if (cacheRead > 0) {
            expect(metricNames).toContain('CacheReadInputTokens')
            const readMetric = metricData.find(m => m.MetricName === 'CacheReadInputTokens')
            expect(readMetric.Value).toBe(cacheRead)
            expect(readMetric.Unit).toBe('Count')
          } else {
            expect(metricNames).not.toContain('CacheReadInputTokens')
          }

          // CacheWriteInputTokens: published when non-zero, absent when zero
          if (cacheWrite > 0) {
            expect(metricNames).toContain('CacheWriteInputTokens')
            const writeMetric = metricData.find(m => m.MetricName === 'CacheWriteInputTokens')
            expect(writeMetric.Value).toBe(cacheWrite)
            expect(writeMetric.Unit).toBe('Count')
          } else {
            expect(metricNames).not.toContain('CacheWriteInputTokens')
          }

          // Standard metrics are always present
          expect(metricNames).toContain('BedrockLatency')
          expect(metricNames).toContain('BedrockTokensIn')
          expect(metricNames).toContain('BedrockTokensOut')
          expect(metricNames).toContain('ChatMessages')
        },
      ),
      { numRuns: 100 },
    )
  })
})
