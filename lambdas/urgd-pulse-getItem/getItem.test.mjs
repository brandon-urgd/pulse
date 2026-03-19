// Unit tests for urgd-pulse-getItem
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

const { handler } = await import('./index.mjs')

const ITEM_RECORD = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'Test Item' },
  description: { S: 'A description' },
  status: { S: 'draft' },
  documentStatus: { NULL: true },
  closeDate: { S: new Date(Date.now() + 86400000).toISOString() },
  createdAt: { S: new Date().toISOString() },
  updatedAt: { S: new Date().toISOString() },
}

function makeEvent(tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-123',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
  }
}

describe('urgd-pulse-getItem', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 200 with item data', async () => {
    sendSpy.mockResolvedValueOnce({ Item: ITEM_RECORD })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.itemId).toBe('item-123')
    expect(body.data.itemName).toBe('Test Item')
    expect(body.data.status).toBe('draft')
    expect(body.data.documentStatus).toBe('none')
  })

  it('returns 404 when item not found', async () => {
    sendSpy.mockResolvedValueOnce({ Item: undefined })

    const res = await handler(makeEvent('tenant-abc', 'item-unknown'))
    expect(res.statusCode).toBe(404)
  })

  it('returns 401 when tenantId is missing', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: {} },
      pathParameters: { itemId: 'item-123' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 when itemId is missing', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-abc' } },
      pathParameters: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('queries DynamoDB with tenantId from authorizer context', async () => {
    sendSpy.mockResolvedValueOnce({ Item: ITEM_RECORD })

    await handler(makeEvent('tenant-abc', 'item-123'))

    const getCall = sendSpy.mock.calls[0][0]
    expect(getCall.input.Key.tenantId.S).toBe('tenant-abc')
    expect(getCall.input.Key.itemId.S).toBe('item-123')
  })

  it('returns 500 on DynamoDB failure', async () => {
    sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(500)
  })

  it('returns 404 when item belongs to a different tenant', async () => {
    // Item exists but tenantId in record doesn't match authorizer tenantId
    const mismatchedItem = {
      ...ITEM_RECORD,
      tenantId: { S: 'tenant-other' },
    }
    sendSpy.mockResolvedValueOnce({ Item: mismatchedItem })

    const res = await handler(makeEvent('tenant-abc', 'item-123'))
    expect(res.statusCode).toBe(404)
  })

  it('correctly unmarshals nested M, L, BOOL, and N types', async () => {
    const richItem = {
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-123' },
      itemName: { S: 'Rich Item' },
      description: { S: 'desc' },
      status: { S: 'draft' },
      closeDate: { S: new Date(Date.now() + 86400000).toISOString() },
      createdAt: { S: new Date().toISOString() },
      updatedAt: { S: new Date().toISOString() },
      sessionCount: { N: '3' },
      active: { BOOL: true },
      metadata: { M: { key: { S: 'value' } } },
      tags: { L: [{ S: 'tag1' }, { S: 'tag2' }] },
      documentStatus: { NULL: true },
    }
    sendSpy.mockResolvedValueOnce({ Item: richItem })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.sessionCount).toBe(3)
    expect(body.data.documentStatus).toBe('none')
  })
})
