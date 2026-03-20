// Property test for urgd-pulse-chat
// Feature: pulse, Property 19: Transcript Write Invariant
// Validates: Requirements 6.1 (transcript persistence, atomic write)

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

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
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

vi.mock('ulid', () => {
  let count = 0
  return {
    ulid: () => `01HTEST${String(++count).padStart(18, '0')}`,
  }
})

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

function makeBedrockResponse(text) {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text: text || 'Agent response' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  }
}

// Standard mock setup for a normal chat exchange
// Call order: GetItem(session), Query(history), GetItem(item), TransactWrite, UpdateItem
function setupNormalMocks() {
  sendSpy
    .mockResolvedValueOnce({ Item: makeSession() })
    .mockResolvedValueOnce({ Items: [] })
    .mockResolvedValueOnce({ Item: { itemName: { S: 'Test Item' }, description: { S: '' } } })
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
  bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())
}

describe('Property 19: Transcript Write Invariant', () => {
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

  it('for any valid non-special chat message, exactly 2 transcript records are written atomically via TransactWriteItems', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 })
          .filter(s => !['__session_start__', '__session_resume__', '__session_end__'].includes(s))
          .filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()
          setupNormalMocks()

          const result = await handler(makeEvent(message))
          expect(result.statusCode).toBe(200)

          // Verify TransactWriteItemsCommand was called with 2 items (reviewer + agent)
          const transactCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'TransactWriteItemsCommand')
          expect(transactCall).toBeDefined()
          const transactItems = transactCall[0].input.TransactItems
          expect(transactItems).toHaveLength(2)
          expect(transactItems[0].Put.Item.role.S).toBe('reviewer')
          expect(transactItems[1].Put.Item.role.S).toBe('agent')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for __session_start__ message, both reviewer and agent records are written with correct content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant('__session_start__'),
        async (message) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()
          setupNormalMocks()

          const result = await handler(makeEvent(message))
          expect(result.statusCode).toBe(200)

          // TransactWriteItems is called with 2 items — reviewer content is [__session_start__]
          const transactCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'TransactWriteItemsCommand')
          expect(transactCall).toBeDefined()
          const transactItems = transactCall[0].input.TransactItems
          expect(transactItems).toHaveLength(2)
          expect(transactItems[0].Put.Item.role.S).toBe('reviewer')
          expect(transactItems[0].Put.Item.content.S).toBe('[__session_start__]')
          expect(transactItems[1].Put.Item.role.S).toBe('agent')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('ULID ordering: reviewer messageId is lexicographically before agent messageId', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 })
          .filter(s => !['__session_start__', '__session_resume__', '__session_end__'].includes(s))
          .filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()
          setupNormalMocks()

          await handler(makeEvent(message))

          const transactCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'TransactWriteItemsCommand')
          const transactItems = transactCall[0].input.TransactItems
          const reviewerMsgId = transactItems[0].Put.Item.messageId.S
          const agentMsgId = transactItems[1].Put.Item.messageId.S

          // ULIDs are lexicographically sortable — reviewer comes before agent
          expect(reviewerMsgId < agentMsgId).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})
