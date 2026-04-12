// Property test for urgd-pulse-chat
// Feature: pulse, Property 18: Confidentiality Gate Invariant
// Validates: Requirements 5.x (session chat access control)

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
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
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

vi.mock('ulid', () => ({ ulid: () => '01HTEST000000000000000000' }))

const { handler } = await import('./index.mjs')

function makeEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { sessionId, tenantId },
    },
    body: JSON.stringify({ message }),
  }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: 'not_started' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    itemId: { S: 'item-test' },
    currentSection: { N: '1' },
    totalSections: { N: '5' },
    ...overrides,
  }
}

describe('Property 18: Confidentiality Gate Invariant', () => {
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

  it('for any session without confidentialityAcceptedAt, chat returns 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          // Session without confidentialityAcceptedAt
          sendSpy.mockResolvedValueOnce({
            Item: makeSession({ confidentialityAcceptedAt: undefined }),
          })

          const result = await handler(makeEvent('session-test', 'tenant-test', message))
          expect(result.statusCode).toBe(403)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any session with status expired, chat returns 410', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          sendSpy.mockResolvedValueOnce({
            Item: makeSession({ status: { S: 'expired' } }),
          })

          const result = await handler(makeEvent('session-test', 'tenant-test', message))
          expect(result.statusCode).toBe(410)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any session with status completed, chat returns 410', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (message) => {
          sendSpy.mockReset()
          sendSpy.mockResolvedValueOnce({
            Item: makeSession({ status: { S: 'completed' } }),
          })

          const result = await handler(makeEvent('session-test', 'tenant-test', message))
          expect(result.statusCode).toBe(410)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('confidentiality check (403) takes precedence over status check (410)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('expired', 'completed'),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (badStatus, message) => {
          sendSpy.mockReset()
          // No confidentiality AND bad status — should get 403 (confidentiality checked first)
          sendSpy.mockResolvedValueOnce({
            Item: makeSession({
              confidentialityAcceptedAt: undefined,
              status: { S: badStatus },
            }),
          })

          const result = await handler(makeEvent('session-test', 'tenant-test', message))
          expect(result.statusCode).toBe(403)
        }
      ),
      { numRuns: 100 }
    )
  })
})
