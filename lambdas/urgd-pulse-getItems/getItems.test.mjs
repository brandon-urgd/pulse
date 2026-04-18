// Unit tests for urgd-pulse-getItems
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, QueryCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(tenantId = 'tenant-abc') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-123',
      authorizer: { tenantId },
    },
  }
}

function makeItem(itemId, updatedAt, status = 'draft') {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: itemId },
    itemName: { S: `Item ${itemId}` },
    description: { S: 'A description' },
    status: { S: status },
    documentStatus: { NULL: true },
    closeDate: { S: new Date(Date.now() + 86400000).toISOString() },
    createdAt: { S: updatedAt },
    updatedAt: { S: updatedAt },
  }
}

describe('urgd-pulse-getItems', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 200 with empty array for new tenant', async () => {
    sendSpy.mockResolvedValueOnce({ Items: [] })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toEqual([])
  })

  it('returns items sorted by updatedAt descending', async () => {
    const items = [
      makeItem('item-1', '2024-01-01T10:00:00.000Z'),
      makeItem('item-2', '2024-01-03T10:00:00.000Z'),
      makeItem('item-3', '2024-01-02T10:00:00.000Z'),
    ]
    sendSpy.mockResolvedValueOnce({ Items: items })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(3)
    expect(body.data[0].itemId).toBe('item-2')
    expect(body.data[1].itemId).toBe('item-3')
    expect(body.data[2].itemId).toBe('item-1')
  })

  it('returns items with correct unmarshalled fields', async () => {
    const items = [makeItem('item-1', '2024-01-01T10:00:00.000Z')]
    sendSpy.mockResolvedValueOnce({ Items: items })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    const item = body.data[0]
    expect(item.tenantId).toBe('tenant-abc')
    expect(item.itemId).toBe('item-1')
    expect(item.status).toBe('draft')
    expect(item.documentStatus).toBe('none')
  })

  it('queries DynamoDB with tenantId from authorizer context', async () => {
    sendSpy.mockResolvedValueOnce({ Items: [] })

    await handler(makeEvent('tenant-xyz'))

    const queryCall = sendSpy.mock.calls[0][0]
    expect(queryCall.input.ExpressionAttributeValues[':tid'].S).toBe('tenant-xyz')
  })

  it('returns 401 when tenantId is missing from authorizer context', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: {} },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 500 on DynamoDB failure', async () => {
    sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(500)
  })

  it('handles items with missing updatedAt gracefully (sorts to end)', async () => {
    const items = [
      makeItem('item-1', '2024-01-01T10:00:00.000Z'),
      // item without updatedAt
      {
        tenantId: { S: 'tenant-abc' },
        itemId: { S: 'item-no-date' },
        itemName: { S: 'No Date Item' },
        description: { S: 'desc' },
        status: { S: 'draft' },
      },
    ]
    sendSpy.mockResolvedValueOnce({ Items: items })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toHaveLength(2)
    // item with date should come first
    expect(body.data[0].itemId).toBe('item-1')
  })

  it('handles items with nested M and L DynamoDB types', async () => {
    const items = [{
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-nested' },
      itemName: { S: 'Nested Item' },
      description: { S: 'desc' },
      status: { S: 'draft' },
      updatedAt: { S: '2024-01-01T10:00:00.000Z' },
      metadata: { M: { key: { S: 'value' }, count: { N: '5' } } },
      tags: { L: [{ S: 'tag1' }, { S: 'tag2' }] },
      active: { BOOL: true },
    }]
    sendSpy.mockResolvedValueOnce({ Items: items })

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data[0].itemId).toBe('item-nested')
    expect(body.data[0].itemName).toBe('Nested Item')
  })

  describe('hasCompletedRevision', () => {
    it('returns true for closed item with a completed revision', async () => {
      const items = [makeItem('item-closed', '2024-01-01T10:00:00.000Z', 'closed')]
      sendSpy
        .mockResolvedValueOnce({ Items: items }) // items query
        .mockResolvedValueOnce({ Items: [{ status: { S: 'complete' } }] }) // revision query

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(true)
    })

    it('returns true for revised item with a completed revision', async () => {
      const items = [makeItem('item-revised', '2024-01-01T10:00:00.000Z', 'revised')]
      sendSpy
        .mockResolvedValueOnce({ Items: items }) // items query
        .mockResolvedValueOnce({ Items: [{ status: { S: 'complete' } }] }) // revision query

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(true)
    })

    it('returns false for closed item with no completed revisions', async () => {
      const items = [makeItem('item-closed', '2024-01-01T10:00:00.000Z', 'closed')]
      sendSpy
        .mockResolvedValueOnce({ Items: items }) // items query
        .mockResolvedValueOnce({ Items: [] }) // revision query — no results

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(false)
    })

    it('defaults to false when revision query fails (fail-open)', async () => {
      const items = [makeItem('item-closed', '2024-01-01T10:00:00.000Z', 'closed')]
      sendSpy
        .mockResolvedValueOnce({ Items: items }) // items query
        .mockRejectedValueOnce(new Error('DynamoDB error')) // revision query fails

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(false)
    })

    it('does not query revisions for draft items', async () => {
      const items = [makeItem('item-draft', '2024-01-01T10:00:00.000Z', 'draft')]
      sendSpy.mockResolvedValueOnce({ Items: items })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(false)
      // Only 1 call: the items query. No revision query for draft items.
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    it('does not query revisions for active items', async () => {
      const items = [makeItem('item-active', '2024-01-01T10:00:00.000Z', 'active')]
      sendSpy.mockResolvedValueOnce({ Items: items })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data[0].hasCompletedRevision).toBe(false)
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    it('queries revisions in parallel with session lookups', async () => {
      const closedWithPulse = {
        ...makeItem('item-closed-pc', '2024-01-01T10:00:00.000Z', 'closed'),
        hasPulseCheck: { BOOL: true },
        pulseCheckGeneratedAt: { S: '2024-01-01T12:00:00.000Z' },
      }
      sendSpy
        .mockResolvedValueOnce({ Items: [closedWithPulse] }) // items query
        // Both session and revision queries run in parallel
        .mockResolvedValue({ Items: [] })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      // 3 calls: items query + session query + revision query
      expect(sendSpy).toHaveBeenCalledTimes(3)
    })
  })
})
