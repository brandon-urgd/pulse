// Unit tests for urgd-pulse-updateItem
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

const { handler } = await import('./index.mjs')

function makeFutureDate() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}

function makeDraftItem(tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    tenantId: { S: tenantId },
    itemId: { S: itemId },
    itemName: { S: 'Original Name' },
    description: { S: 'Original description' },
    closeDate: { S: makeFutureDate() },
    status: { S: 'draft' },
    documentStatus: { NULL: true },
    createdAt: { S: new Date().toISOString() },
    updatedAt: { S: new Date().toISOString() },
  }
}

function makeLockedItem(status, tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    ...makeDraftItem(tenantId, itemId),
    status: { S: status },
  }
}

function makeEvent(tenantId, itemId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-123',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-updateItem', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  describe('draft item updates succeed', () => {
    it('returns 200 with updated item for draft item', async () => {
      const draftItem = makeDraftItem()
      const updatedAttributes = {
        ...draftItem,
        itemName: { S: 'Updated Name' },
        updatedAt: { S: new Date().toISOString() },
      }
      sendSpy
        .mockResolvedValueOnce({ Item: draftItem })
        .mockResolvedValueOnce({ Attributes: updatedAttributes })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: 'Updated Name' }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.itemName).toBe('Updated Name')
    })

    it('updates description for draft item', async () => {
      const draftItem = makeDraftItem()
      const updatedAttributes = {
        ...draftItem,
        description: { S: 'New description' },
        updatedAt: { S: new Date().toISOString() },
      }
      sendSpy
        .mockResolvedValueOnce({ Item: draftItem })
        .mockResolvedValueOnce({ Attributes: updatedAttributes })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { description: 'New description' }))
      expect(res.statusCode).toBe(200)
    })

    it('updates closeDate for draft item', async () => {
      const draftItem = makeDraftItem()
      const newDate = makeFutureDate()
      const updatedAttributes = {
        ...draftItem,
        closeDate: { S: newDate },
        updatedAt: { S: new Date().toISOString() },
      }
      sendSpy
        .mockResolvedValueOnce({ Item: draftItem })
        .mockResolvedValueOnce({ Attributes: updatedAttributes })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { closeDate: newDate }))
      expect(res.statusCode).toBe(200)
    })

    it('stores content in S3 and sets documentStatus to "ready" when content provided', async () => {
      const draftItem = makeDraftItem()
      const updatedAttributes = {
        ...draftItem,
        documentStatus: { S: 'ready' },
        updatedAt: { S: new Date().toISOString() },
      }
      sendSpy
        .mockResolvedValueOnce({ Item: draftItem })
        .mockResolvedValueOnce({ Attributes: updatedAttributes })

      const res = await handler(makeEvent('tenant-abc', 'item-123', {
        content: '# Updated content',
      }))

      expect(res.statusCode).toBe(200)
      expect(s3SendSpy).toHaveBeenCalledOnce()
      const s3Call = s3SendSpy.mock.calls[0][0]
      expect(s3Call.input.Key).toBe('pulse/tenant-abc/items/item-123/document.md')
      expect(s3Call.input.Body).toBe('# Updated content')
    })
  })

  describe('non-draft returns 409', () => {
    it.each(['active', 'closed', 'revised'])('returns 409 for %s item', async (status) => {
      sendSpy.mockResolvedValueOnce({ Item: makeLockedItem(status) })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: 'New Name' }))
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).message).toMatch(/locked/i)
    })
  })

  describe('unknown item returns 404', () => {
    it('returns 404 when item does not exist', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent('tenant-abc', 'item-unknown', { itemName: 'New Name' }))
      expect(res.statusCode).toBe(404)
    })
  })

  describe('input validation', () => {
    it('returns 400 when itemName is empty string', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: '' }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when itemName exceeds 200 chars', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: 'a'.repeat(201) }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when description exceeds 2000 chars', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { description: 'a'.repeat(2001) }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when closeDate is in the past', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', {
        closeDate: new Date(Date.now() - 1000).toISOString(),
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: { itemId: 'item-123' },
        body: 'not-json',
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('auth and error handling', () => {
    it('returns 401 when tenantId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
        body: JSON.stringify({ itemName: 'x' }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 400 when itemId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: {},
        body: JSON.stringify({ itemName: 'x' }),
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: 'x' }))
      expect(res.statusCode).toBe(500)
    })

    it('correctly unmarshals N, BOOL, M, L, NULL types in returned item', async () => {
      const draftItem = makeDraftItem()
      const updatedAttributes = {
        ...draftItem,
        sessionCount: { N: '5' },
        active: { BOOL: true },
        metadata: { M: { key: { S: 'val' } } },
        tags: { L: [{ S: 'a' }] },
        documentStatus: { NULL: true },
      }
      sendSpy
        .mockResolvedValueOnce({ Item: draftItem })
        .mockResolvedValueOnce({ Attributes: updatedAttributes })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { itemName: 'Updated' }))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.sessionCount).toBe(5)
      expect(body.data.documentStatus).toBe('none')
    })
  })
})
