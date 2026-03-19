// Property test for urgd-pulse-chat
// Feature: pulse, Property 19: Transcript Write Invariant
// Validates: Requirements 5.x (transcript persistence)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

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

// Track ULID calls to verify sequential ordering
const ulidValues = []
let ulidCallCount = 0

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
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

vi.mock('ulid', () => ({
  ulid: () => {
    ulidCallCount++
    const val = `01HTEST${String(ulidCallCount).padStart(18, '0')}`
    ulidValues.push(val)
    return val
  }
}))

const { handler } = await import('./index.mjs')

function makeEvent(message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { sessionId: 'session-test', tenantId: 'tenant-test' },
    },
    body: JSON.stringify({ message }),
  }
}

function makeSession() {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    itemId: { S: 'item-test' },
    currentSection: { N: '1' },
    totalSections: { N: '5' },
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

describe('Property 19: Transcript Write Invariant', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    ulidValues.length = 0
    ulidCallCount = 0
    s3SendSpy.mockRejectedValue(new Error('NoSuchKey'))
    cwSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  it('for any valid non-special chat message, exactly 2 transcript records are written', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid non-special messages
        fc.string({ minLength: 1, maxLength: 200 })
          .filter(s => !['__session_start__', '__session_resume__', '__session_end__'].includes(s))
          .filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()
          ulidValues.length = 0
          ulidCallCount = 0

          // GetItem for session
          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          // PutItem for reviewer message (comes BEFORE query in handler)
          sendSpy.mockResolvedValueOnce({})
          // Query for transcript history
          sendSpy.mockResolvedValueOnce({ Items: [] })
          // PutItem for agent message
          sendSpy.mockResolvedValueOnce({})
          // UpdateItem for session
          sendSpy.mockResolvedValueOnce({})

          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

          const result = await handler(makeEvent(message))
          expect(result.statusCode).toBe(200)

          // Count PutItem calls (transcript writes)
          // sendSpy calls: GetItem(0), PutItem-reviewer(1), Query(2), PutItem-agent(3), UpdateItem(4)
          // Verify exactly 2 PutItem calls (reviewer + agent)
          expect(sendSpy).toHaveBeenCalledTimes(5)
          const reviewerPut = sendSpy.mock.calls[1][0]
          const agentPut = sendSpy.mock.calls[3][0]
          expect(reviewerPut.input.Item.role.S).toBe('reviewer')
          expect(agentPut.input.Item.role.S).toBe('agent')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for __session_start__ message, only 1 transcript record (agent) is written', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant('__session_start__'),
        async (message) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] })
          sendSpy.mockResolvedValueOnce({}) // PutItem agent
          sendSpy.mockResolvedValueOnce({}) // UpdateItem session

          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

          const result = await handler(makeEvent(message))
          expect(result.statusCode).toBe(200)

          // GetItem(0), Query(1), PutItem-agent(2), UpdateItem(3) = 4 calls total
          expect(sendSpy).toHaveBeenCalledTimes(4)
          const agentPut = sendSpy.mock.calls[2][0]
          expect(agentPut.input.Item.role.S).toBe('agent')
        }
      ),
      { numRuns: 100 }
    )
  })
})
