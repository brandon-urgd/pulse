// Unit tests for urgd-pulse-previewSession
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
  return { DynamoDBClient, GetItemCommand, PutItemCommand }
})

const { handler } = await import('./index.mjs')

const ITEM = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  status: { S: 'draft' },
}

function makeEvent(tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
  }
}

beforeEach(() => {
  dynamoSendSpy.mockReset()
})

describe('urgd-pulse-previewSession', () => {
  describe('success cases', () => {
    it('creates a preview session with preview: true flag and 15-min TTL', async () => {
      // GetItem (item lookup) → PutItem (session create)
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(200)
      expect(body.data.previewUrl).toMatch(/\/s\/\?code=.+&preview=true$/)
      expect(body.data.sessionId).toBeTruthy()
      expect(body.data.pulseCode).toBeTruthy()
      expect(body.data.expiresAt).toBeTruthy()

      // Verify the PutItem call set preview: true
      const putCall = dynamoSendSpy.mock.calls[1][0]
      expect(putCall.input.Item.preview).toEqual({ BOOL: true })
    })

    it('sets TTL to approximately 15 minutes from now', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})

      const before = Math.floor(Date.now() / 1000)
      const result = await handler(makeEvent())
      const after = Math.floor(Date.now() / 1000)

      const putCall = dynamoSendSpy.mock.calls[1][0]
      const ttl = Number(putCall.input.Item.ttl.N)
      const expectedMin = before + 15 * 60
      const expectedMax = after + 15 * 60

      expect(ttl).toBeGreaterThanOrEqual(expectedMin)
      expect(ttl).toBeLessThanOrEqual(expectedMax)
    })

    it('calling twice for the same item creates two separate preview tokens (not idempotent)', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})

      const result1 = await handler(makeEvent())
      const result2 = await handler(makeEvent())

      const body1 = JSON.parse(result1.body)
      const body2 = JSON.parse(result2.body)

      expect(result1.statusCode).toBe(200)
      expect(result2.statusCode).toBe(200)
      // Different sessionIds
      expect(body1.data.sessionId).not.toBe(body2.data.sessionId)
      // Different pulseCodes
      expect(body1.data.pulseCode).not.toBe(body2.data.pulseCode)
    })

    it('preview session is NOT counted in item session count (no UpdateItem on items table)', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})

      await handler(makeEvent())

      // Only 2 DynamoDB calls: GetItem (item) + PutItem (session)
      // No UpdateItem on items table to increment sessionCount
      expect(dynamoSendSpy).toHaveBeenCalledTimes(2)
      const callInputs = dynamoSendSpy.mock.calls.map(c => c[0].input)
      const hasUpdateItem = callInputs.some(i => i.UpdateExpression !== undefined)
      expect(hasUpdateItem).toBe(false)
    })

    it('returns previewUrl with correct format', async () => {
      dynamoSendSpy
        .mockResolvedValueOnce({ Item: ITEM })
        .mockResolvedValueOnce({})

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      // previewUrl must be /s/?code={pulseCode}&preview=true
      const url = new URL(body.data.previewUrl, 'https://pulse.urgdstudios.com')
      expect(url.pathname).toBe('/s/')
      expect(url.searchParams.get('preview')).toBe('true')
      expect(url.searchParams.get('code')).toBe(body.data.pulseCode)
    })
  })

  describe('authorization', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(401)
    })

    it('returns 400 when itemId is missing', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: {},
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
    })
  })

  describe('item not found', () => {
    it('returns 404 when item does not exist', async () => {
      dynamoSendSpy.mockResolvedValueOnce({ Item: null })

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(404)
    })

    it('returns 404 when item belongs to a different tenant', async () => {
      const otherTenantItem = { ...ITEM, tenantId: { S: 'other-tenant' } }
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
