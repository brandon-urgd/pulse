// Unit tests for urgd-pulse-deleteItem
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
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
  class QueryCommand { constructor(input) { this.input = input } }
  class DeleteItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class ListObjectsV2Command { constructor(input) { this.input = input } }
  class DeleteObjectsCommand { constructor(input) { this.input = input } }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand }
})

const { handler } = await import('./index.mjs')

const ITEM_RECORD = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'Test Item' },
  status: { S: 'draft' },
  createdAt: { S: new Date().toISOString() },
  updatedAt: { S: new Date().toISOString() },
}

const SESSION_1 = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-1' },
  itemId: { S: 'item-123' },
}

const SESSION_2 = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-2' },
  itemId: { S: 'item-123' },
}

const TRANSCRIPT_1 = {
  sessionId: { S: 'session-1' },
  messageId: { S: 'msg-1' },
}

const TRANSCRIPT_2 = {
  sessionId: { S: 'session-1' },
  messageId: { S: 'msg-2' },
}

const REPORT_1 = {
  tenantId: { S: 'tenant-abc' },
  sessionId: { S: 'session-1' },
  itemId: { S: 'item-123' },
}

const S3_OBJECTS = [
  { Key: 'pulse/tenant-abc/items/item-123/document.md' },
  { Key: 'pulse/tenant-abc/items/item-123/qr/session-1.png' },
]

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

/**
 * Set up standard mock sequence for a full cascading delete.
 */
function setupFullDeleteMocks() {
  sendSpy.mockImplementation((command) => {
    const name = command?.constructor?.name
    if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
    if (name === 'QueryCommand') {
      const table = command.input.TableName
      if (table === process.env.SESSIONS_TABLE) return Promise.resolve({ Items: [SESSION_1, SESSION_2] })
      if (table === process.env.TRANSCRIPTS_TABLE) {
        const sid = command.input.ExpressionAttributeValues[':sid']?.S
        if (sid === 'session-1') return Promise.resolve({ Items: [TRANSCRIPT_1, TRANSCRIPT_2] })
        return Promise.resolve({ Items: [] })
      }
      if (table === process.env.REPORTS_TABLE) return Promise.resolve({ Items: [REPORT_1] })
      return Promise.resolve({ Items: [] })
    }
    if (name === 'DeleteItemCommand') return Promise.resolve({})
    return Promise.resolve({})
  })

  s3SendSpy.mockImplementation((command) => {
    const name = command?.constructor?.name
    if (name === 'ListObjectsV2Command') return Promise.resolve({ Contents: S3_OBJECTS, IsTruncated: false })
    if (name === 'DeleteObjectsCommand') return Promise.resolve({})
    return Promise.resolve({})
  })
}

describe('urgd-pulse-deleteItem', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
  })

  describe('cascades across all tables and S3', () => {
    it('returns 200 with "Item deleted" message', async () => {
      setupFullDeleteMocks()

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).message).toBe('Item deleted')
    })

    it('deletes all sessions for the item', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const sessionDeletes = sendSpy.mock.calls.filter(
        call =>
          call[0]?.constructor?.name === 'DeleteItemCommand' &&
          call[0]?.input?.TableName === process.env.SESSIONS_TABLE
      )
      expect(sessionDeletes).toHaveLength(2)
    })

    it('deletes all transcripts for each session', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const transcriptDeletes = sendSpy.mock.calls.filter(
        call =>
          call[0]?.constructor?.name === 'DeleteItemCommand' &&
          call[0]?.input?.TableName === process.env.TRANSCRIPTS_TABLE
      )
      // session-1 has 2 transcripts, session-2 has 0
      expect(transcriptDeletes).toHaveLength(2)
    })

    it('deletes all reports for the item', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const reportDeletes = sendSpy.mock.calls.filter(
        call =>
          call[0]?.constructor?.name === 'DeleteItemCommand' &&
          call[0]?.input?.TableName === process.env.REPORTS_TABLE
      )
      expect(reportDeletes).toHaveLength(1)
    })

    it('deletes pulse check record', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const pulseCheckDeletes = sendSpy.mock.calls.filter(
        call =>
          call[0]?.constructor?.name === 'DeleteItemCommand' &&
          call[0]?.input?.TableName === process.env.PULSE_CHECKS_TABLE
      )
      expect(pulseCheckDeletes).toHaveLength(1)
    })

    it('deletes item record from DynamoDB', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const itemDeletes = sendSpy.mock.calls.filter(
        call =>
          call[0]?.constructor?.name === 'DeleteItemCommand' &&
          call[0]?.input?.TableName === process.env.ITEMS_TABLE
      )
      expect(itemDeletes).toHaveLength(1)
    })

    it('lists and deletes S3 objects under item prefix', async () => {
      setupFullDeleteMocks()

      await handler(makeEvent())

      const listCalls = s3SendSpy.mock.calls.filter(
        call => call[0]?.constructor?.name === 'ListObjectsV2Command'
      )
      expect(listCalls).toHaveLength(1)
      expect(listCalls[0][0].input.Prefix).toBe('pulse/tenant-abc/items/item-123/')

      const deleteCalls = s3SendSpy.mock.calls.filter(
        call => call[0]?.constructor?.name === 'DeleteObjectsCommand'
      )
      expect(deleteCalls).toHaveLength(1)
      expect(deleteCalls[0][0].input.Delete.Objects).toHaveLength(2)
    })

    it('handles item with no sessions gracefully', async () => {
      sendSpy.mockImplementation((command) => {
        const name = command?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        if (name === 'DeleteItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })
      s3SendSpy.mockImplementation((command) => {
        if (command?.constructor?.name === 'ListObjectsV2Command') {
          return Promise.resolve({ Contents: [], IsTruncated: false })
        }
        return Promise.resolve({})
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
    })

    it('does not call DeleteObjects when no S3 objects exist', async () => {
      sendSpy.mockImplementation((command) => {
        const name = command?.constructor?.name
        if (name === 'GetItemCommand') return Promise.resolve({ Item: ITEM_RECORD })
        if (name === 'QueryCommand') return Promise.resolve({ Items: [] })
        if (name === 'DeleteItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })
      s3SendSpy.mockImplementation((command) => {
        if (command?.constructor?.name === 'ListObjectsV2Command') {
          return Promise.resolve({ Contents: [], IsTruncated: false })
        }
        return Promise.resolve({})
      })

      await handler(makeEvent())

      const deleteCalls = s3SendSpy.mock.calls.filter(
        call => call[0]?.constructor?.name === 'DeleteObjectsCommand'
      )
      expect(deleteCalls).toHaveLength(0)
    })
  })

  describe('error handling', () => {
    it('returns 404 when item does not exist', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent())
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

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)
    })
  })
})
