// Unit tests for urgd-pulse-getReport
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(tenantId, sessionId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId } },
    pathParameters: { sessionId },
  }
}

const REPORT_ITEM = {
  tenantId: { S: 'tenant-1' },
  sessionId: { S: 'session-1' },
  itemId: { S: 'item-1' },
  verdict: { S: 'Worth developing further' },
  conviction: { L: [{ S: 'Pricing is solid' }] },
  tension: { L: [{ S: 'Timeline is aggressive' }] },
  uncertainty: { L: [{ S: 'Market size unclear' }] },
  energy: { S: 'engaged' },
  conversationShape: { S: 'tactical' },
  themes: { L: [{ S: 'pricing' }, { S: 'timeline' }] },
  isSelfReview: { BOOL: false },
  generatedAt: { S: '2024-01-01T00:00:00.000Z' },
}

describe('urgd-pulse-getReport', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('successful retrieval', () => {
    it('returns report for a completed session', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { status: { S: 'completed' } } }) // GetItem session
        .mockResolvedValueOnce({ Item: REPORT_ITEM }) // GetItem report

      const result = await handler(makeEvent('tenant-1', 'session-1'))
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.verdict).toBe('Worth developing further')
      expect(body.data.energy).toBe('engaged')
      expect(body.data.conviction).toEqual(['Pricing is solid'])
      expect(body.data.tension).toEqual(['Timeline is aggressive'])
      expect(body.data.uncertainty).toEqual(['Market size unclear'])
      expect(body.data.themes).toEqual(['pricing', 'timeline'])
      expect(body.data.isSelfReview).toBe(false)
    })

    it('returns all required report fields', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { status: { S: 'completed' } } })
        .mockResolvedValueOnce({ Item: REPORT_ITEM })

      const result = await handler(makeEvent('tenant-1', 'session-1'))
      const body = JSON.parse(result.body)
      const report = body.data

      expect(report).toHaveProperty('sessionId')
      expect(report).toHaveProperty('itemId')
      expect(report).toHaveProperty('verdict')
      expect(report).toHaveProperty('conviction')
      expect(report).toHaveProperty('tension')
      expect(report).toHaveProperty('uncertainty')
      expect(report).toHaveProperty('energy')
      expect(report).toHaveProperty('conversationShape')
      expect(report).toHaveProperty('themes')
      expect(report).toHaveProperty('generatedAt')
    })
  })

  describe('409 for non-completed sessions', () => {
    it.each(['not_started', 'in_progress', 'expired'])(
      'returns 409 for session with status %s',
      async (status) => {
        sendSpy.mockResolvedValueOnce({ Item: { status: { S: status } } })

        const result = await handler(makeEvent('tenant-1', 'session-1'))
        expect(result.statusCode).toBe(409)

        const body = JSON.parse(result.body)
        expect(body.message).toContain('not completed')
      }
    )
  })

  describe('error cases', () => {
    it('returns 401 when tenantId is missing', async () => {
      const result = await handler({
        headers: {},
        requestContext: { authorizer: {} },
        pathParameters: { sessionId: 'session-1' },
      })
      expect(result.statusCode).toBe(401)
    })

    it('returns 400 when sessionId is missing', async () => {
      const result = await handler({
        headers: {},
        requestContext: { authorizer: { tenantId: 'tenant-1' } },
        pathParameters: {},
      })
      expect(result.statusCode).toBe(400)
    })

    it('returns 404 when session not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: null })
      const result = await handler(makeEvent('tenant-1', 'session-1'))
      expect(result.statusCode).toBe(404)
    })

    it('returns 404 when report not found (still generating)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { status: { S: 'completed' } } })
        .mockResolvedValueOnce({ Item: null })

      const result = await handler(makeEvent('tenant-1', 'session-1'))
      expect(result.statusCode).toBe(404)
    })

    it('returns 500 on DynamoDB error', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
      const result = await handler(makeEvent('tenant-1', 'session-1'))
      expect(result.statusCode).toBe(500)
    })
  })
})
