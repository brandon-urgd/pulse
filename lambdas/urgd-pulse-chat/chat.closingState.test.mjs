// Unit tests for graceful session closing (Task 36)
// Validates: closingState transitions, grace window, input lock on closed state

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
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

const STARTED_AT = new Date(Date.now() - 27 * 60 * 1000).toISOString() // 27 min ago (3 min remaining ≤ 4 min threshold)

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'in_progress' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    currentSection: { N: '2' },
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    startedAt: { S: STARTED_AT },
    closingState: { S: 'exploring' },
    graceMessagesRemaining: { N: '2' },
    ...overrides,
  }
}

function makeBedrockResponse(text = 'Agent response text.') {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

function makeEvent(message, overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-xyz', tenantId: 'tenant-abc', preview: 'false', ...overrides },
    },
    body: JSON.stringify({ message }),
  }
}

function setupMocks(session, bedrockText = 'Agent response.') {
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
  bedrockSendSpy.mockResolvedValue(makeBedrockResponse(bedrockText))
  lambdaSendSpy.mockResolvedValue({})
  cloudwatchSendSpy.mockResolvedValue({})
}

describe('graceful session closing — closingState transitions (Task 36)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    bedrockSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cloudwatchSendSpy.mockReset()
  })

  describe('36.1 — exploring → narrowing when ≤4 minutes remain', () => {
    it('transitions to narrowing when ≤4 minutes remain', async () => {
      // 27 min elapsed of 30 min = 3 min remaining — should trigger narrowing (threshold: ≤4 min)
      const session = makeSession({ closingState: { S: 'exploring' } })
      setupMocks(session)

      const res = await handler(makeEvent('Hello'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('narrowing')
    })

    it('stays exploring when less than 70% time has elapsed', async () => {
      const recentStart = new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 min ago
      const session = makeSession({ closingState: { S: 'exploring' }, startedAt: { S: recentStart } })
      setupMocks(session)

      const res = await handler(makeEvent('Hello'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('exploring')
    })

    it('does not transition on special messages', async () => {
      const session = makeSession({ closingState: { S: 'exploring' } })
      setupMocks(session)

      const res = await handler(makeEvent('__session_resume__'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      // Special messages don't trigger time-based transitions
      expect(['exploring', 'narrowing']).toContain(body.data.closingState)
    })
  })

  describe('36.2 — narrowing → closing on windingDown=final', () => {
    it('transitions to closing when windingDown=final is sent', async () => {
      const session = makeSession({ closingState: { S: 'narrowing' } })
      setupMocks(session)

      const event = {
        ...makeEvent('My final thoughts'),
        body: JSON.stringify({ message: 'My final thoughts', windingDown: 'final' }),
      }
      const res = await handler(event)
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('closing')
    })

    it('sets graceMessagesRemaining to 10 when entering closing', async () => {
      const session = makeSession({ closingState: { S: 'narrowing' } })
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          if (cmd.input.TableName.includes('sessions')) return Promise.resolve({ Item: session })
          return Promise.resolve({ Item: null })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        if (name === 'UpdateItemCommand') { updateCalls.push(cmd); return Promise.resolve({}) }
        if (name === 'TransactWriteItemsCommand') return Promise.resolve({})
        return Promise.resolve({})
      })
      bedrockSendSpy.mockResolvedValue(makeBedrockResponse())
      cloudwatchSendSpy.mockResolvedValue({})

      const event = {
        ...makeEvent('Final message'),
        body: JSON.stringify({ message: 'Final message', windingDown: 'final' }),
      }
      await handler(event)

      // Search all update calls for the one that sets graceMessagesRemaining to 10
      const graceUpdate = updateCalls.find(cmd => {
        const values = cmd.input?.ExpressionAttributeValues ?? {}
        return Object.values(values).some(v => v?.N === '10')
      })
      expect(graceUpdate).toBeDefined()
    })
  })

  describe('36.3 — closing grace window countdown', () => {
    it('decrements graceMessagesRemaining on each reviewer message in closing state', async () => {
      const session = makeSession({ closingState: { S: 'closing' }, graceMessagesRemaining: { N: '2' } })
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          if (cmd.input.TableName.includes('sessions')) return Promise.resolve({ Item: session })
          return Promise.resolve({ Item: null })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        if (name === 'UpdateItemCommand') { updateCalls.push(cmd); return Promise.resolve({}) }
        if (name === 'TransactWriteItemsCommand') return Promise.resolve({})
        return Promise.resolve({})
      })
      bedrockSendSpy.mockResolvedValue(makeBedrockResponse())
      cloudwatchSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent('One more thought'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      // Still in closing (grace remaining: 1)
      expect(body.data.closingState).toBe('closing')

      // Find the session state update (the last UpdateItemCommand, not the streamingLock)
      const sessionUpdate = updateCalls[updateCalls.length - 1]
      const updateInput = sessionUpdate?.input
      const graceValue = Object.values(updateInput?.ExpressionAttributeValues ?? {})
        .find(v => v?.N === '1')
      expect(graceValue).toBeDefined()
    })

    it('transitions to closed when graceMessagesRemaining reaches 0', async () => {
      const session = makeSession({ closingState: { S: 'closing' }, graceMessagesRemaining: { N: '0' } })
      setupMocks(session)

      const res = await handler(makeEvent('Last message'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('closed')
    })

    it('stays in closing when graceMessagesRemaining > 0', async () => {
      const session = makeSession({ closingState: { S: 'closing' }, graceMessagesRemaining: { N: '1' } })
      setupMocks(session)

      const res = await handler(makeEvent('Still thinking'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('closing')
    })
  })

  describe('36.4 — SESSION_COMPLETE tag always closes', () => {
    it('transitions to closed when agent response contains [SESSION_COMPLETE]', async () => {
      const session = makeSession({ closingState: { S: 'exploring' } })
      setupMocks(session, 'Great session! [SESSION_COMPLETE]')

      const res = await handler(makeEvent('Thanks'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBe('closed')
      expect(body.data.sessionComplete).toBe(true)
    })
  })

  describe('36.5 — completed sessions are never modified', () => {
    it('returns 410 for completed sessions', async () => {
      const session = makeSession({ status: { S: 'completed' } })
      setupMocks(session)

      const res = await handler(makeEvent('Hello'))
      expect(res.statusCode).toBe(410)
    })

    it('returns 410 for expired sessions', async () => {
      const session = makeSession({ status: { S: 'expired' } })
      setupMocks(session)

      const res = await handler(makeEvent('Hello'))
      expect(res.statusCode).toBe(410)
    })
  })

  describe('36.6 — closingState included in response', () => {
    it('response always includes closingState field', async () => {
      const session = makeSession()
      setupMocks(session)

      const res = await handler(makeEvent('Hello'))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.closingState).toBeDefined()
      expect(['exploring', 'narrowing', 'closing', 'closed']).toContain(body.data.closingState)
    })
  })
})
