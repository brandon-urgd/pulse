// Unit tests for urgd-pulse-runPulseCheck (gate + dispatcher pattern)
// The handler validates sessions, writes 'generating' sentinel, fires processPulseCheck async.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulseChecks-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('PROCESS_FUNCTION_NAME', 'urgd-pulse-processPulseCheck-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  class PutItemCommand { constructor(input) { this.input = input; this._type = 'PutItem' } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  return { DynamoDBClient, QueryCommand, PutItemCommand, GetItemCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('./shared/features.mjs', () => ({
  resolveFeature: vi.fn(() => ({ allowed: true })),
}))

const { handler } = await import('./index.mjs')

function makeEvent(tenantId, itemId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId } },
    pathParameters: { itemId },
  }
}

const COMPLETED_SESSIONS = [
  { sessionId: { S: 'session-1' }, status: { S: 'completed' } },
  { sessionId: { S: 'session-2' }, status: { S: 'completed' } },
]

const EXPIRED_SESSIONS = [
  { sessionId: { S: 'session-1' }, status: { S: 'completed' } },
  { sessionId: { S: 'session-2' }, status: { S: 'expired' } },
]

// The handler flow:
// 1. (optional) Feature flag check: 2x GetItem on TENANTS_TABLE (tenant + SYSTEM)
// 2. Item status check: GetItem on ITEMS_TABLE
// 3. Sessions query: Query on SESSIONS_TABLE
// 4. Write 'generating' sentinel: PutItem on PULSE_CHECKS_TABLE
// 5. Fire processPulseCheck async: Lambda InvokeCommand

function mockStandardFlow(sessions, itemStatus = 'closed') {
  sendSpy.mockImplementation((cmd) => {
    if (cmd._type === 'GetItem') {
      // Feature flag check or item status check
      if (cmd.input.TableName === process.env.ITEMS_TABLE) {
        return Promise.resolve({
          Item: itemStatus ? { status: { S: itemStatus } } : undefined,
        })
      }
      // TENANTS_TABLE — feature flag check (tenant or SYSTEM record)
      return Promise.resolve({ Item: { tenantId: { S: 'tenant-1' }, tier: { S: 'free' } } })
    }
    if (cmd._type === 'Query') {
      return Promise.resolve({ Items: sessions })
    }
    if (cmd._type === 'PutItem') {
      return Promise.resolve({})
    }
    return Promise.resolve({})
  })
  lambdaSendSpy.mockResolvedValue({})
}

describe('urgd-pulse-runPulseCheck', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    lambdaSendSpy.mockReset()
  })

  describe('successful dispatch', () => {
    it('returns 202 and dispatches processPulseCheck for closed item with completed sessions', async () => {
      mockStandardFlow(COMPLETED_SESSIONS)
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(202)
      const body = JSON.parse(result.body)
      expect(body.status).toBe('generating')
      expect(lambdaSendSpy).toHaveBeenCalledOnce()
    })

    it('accepts expired sessions as valid (completed or expired)', async () => {
      mockStandardFlow(EXPIRED_SESSIONS)
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(202)
    })

    it('writes generating sentinel to pulse checks table', async () => {
      mockStandardFlow(COMPLETED_SESSIONS)
      await handler(makeEvent('tenant-1', 'item-1'))
      const putCall = sendSpy.mock.calls.find(([cmd]) => cmd._type === 'PutItem')
      expect(putCall).toBeDefined()
      expect(putCall[0].input.Item.status.S).toBe('generating')
      expect(putCall[0].input.Item.sessionCount.N).toBe('2')
    })
  })

  describe('409 when item not closed', () => {
    it('returns 409 if item is still active', async () => {
      mockStandardFlow(COMPLETED_SESSIONS, 'active')
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(409)
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('error cases', () => {
    it('returns 401 when tenantId is missing', async () => {
      const result = await handler({
        headers: {},
        requestContext: { authorizer: {} },
        pathParameters: { itemId: 'item-1' },
      })
      expect(result.statusCode).toBe(401)
    })

    it('returns 404 when item not found', async () => {
      mockStandardFlow([], null)
      sendSpy.mockImplementation((cmd) => {
        if (cmd._type === 'GetItem') {
          if (cmd.input.TableName === process.env.ITEMS_TABLE) {
            return Promise.resolve({ Item: undefined })
          }
          return Promise.resolve({ Item: { tenantId: { S: 'tenant-1' }, tier: { S: 'free' } } })
        }
        return Promise.resolve({ Items: [] })
      })
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(404)
    })

    it('returns 404 when no sessions found', async () => {
      mockStandardFlow([])
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(404)
    })

    it('returns 500 on unexpected DynamoDB error', async () => {
      sendSpy.mockRejectedValue(new Error('DynamoDB error'))
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(500)
    })
  })
})
