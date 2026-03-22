// Unit tests for discarded session recovery — Task 33
// Validates: discarded session validates successfully, status resets to "not_started",
// new transcript starts clean, expired sessions still return 410

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
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, PutItemCommand }
})

const { handler } = await import('./index.mjs')

const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
const PAST_DATE = new Date(Date.now() - 1000).toISOString()

const DISCARDED_SESSION = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-xyz' },
  itemId: { S: 'item-123' },
  reviewerEmail: { S: 'reviewer@example.com' },
  pulseCode: { S: 'ABCD1234' },
  status: { S: 'discarded' },
  expiresAt: { S: FUTURE_DATE },
  discardedAt: { S: '2026-01-01T00:00:00.000Z' },
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

describe('discarded session recovery (Task 33)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  describe('33.1 — validateSession accepts discarded sessions', () => {
    it('returns 200 (not 410) for a discarded session with matching email', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
    })

    it('re-issues a session token for a discarded session', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.sessionToken).toBeDefined()
      expect(body.sessionToken).toBe('tenant-abc:session-xyz')
    })

    it('session token format is correct for recovered discarded session', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))
      const body = JSON.parse(res.body)

      expect(body.sessionToken).toMatch(/^[^:]+:[^:]+$/)
      expect(body.sessionId).toBe('session-xyz')
      expect(body.tenantId).toBe('tenant-abc')
    })
  })

  describe('33.1 — status reset to "not_started" and discardedAt cleared', () => {
    it('calls UpdateItem to reset status to "not_started"', async () => {
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(updateCalls).toHaveLength(1)
      const updateInput = updateCalls[0].input
      // The value 'not_started' is in ExpressionAttributeValues, not the expression string
      const statusValue = Object.values(updateInput.ExpressionAttributeValues ?? {})
        .find(v => v?.S === 'not_started')
      expect(statusValue).toBeDefined()
    })

    it('UpdateItem expression removes discardedAt', async () => {
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(updateCalls).toHaveLength(1)
      const updateExpr = updateCalls[0].input.UpdateExpression
      expect(updateExpr).toContain('REMOVE')
      expect(updateExpr).toContain('discardedAt')
    })

    it('UpdateItem targets the correct session key', async () => {
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      const key = updateCalls[0].input.Key
      expect(key.tenantId.S).toBe('tenant-abc')
      expect(key.sessionId.S).toBe('session-xyz')
    })

    it('does NOT call UpdateItem for a normal not_started session', async () => {
      const normalSession = { ...DISCARDED_SESSION, status: { S: 'not_started' }, discardedAt: undefined }
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [normalSession] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(updateCalls).toHaveLength(0)
    })
  })

  describe('33.1 — email validation still applies after recovery', () => {
    it('returns 403 when email does not match a discarded session', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'wrong@example.com' }))

      // UpdateItem fires first (reset), then email check fails
      expect(res.statusCode).toBe(403)
    })
  })

  describe('33.1 — expired sessions still return 410 (not affected by this change)', () => {
    it('returns 410 for expired status — not treated as discarded', async () => {
      const expiredSession = { ...DISCARDED_SESSION, status: { S: 'expired' } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [expiredSession] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(410)
      expect(JSON.parse(res.body).message).toMatch(/expired/i)
    })

    it('returns 410 for past expiresAt date — not affected by discarded recovery', async () => {
      const expiredByDate = { ...DISCARDED_SESSION, status: { S: 'not_started' }, expiresAt: { S: PAST_DATE } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [expiredByDate] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      expect(res.statusCode).toBe(410)
    })

    it('discarded session with past expiresAt returns 410 (expired takes precedence)', async () => {
      const expiredDiscarded = { ...DISCARDED_SESSION, expiresAt: { S: PAST_DATE } }
      const updateCalls = []
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [expiredDiscarded] })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))

      // The discarded reset fires, but then the expired-by-date check catches it
      expect(res.statusCode).toBe(410)
    })
  })

  describe('33.2 — session-ui treats recovered session as brand new', () => {
    // Chat.tsx already handles this: when getSessionState returns status "not_started",
    // it auto-sends __session_start__. Since validateSession now resets discarded → not_started
    // before returning the token, the Chat component will always see "not_started" and fire
    // __session_start__ — no changes needed to session-ui.
    //
    // These tests verify the lambda side of the contract: the response looks identical
    // to a fresh session validation so session-ui has no way to distinguish it.

    it('response for recovered discarded session is identical in shape to a fresh session', async () => {
      // Fresh not_started session
      const freshSession = { ...DISCARDED_SESSION, status: { S: 'not_started' }, discardedAt: undefined }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [freshSession] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })
      const freshRes = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))
      const freshBody = JSON.parse(freshRes.body)

      dynamoSendSpy.mockReset()

      // Discarded session recovery
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })
      const recoveredRes = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))
      const recoveredBody = JSON.parse(recoveredRes.body)

      // Both return 200 with the same shape
      expect(freshRes.statusCode).toBe(200)
      expect(recoveredRes.statusCode).toBe(200)
      expect(Object.keys(freshBody).sort()).toEqual(Object.keys(recoveredBody).sort())
      expect(recoveredBody.sessionToken).toBe(freshBody.sessionToken)
      expect(recoveredBody.sessionId).toBe(freshBody.sessionId)
      expect(recoveredBody.tenantId).toBe(freshBody.tenantId)
    })

    it('response contains no indication of previous discard (no discardedAt field)', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'QueryCommand') return Promise.resolve({ Items: [DISCARDED_SESSION] })
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent({ pulseCode: 'ABCD1234', email: 'reviewer@example.com' }))
      const body = JSON.parse(res.body)

      expect(body.discardedAt).toBeUndefined()
      expect(body.previousStatus).toBeUndefined()
    })
  })
})
