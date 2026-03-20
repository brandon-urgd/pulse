// Unit tests for urgd-pulse-getItemSessions
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(itemId = 'item-1') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-1' } },
    pathParameters: { itemId },
  }
}

const ITEM_RECORD = { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } }

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    itemId: { S: 'item-1' },
    pulseCode: { S: 'ABCD1234' },
    reviewerEmail: { S: 'reviewer@example.com' },
    status: { S: 'not_started' },
    createdAt: { S: '2026-01-01T00:00:00.000Z' },
    expiresAt: { S: '2099-01-01' },
    ...overrides,
  }
}

describe('urgd-pulse-getItemSessions', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 200 with session list', async () => {
    sendSpy
      .mockResolvedValueOnce({ Item: ITEM_RECORD })
      .mockResolvedValueOnce({ Items: [makeSession()] })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(1)
  })

  it('filters out cancelled sessions', async () => {
    sendSpy
      .mockResolvedValueOnce({ Item: ITEM_RECORD })
      .mockResolvedValueOnce({ Items: [
        makeSession({ status: { S: 'not_started' } }),
        makeSession({ sessionId: { S: 'session-2' }, status: { S: 'cancelled' } }),
      ]})

    const res = await handler(makeEvent())
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(1)
  })

  describe('public session child filtering (23.5)', () => {
    it('excludes child sessions from results', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: ITEM_RECORD })
        .mockResolvedValueOnce({ Items: [
          makeSession({ sessionId: { S: 'parent-1' }, isPublic: { BOOL: true }, pulseCode: { S: 'PUB00001' } }),
          makeSession({ sessionId: { S: 'child-1' }, parentSessionId: { S: 'parent-1' }, isPublic: { BOOL: true } }),
          makeSession({ sessionId: { S: 'child-2' }, parentSessionId: { S: 'parent-1' }, isPublic: { BOOL: true } }),
        ]})

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      // Only the parent should appear
      expect(body.data).toHaveLength(1)
      expect(body.data[0].sessionId).toBe('parent-1')
    })

    it('shows visitorCount on parent public session', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: ITEM_RECORD })
        .mockResolvedValueOnce({ Items: [
          makeSession({ sessionId: { S: 'parent-1' }, isPublic: { BOOL: true }, pulseCode: { S: 'PUB00001' } }),
          makeSession({ sessionId: { S: 'child-1' }, parentSessionId: { S: 'parent-1' }, isPublic: { BOOL: true } }),
          makeSession({ sessionId: { S: 'child-2' }, parentSessionId: { S: 'parent-1' }, isPublic: { BOOL: true } }),
        ]})

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data[0].visitorCount).toBe(2)
    })

    it('shows visitorCount of 0 for public session with no visitors yet', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: ITEM_RECORD })
        .mockResolvedValueOnce({ Items: [
          makeSession({ sessionId: { S: 'parent-1' }, isPublic: { BOOL: true }, pulseCode: { S: 'PUB00001' } }),
        ]})

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data[0].visitorCount).toBe(0)
    })
  })

  it('returns 404 when item not found', async () => {
    sendSpy.mockResolvedValueOnce({ Item: undefined })
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when tenantId missing', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-test', authorizer: {} },
      pathParameters: { itemId: 'item-1' },
    })
    expect(res.statusCode).toBe(401)
  })
})
