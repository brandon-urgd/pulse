// Unit tests for urgd-pulse-extendDeadline
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand }
})

const { handler } = await import('./index.mjs')

const CURRENT_CLOSE = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
const FUTURE_CLOSE = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString()
const PAST_DATE = new Date(Date.now() - 1000).toISOString()

const ITEM_RECORD = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  status: { S: 'active' },
  closeDate: { S: CURRENT_CLOSE },
}

const SESSIONS = [
  { tenantId: { S: 'tenant-abc' }, sessionId: { S: 'sess-1' }, status: { S: 'not_started' } },
  { tenantId: { S: 'tenant-abc' }, sessionId: { S: 'sess-2' }, status: { S: 'in_progress' } },
  { tenantId: { S: 'tenant-abc' }, sessionId: { S: 'sess-3' }, status: { S: 'completed' } },
  { tenantId: { S: 'tenant-abc' }, sessionId: { S: 'sess-4' }, status: { S: 'expired' } },
]

function makeEvent(tenantId, itemId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-extendDeadline', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  describe('successful extension', () => {
    it('returns 200 when new closeDate is valid and after current closeDate', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') return Promise.resolve({ Attributes: { ...ITEM_RECORD, closeDate: { S: FUTURE_CLOSE } } })
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { closeDate: FUTURE_CLOSE }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data).toBeDefined()
    })

    it('updates item closeDate and updatedAt', async () => {
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({ Attributes: { ...ITEM_RECORD, closeDate: { S: FUTURE_CLOSE } } })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        return Promise.resolve({})
      })

      await handler(makeEvent('tenant-abc', 'item-123', { closeDate: FUTURE_CLOSE }))

      const itemUpdate = updateCalls.find(c => c.TableName === 'urgd-pulse-items-dev')
      expect(itemUpdate).toBeDefined()
      expect(itemUpdate.ExpressionAttributeValues[':closeDate'].S).toBe(FUTURE_CLOSE)
      expect(itemUpdate.ExpressionAttributeValues[':updatedAt']).toBeDefined()
    })

    it('updates expiresAt on all non-completed/non-expired sessions', async () => {
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({ Attributes: ITEM_RECORD })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Items: SESSIONS })
        return Promise.resolve({})
      })

      await handler(makeEvent('tenant-abc', 'item-123', { closeDate: FUTURE_CLOSE }))

      const sessionUpdates = updateCalls.filter(c => c.TableName === 'urgd-pulse-sessions-dev')
      // sess-1 (not_started) and sess-2 (in_progress) should be updated
      expect(sessionUpdates).toHaveLength(2)
      const updatedSessionIds = sessionUpdates.map(c => c.Key.sessionId.S)
      expect(updatedSessionIds).toContain('sess-1')
      expect(updatedSessionIds).toContain('sess-2')
    })

    it('does NOT update expiresAt on "completed" or "expired" sessions', async () => {
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({ Attributes: ITEM_RECORD })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Items: SESSIONS })
        return Promise.resolve({})
      })

      await handler(makeEvent('tenant-abc', 'item-123', { closeDate: FUTURE_CLOSE }))

      const sessionUpdates = updateCalls.filter(c => c.TableName === 'urgd-pulse-sessions-dev')
      const updatedSessionIds = sessionUpdates.map(c => c.Key.sessionId.S)
      expect(updatedSessionIds).not.toContain('sess-3') // completed
      expect(updatedSessionIds).not.toContain('sess-4') // expired
    })
  })

  describe('date validation', () => {
    it('returns 400 when date is in the past', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { closeDate: PAST_DATE }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/future/i)
    })

    it('returns 400 when date is before current closeDate', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        return Promise.resolve({})
      })

      // A date in the future but before CURRENT_CLOSE (3 days from now)
      const beforeCurrentClose = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString()
      const res = await handler(makeEvent('tenant-abc', 'item-123', { closeDate: beforeCurrentClose }))

      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/after the current close date/i)
    })

    it('returns 400 for invalid date string', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { closeDate: 'not-a-date' }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/valid ISO date/i)
    })

    it('returns 400 when closeDate is missing', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', {}))
      expect(res.statusCode).toBe(400)
    })
  })

  describe('item lookup', () => {
    it('returns 404 when item not found', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: undefined })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-999', { closeDate: FUTURE_CLOSE }))

      expect(res.statusCode).toBe(404)
    })
  })

  describe('auth', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
        body: JSON.stringify({ closeDate: FUTURE_CLOSE }),
      })
      expect(res.statusCode).toBe(401)
    })
  })
})
