// Unit tests for session counter decrements
// Tests: cancelSession, expireSessions, expirePublicSession call decrementCounter correctly
// **Validates: Requirements 8.1, 8.2, 8.3, 8.5**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockDynamoSend = vi.fn()
const mockLambdaSend = vi.fn()
const mockDecrementCounter = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockDynamoSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this._type = 'UpdateItem' } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  class ScanCommand { constructor(input) { this.input = input; this._type = 'Scan' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand, ScanCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(cmd) { return mockLambdaSend(cmd) } }
  class InvokeCommand { constructor(input) { this.input = input; this._type = 'Invoke' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: vi.fn((status, body, headers, origin) => ({
    statusCode: status,
    body: JSON.stringify(body),
    headers: { 'Access-Control-Allow-Origin': origin, ...headers },
  })),
  errorResponse: vi.fn((status, message, headers, origin) => ({
    statusCode: status,
    body: JSON.stringify({ error: message }),
    headers: { 'Access-Control-Allow-Origin': origin, ...headers },
  })),
}))

vi.mock('./shared/counters.mjs', () => ({
  decrementCounter: (...args) => mockDecrementCounter(...args),
}))

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockLambdaSend.mockReset()
  mockDecrementCounter.mockReset()
  mockDecrementCounter.mockResolvedValue({ success: true })

  process.env.SESSIONS_TABLE = 'sessions'
  process.env.ITEMS_TABLE = 'items'
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
  process.env.TRANSCRIPTS_TABLE = 'transcripts'
})

// ── cancelSession ────────────────────────────────────────────────────────────

describe('cancelSession counter decrements', () => {
  const makeEvent = (tenantId = 'tenant-1', itemId = 'item-1', sessionId = 'sess-1') => ({
    headers: { origin: 'https://app.example.com' },
    requestContext: { requestId: 'req-1', authorizer: { tenantId } },
    pathParameters: { itemId, sessionId },
  })

  it('calls decrementCounter("monthlySessionsTotal") after successful cancel', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-cancelSession/index.mjs')

    // GetItem returns a not_started session
    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            tenantId: { S: 'tenant-1' },
            sessionId: { S: 'sess-1' },
            itemId: { S: 'item-1' },
            status: { S: 'not_started' },
          },
        })
      }
      // UpdateItem (cancel + sessionCount decrement)
      return Promise.resolve({})
    })

    await handler(makeEvent())

    expect(mockDecrementCounter).toHaveBeenCalledTimes(1)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlySessionsTotal',
    })
  })

  it('decrement failure (returns { success: false }) does not block the cancel operation', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-cancelSession/index.mjs')

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetItem') {
        return Promise.resolve({
          Item: {
            tenantId: { S: 'tenant-1' },
            sessionId: { S: 'sess-1' },
            itemId: { S: 'item-1' },
            status: { S: 'not_started' },
          },
        })
      }
      return Promise.resolve({})
    })

    // decrementCounter returns failure (but never throws — it handles errors internally)
    mockDecrementCounter.mockResolvedValue({ success: false })

    const result = await handler(makeEvent())

    // The cancel should still succeed (200) despite decrement returning failure
    expect(result.statusCode).toBe(200)
  })
})

// ── expireSessions ───────────────────────────────────────────────────────────

describe('expireSessions counter decrements', () => {
  it('calls decrementCounter once per expired session', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-expireSessions/index.mjs')

    const now = new Date().toISOString()
    const pastDate = new Date(Date.now() - 86400000).toISOString() // 1 day ago

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'Scan') {
        return Promise.resolve({
          Items: [
            {
              tenantId: { S: 'tenant-1' },
              sessionId: { S: 'sess-1' },
              itemId: { S: 'item-1' },
              status: { S: 'not_started' },
              expiresAt: { S: pastDate },
            },
            {
              tenantId: { S: 'tenant-1' },
              sessionId: { S: 'sess-2' },
              itemId: { S: 'item-1' },
              status: { S: 'in_progress' },
              expiresAt: { S: pastDate },
            },
          ],
          LastEvaluatedKey: undefined,
        })
      }
      if (cmd._type === 'UpdateItem') {
        return Promise.resolve({})
      }
      if (cmd._type === 'Query') {
        // Transcript query for in_progress sessions — return few messages to skip report
        return Promise.resolve({ Items: [] })
      }
      return Promise.resolve({})
    })

    await handler({ source: 'test' })

    // Should call decrementCounter once per expired session (2 sessions)
    expect(mockDecrementCounter).toHaveBeenCalledTimes(2)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlySessionsTotal',
    })
  })

  it('decrement failure (returns { success: false }) does not block the expire operation', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-expireSessions/index.mjs')

    const pastDate = new Date(Date.now() - 86400000).toISOString()

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'Scan') {
        return Promise.resolve({
          Items: [
            {
              tenantId: { S: 'tenant-1' },
              sessionId: { S: 'sess-1' },
              itemId: { S: 'item-1' },
              status: { S: 'not_started' },
              expiresAt: { S: pastDate },
            },
          ],
          LastEvaluatedKey: undefined,
        })
      }
      if (cmd._type === 'UpdateItem') {
        return Promise.resolve({})
      }
      return Promise.resolve({})
    })

    // decrementCounter returns failure (but never throws — it handles errors internally)
    mockDecrementCounter.mockResolvedValue({ success: false })

    const result = await handler({ source: 'test' })

    // The expire job should still complete and report the expired session
    expect(result.totalExpired).toBe(1)
  })
})

// ── expirePublicSession ──────────────────────────────────────────────────────

describe('expirePublicSession counter decrements', () => {
  const makeEvent = (tenantId = 'tenant-1', itemId = 'item-1', sessionId = 'sess-pub-1') => ({
    headers: { origin: 'https://app.example.com' },
    requestContext: { requestId: 'req-1', authorizer: { tenantId } },
    pathParameters: { itemId, sessionId },
  })

  it('calls decrementCounter("monthlyPublicSessionsTotal") after successful expire', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-expirePublicSession/index.mjs')

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'Query') {
        // sessionId-index GSI lookup
        return Promise.resolve({
          Items: [{
            tenantId: { S: 'tenant-1' },
            sessionId: { S: 'sess-pub-1' },
            itemId: { S: 'item-1' },
            isPublic: { BOOL: true },
            status: { S: 'not_started' },
          }],
        })
      }
      if (cmd._type === 'UpdateItem') {
        return Promise.resolve({})
      }
      return Promise.resolve({})
    })

    await handler(makeEvent())

    expect(mockDecrementCounter).toHaveBeenCalledTimes(1)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyPublicSessionsTotal',
    })
  })

  it('decrement failure (returns { success: false }) does not block the expire operation', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-expirePublicSession/index.mjs')

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'Query') {
        return Promise.resolve({
          Items: [{
            tenantId: { S: 'tenant-1' },
            sessionId: { S: 'sess-pub-1' },
            itemId: { S: 'item-1' },
            isPublic: { BOOL: true },
            status: { S: 'in_progress' },
          }],
        })
      }
      if (cmd._type === 'UpdateItem') {
        return Promise.resolve({})
      }
      return Promise.resolve({})
    })

    // decrementCounter returns failure (but never throws — it handles errors internally)
    mockDecrementCounter.mockResolvedValue({ success: false })

    const result = await handler(makeEvent())

    // The expire should still succeed (200) despite decrement returning failure
    expect(result.statusCode).toBe(200)
  })
})
