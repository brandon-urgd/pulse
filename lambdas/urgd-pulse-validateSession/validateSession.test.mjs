// Unit tests for urgd-pulse-validateSession
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

const { handler } = await import('./index.mjs')

const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const PAST_DATE = new Date(Date.now() - 1000).toISOString()

const SESSION_RECORD = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-xyz' },
  itemId: { S: 'item-123' },
  reviewerEmail: { S: 'reviewer@example.com' },
  pulseCode: { S: 'ABCD1234' },
  status: { S: 'not_started' },
  expiresAt: { S: FUTURE_DATE },
}

const ITEM_RECORD = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  description: { S: 'A great item to review' },
}

function makeEvent(body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test' },
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-validateSession', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  describe('successful validation', () => {
    it('returns 200 with session token when email matches (via pulseCode)', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.sessionToken).toBeDefined()
      expect(body.sessionId).toBe('session-xyz')
      expect(body.tenantId).toBe('tenant-abc')
    })

    it('returns 200 with session token when email matches (via sessionId)', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ sessionId: 'session-xyz', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.sessionToken).toBeDefined()
    })

    it('session token format is "{tenantId}:{sessionId}"', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.sessionToken).toBe('tenant-abc:session-xyz')
    })

    it('loads item context (itemName, description) in response', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.item.itemName).toBe('My Review Item')
      expect(body.item.description).toBe('A great item to review')
      expect(body.item.itemId).toBe('item-123')
    })

    it('email match is case-insensitive', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'REVIEWER@EXAMPLE.COM' }))

      expect(res.statusCode).toBe(200)
    })
  })

  describe('email mismatch', () => {
    it('returns 403 when email does not match session', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'wrong@example.com' }))

      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).message).toMatch(/email/i)
    })
  })

  describe('expired sessions', () => {
    it('returns 410 when session status is "expired"', async () => {
      const expiredSession = { ...SESSION_RECORD, status: { S: 'expired' } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [expiredSession] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(410)
      expect(JSON.parse(res.body).message).toMatch(/expired/i)
    })

    it('returns 410 when expiresAt is in the past', async () => {
      const expiredSession = { ...SESSION_RECORD, status: { S: 'not_started' }, expiresAt: { S: PAST_DATE } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [expiredSession] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(410)
    })
  })

  describe('session not found', () => {
    it('returns 404 when session not found', async () => {
      dynamoSendSpy.mockResolvedValue({ Items: [] })

      const res = await handler(makeEvent({ pulseCode: 'NOTFOUND', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(404)
    })
  })

  describe('GSI lookups', () => {
    it('pulseCode lookup uses pulseCode-index GSI', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      const queryCalls = dynamoSendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'QueryCommand')
      expect(queryCalls.length).toBeGreaterThanOrEqual(1)
      const pulseCodeQuery = queryCalls.find(c => c[0].input?.IndexName === 'pulseCode-index')
      expect(pulseCodeQuery).toBeDefined()
      expect(pulseCodeQuery[0].input.ExpressionAttributeValues[':pc'].S).toBe('ABCD1234')
    })

    it('sessionId lookup uses sessionId-index GSI', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [SESSION_RECORD] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      await handler(makeEvent({ sessionId: 'session-xyz', email: 'reviewer@example.com' }))

      const queryCalls = dynamoSendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'QueryCommand')
      const sessionIdQuery = queryCalls.find(c => c[0].input?.IndexName === 'sessionId-index')
      expect(sessionIdQuery).toBeDefined()
      expect(sessionIdQuery[0].input.ExpressionAttributeValues[':sid'].S).toBe('session-xyz')
    })
  })

  describe('input validation', () => {
    it('returns 400 when email is missing', async () => {
      const res = await handler(makeEvent({ pulseCode: 'ABCD1234' }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/email/i)
    })

    it('returns 400 when both sessionId and pulseCode are missing', async () => {
      const res = await handler(makeEvent({ email: 'reviewer@example.com' }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/sessionId or pulseCode/i)
    })
  })
})
