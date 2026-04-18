// Unit tests for deleteItem counter decrements
// Tests: deleteItem decrements monthlyItemsCreated, cascaded session decrements, counter failure resilience
// **Validates: Requirements 9.1, 9.2, 9.3, 9.4**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockDynamoSend = vi.fn()
const mockS3Send = vi.fn()
const mockDecrementCounter = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockDynamoSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  class DeleteItemCommand { constructor(input) { this.input = input; this._type = 'DeleteItem' } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(cmd) { return mockS3Send(cmd) } }
  class ListObjectsV2Command { constructor(input) { this.input = input; this._type = 'ListObjectsV2' } }
  class DeleteObjectsCommand { constructor(input) { this.input = input; this._type = 'DeleteObjects' } }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand }
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
  mockS3Send.mockReset()
  mockDecrementCounter.mockReset()
  mockDecrementCounter.mockResolvedValue({ success: true })

  process.env.ITEMS_TABLE = 'items'
  process.env.SESSIONS_TABLE = 'sessions'
  process.env.TRANSCRIPTS_TABLE = 'transcripts'
  process.env.REPORTS_TABLE = 'reports'
  process.env.PULSE_CHECKS_TABLE = 'pulse-checks'
  process.env.DATA_BUCKET_NAME = 'data-bucket'
  process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
})

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeEvent = (tenantId = 'tenant-1', itemId = 'item-1') => ({
  headers: { origin: 'https://app.example.com' },
  requestContext: { requestId: 'req-1', authorizer: { tenantId } },
  pathParameters: { itemId },
})

/** Build a raw DynamoDB session item */
const makeSession = (sessionId, status, isPublic = false) => ({
  tenantId: { S: 'tenant-1' },
  sessionId: { S: sessionId },
  itemId: { S: 'item-1' },
  status: { S: status },
  ...(isPublic ? { isPublic: { BOOL: true } } : {}),
})

/**
 * Set up mockDynamoSend to handle the full cascading delete flow.
 * @param {Array} sessions - Array of raw DynamoDB session items
 */
function setupDynamoMock(sessions = []) {
  mockDynamoSend.mockImplementation((cmd) => {
    // GetItem — return the item record
    if (cmd._type === 'GetItem') {
      return Promise.resolve({
        Item: {
          tenantId: { S: 'tenant-1' },
          itemId: { S: 'item-1' },
          name: { S: 'Test Item' },
          status: { S: 'active' },
        },
      })
    }
    // Query — return sessions for item-index, empty for transcripts/reports
    if (cmd._type === 'Query') {
      const tableName = cmd.input?.TableName
      if (tableName === 'sessions') {
        return Promise.resolve({ Items: sessions, LastEvaluatedKey: undefined })
      }
      if (tableName === 'transcripts') {
        return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
      }
      // reports table
      return Promise.resolve({ Items: [], LastEvaluatedKey: undefined })
    }
    // DeleteItem — always succeed
    if (cmd._type === 'DeleteItem') {
      return Promise.resolve({})
    }
    return Promise.resolve({})
  })

  // S3 — no objects to delete
  mockS3Send.mockImplementation(() =>
    Promise.resolve({ Contents: [], IsTruncated: false })
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('deleteItem counter decrements', () => {
  it('decrements monthlyItemsCreated by 1 after successful item deletion', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    setupDynamoMock([]) // no sessions

    await handler(makeEvent())

    // Should decrement monthlyItemsCreated exactly once
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyItemsCreated',
    })
  })

  it('decrements monthlySessionsTotal by the count of eligible (non-cancelled, non-discarded) sessions', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    const sessions = [
      makeSession('sess-1', 'not_started'),     // eligible
      makeSession('sess-2', 'in_progress'),      // eligible
      makeSession('sess-3', 'completed'),         // eligible
      makeSession('sess-4', 'cancelled'),         // excluded
      makeSession('sess-5', 'discarded'),         // excluded
      makeSession('sess-6', 'expired'),           // eligible
    ]

    setupDynamoMock(sessions)

    await handler(makeEvent())

    // 4 eligible sessions (not_started, in_progress, completed, expired)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlySessionsTotal',
      amount: 4,
    })
  })

  it('decrements monthlyPublicSessionsTotal by the count of eligible public sessions', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    const sessions = [
      makeSession('sess-1', 'not_started', true),   // eligible + public
      makeSession('sess-2', 'completed', true),       // eligible + public
      makeSession('sess-3', 'cancelled', true),       // excluded (cancelled)
      makeSession('sess-4', 'in_progress', false),    // eligible but not public
      makeSession('sess-5', 'discarded', true),       // excluded (discarded)
    ]

    setupDynamoMock(sessions)

    await handler(makeEvent())

    // 2 eligible public sessions (sess-1, sess-2)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyPublicSessionsTotal',
      amount: 2,
    })
  })

  it('does not call session decrements when all sessions are cancelled or discarded', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    const sessions = [
      makeSession('sess-1', 'cancelled'),
      makeSession('sess-2', 'discarded'),
    ]

    setupDynamoMock(sessions)

    await handler(makeEvent())

    // Should only decrement monthlyItemsCreated (no eligible sessions)
    expect(mockDecrementCounter).toHaveBeenCalledTimes(1)
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyItemsCreated',
    })
  })

  it('counter failure does not block the delete operation', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    const sessions = [
      makeSession('sess-1', 'not_started'),
    ]

    setupDynamoMock(sessions)

    // Make decrementCounter throw an error
    mockDecrementCounter.mockRejectedValue(new Error('DynamoDB timeout'))

    const result = await handler(makeEvent())

    // The delete should still succeed (200) despite counter failure
    expect(result.statusCode).toBe(200)
  })

  it('handles mixed session statuses with both public and private sessions correctly', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

    const sessions = [
      makeSession('sess-1', 'not_started', false),   // eligible, private
      makeSession('sess-2', 'in_progress', true),     // eligible, public
      makeSession('sess-3', 'completed', false),       // eligible, private
      makeSession('sess-4', 'expired', true),          // eligible, public
      makeSession('sess-5', 'cancelled', false),       // excluded
      makeSession('sess-6', 'cancelled', true),        // excluded
      makeSession('sess-7', 'discarded', false),       // excluded
    ]

    setupDynamoMock(sessions)

    await handler(makeEvent())

    // 3 calls: monthlyItemsCreated, monthlySessionsTotal (4), monthlyPublicSessionsTotal (2)
    expect(mockDecrementCounter).toHaveBeenCalledTimes(3)

    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyItemsCreated',
    })
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlySessionsTotal',
      amount: 4,
    })
    expect(mockDecrementCounter).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      counterName: 'monthlyPublicSessionsTotal',
      amount: 2,
    })
  })
})
