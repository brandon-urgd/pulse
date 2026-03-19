// Unit tests for urgd-pulse-deleteSessionTranscript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class BatchWriteItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, BatchWriteItemCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent() {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
    },
  }
}

function makeSession(status = 'in_progress') {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    status: { S: status },
  }
}

function makeTranscripts(n) {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: { S: 'session-1' },
    messageId: { S: `01HTEST${String(i).padStart(18, '0')}` },
  }))
}

describe('urgd-pulse-deleteSessionTranscript', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('successful discard', () => {
    it('returns 200 with discarded: true for in_progress session', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession('in_progress') })
        .mockResolvedValueOnce({ Items: makeTranscripts(3) })
        .mockResolvedValueOnce({}) // BatchWriteItem
        .mockResolvedValueOnce({}) // UpdateItem

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).data.discarded).toBe(true)
    })

    it('deletes all transcripts in batches of 25', async () => {
      const transcripts = makeTranscripts(30)
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession('in_progress') })
        .mockResolvedValueOnce({ Items: transcripts })
        .mockResolvedValueOnce({}) // batch 1 (25 items)
        .mockResolvedValueOnce({}) // batch 2 (5 items)
        .mockResolvedValueOnce({}) // UpdateItem

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      // sendSpy calls: GetItem(0), Query(1), BatchWrite(2), BatchWrite(3), UpdateItem(4)
      expect(sendSpy).toHaveBeenCalledTimes(5)
      // Verify batch calls have the right number of items
      const batch1 = sendSpy.mock.calls[2][0]
      const batch2 = sendSpy.mock.calls[3][0]
      expect(batch1.input.RequestItems[process.env.TRANSCRIPTS_TABLE]).toHaveLength(25)
      expect(batch2.input.RequestItems[process.env.TRANSCRIPTS_TABLE]).toHaveLength(5)
    })

    it('handles empty transcript list gracefully', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession('not_started') })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({}) // UpdateItem

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)

      const batchCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'BatchWriteItemCommand')
      expect(batchCalls).toHaveLength(0)
    })

    it('updates session status to discarded', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession('in_progress') })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({}) // UpdateItem

      await handler(makeEvent())

      // sendSpy calls: GetItem(0), Query(1), UpdateItem(2)
      expect(sendSpy).toHaveBeenCalledTimes(3)
      const updateCall = sendSpy.mock.calls[2][0]
      expect(updateCall.input.UpdateExpression).toContain('discarded')
    })
  })

  describe('error cases', () => {
    it('returns 409 when session is completed', async () => {
      sendSpy.mockResolvedValueOnce({ Item: makeSession('completed') })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).message).toMatch(/completed/i)
    })

    it('returns 401 when sessionId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-1' } },
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 when session not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(404)
    })

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)
    })
  })
})
