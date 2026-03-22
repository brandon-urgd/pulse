// Property test for graceful closing invariant (Task 36.7)
// Feature: pulse, Property: Graceful Closing Invariant
// For any session in closing state, the reviewer can send at most 2 more messages
// and the agent sends exactly 1 final reply before the session transitions to closed.
// For any session in closed state, no further messages are accepted.
// The session is never locked while the reviewer has an unanswered closing question pending.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()
const cloudwatchSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({ Body: (async function* () {})() }) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cloudwatchSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('ulid', () => ({ ulid: () => '01HTEST000000000000000000' }))

const { handler } = await import('./index.mjs')

function makeSession(closingState, graceRemaining) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    currentSection: { N: '3' },
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    startedAt: { S: new Date(Date.now() - 25 * 60 * 1000).toISOString() },
    closingState: { S: closingState },
    graceMessagesRemaining: { N: String(graceRemaining) },
  }
}

function setupMocks(session, agentText = 'Agent response.') {
  dynamoSendSpy.mockImplementation((cmd) => {
    const name = cmd?.constructor?.name
    if (name === 'GetItemCommand') {
      if (cmd.input.TableName.includes('sessions')) return Promise.resolve({ Item: session })
      return Promise.resolve({ Item: null })
    }
    if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
    if (name === 'UpdateItemCommand') return Promise.resolve({})
    if (name === 'TransactWriteItemsCommand') return Promise.resolve({})
    return Promise.resolve({})
  })
  bedrockSendSpy.mockResolvedValue({
    body: Buffer.from(JSON.stringify({
      content: [{ text: agentText }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  })
  lambdaSendSpy.mockResolvedValue({})
  cloudwatchSendSpy.mockResolvedValue({})
}

function makeEvent(message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-xyz', tenantId: 'tenant-abc', preview: 'false' },
    },
    body: JSON.stringify({ message }),
  }
}

describe('Graceful Closing Property (Task 36.7)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    bedrockSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cloudwatchSendSpy.mockReset()
  })

  it('Property: in closing state, grace window decrements correctly for any initial value 0-2', async () => {
    // numRuns: 100
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        async (graceRemaining, message) => {
          dynamoSendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cloudwatchSendSpy.mockReset()

          const session = makeSession('closing', graceRemaining)
          setupMocks(session)

          const res = await handler(makeEvent(message))
          expect(res.statusCode).toBe(200)
          const body = JSON.parse(res.body)

          if (graceRemaining <= 0) {
            // Grace exhausted — should transition to closed
            expect(body.data.closingState).toBe('closed')
          } else {
            // Grace remaining — stays in closing
            expect(body.data.closingState).toBe('closing')
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('Property: closed state always returns 410 for any message', async () => {
    // numRuns: 100
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (message) => {
          dynamoSendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cloudwatchSendSpy.mockReset()

          // Completed sessions return 410
          const session = makeSession('closed', 0)
          session.status = { S: 'completed' }
          setupMocks(session)

          const res = await handler(makeEvent(message))
          expect(res.statusCode).toBe(410)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('Property: closingState is always one of the four valid values', async () => {
    // numRuns: 100
    const validStates = ['exploring', 'narrowing', 'closing', 'closed']
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('exploring', 'narrowing'),
        fc.integer({ min: 0, max: 2 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        async (initialState, graceRemaining, message) => {
          dynamoSendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cloudwatchSendSpy.mockReset()

          const session = makeSession(initialState, graceRemaining)
          setupMocks(session)

          const res = await handler(makeEvent(message))
          if (res.statusCode === 200) {
            const body = JSON.parse(res.body)
            expect(validStates).toContain(body.data.closingState)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('Property: SESSION_COMPLETE tag always results in closed state regardless of initial closingState', async () => {
    // numRuns: 100
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('exploring', 'narrowing', 'closing'),
        fc.integer({ min: 0, max: 2 }),
        async (initialState, graceRemaining) => {
          dynamoSendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cloudwatchSendSpy.mockReset()

          const session = makeSession(initialState, graceRemaining)
          setupMocks(session, 'Thank you for your time. [SESSION_COMPLETE]')

          const res = await handler(makeEvent('Final message'))
          expect(res.statusCode).toBe(200)
          const body = JSON.parse(res.body)
          expect(body.data.closingState).toBe('closed')
          expect(body.data.sessionComplete).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})
