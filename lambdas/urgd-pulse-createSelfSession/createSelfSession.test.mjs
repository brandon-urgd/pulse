// Unit tests for urgd-pulse-createSelfSession
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

const DRAFT_ITEM = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  status: { S: 'draft' },
  closeDate: { S: '2099-12-31' },
}

const ACTIVE_ITEM = {
  ...DRAFT_ITEM,
  status: { S: 'active' },
}

const CLOSED_ITEM = {
  ...DRAFT_ITEM,
  status: { S: 'closed' },
}

function makeEvent(tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: '{}',
  }
}

beforeEach(() => {
  dynamoSendSpy.mockReset()
})

describe('urgd-pulse-createSelfSession', () => {
  describe('success cases', () => {
    it('creates session with isSelfReview: true for a draft item', async () => {
      // GetItem (item) → QueryCommand (session count) → PutItem (session) → UpdateItem (item)
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: DRAFT_ITEM })   // GetItem item
        .mockResolvedValueOnce({ Count: 0 })            // QueryCommand session count
        .mockResolvedValueOnce({})                      // PutItem session
        .mockResolvedValueOnce({})                      // UpdateItem item

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(201)
      expect(body.data.sessionId).toBeTruthy()
      expect(body.data.sessionUrl).toContain('/s/')

      // Verify PutItem set isSelfReview: true
      const putCall = dynamoSendSpy.mock.calls.find(c => c[0].input?.Item?.isSelfReview)
      expect(putCall).toBeTruthy()
      expect(putCall[0].input.Item.isSelfReview).toEqual({ BOOL: true })
    })

    it('creates session with isSelfReview: true for an active item', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ACTIVE_ITEM })
        .mockResolvedValueOnce({ Count: 2 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(201)
      expect(body.data.sessionId).toBeTruthy()

      const putCall = dynamoSendSpy.mock.calls.find(c => c[0].input?.Item?.isSelfReview)
      expect(putCall[0].input.Item.isSelfReview).toEqual({ BOOL: true })
    })

    it('does not send email — no SES calls', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: DRAFT_ITEM })
        .mockResolvedValueOnce({ Count: 0 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      await handler(makeEvent())

      // All calls should be DynamoDB only — no SES client is imported
      // Verify by checking that no call has a Destination or ToAddresses field
      const hasSesCall = dynamoSendSpy.mock.calls.some(c =>
        c[0].input?.Destination || c[0].input?.ToAddresses
      )
      expect(hasSesCall).toBe(false)
    })

    it('counts toward session limit — session count is checked before creation', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ACTIVE_ITEM })
        .mockResolvedValueOnce({ Count: 4 })  // 4 existing, limit is 5 → allowed
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(201)
    })

    it('returns valid sessionUrl containing the sessionId', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: DRAFT_ITEM })
        .mockResolvedValueOnce({ Count: 0 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(body.data.sessionUrl).toContain(body.data.sessionId)
      expect(body.data.sessionUrl).toMatch(/^https:\/\/pulse\.urgdstudios\.com\/s\//)
    })

    it('activates draft item to active on first session', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: DRAFT_ITEM })
        .mockResolvedValueOnce({ Count: 0 })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})

      await handler(makeEvent())

      // Find the UpdateItem call and verify it sets status to active
      const updateCall = dynamoSendSpy.mock.calls.find(c =>
        c[0].input?.UpdateExpression?.includes(':active')
      )
      expect(updateCall).toBeTruthy()
      expect(updateCall[0].input.ExpressionAttributeValues[':active']).toEqual({ S: 'active' })
    })
  })

  describe('session limit enforcement', () => {
    it('returns 403 when at session limit', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ACTIVE_ITEM })
        .mockResolvedValueOnce({ Count: 5 })  // at limit

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body)
      expect(body.message).toContain('Session limit')
    })
  })

  describe('item status validation', () => {
    it('returns 409 for closed items', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: CLOSED_ITEM })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(409)
    })

    it('returns 409 for revised items', async () => {
      const revisedItem = { ...DRAFT_ITEM, status: { S: 'revised' } }
      dynamoSendSpy.mockResolvedValueOnce({ Item: revisedItem })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(409)
    })
  })

  describe('authorization', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
        body: '{}',
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(401)
    })

    it('returns 400 when itemId is missing', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: {},
        body: '{}',
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
    })

    it('returns 404 when item does not exist', async () => {
      dynamoSendSpy.mockResolvedValueOnce({ Item: null })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(404)
    })

    it('returns 404 when item belongs to a different tenant', async () => {
      const otherTenantItem = { ...DRAFT_ITEM, tenantId: { S: 'other-tenant' } }
      dynamoSendSpy.mockResolvedValueOnce({ Item: otherTenantItem })

      const result = await handler(makeEvent('tenant-abc'))
      expect(result.statusCode).toBe(404)
    })
  })

  describe('error handling', () => {
    it('returns 500 on unexpected DynamoDB error', async () => {
      dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB unavailable'))

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(500)
    })
  })
})
