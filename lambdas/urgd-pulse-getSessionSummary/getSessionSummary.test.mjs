// Unit tests for urgd-pulse-getSessionSummary
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function makeEvent() {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
    },
  }
}

const VALID_SUMMARY = JSON.stringify({
  sections: ['Introduction', 'Main Content'],
  themes: ['Theme 1', 'Theme 2', 'Theme 3'],
  closingMessage: 'Thank you for your feedback.',
})

describe('urgd-pulse-getSessionSummary', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('successful summary retrieval', () => {
    it('returns 200 with summary for completed session', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: {
          tenantId: { S: 'tenant-1' },
          sessionId: { S: 'session-1' },
          status: { S: 'completed' },
          summary: { S: VALID_SUMMARY },
          tenantName: { S: 'Acme Corp' },
        },
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.summary.sections).toEqual(['Introduction', 'Main Content'])
      expect(body.data.summary.themes).toHaveLength(3)
      expect(body.data.summary.closingMessage).toBe('Thank you for your feedback.')
      expect(body.data.tenantName).toBe('Acme Corp')
    })
  })

  describe('error cases', () => {
    it('returns 409 when session is not completed', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: {
          tenantId: { S: 'tenant-1' },
          sessionId: { S: 'session-1' },
          status: { S: 'in_progress' },
        },
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).message).toMatch(/not completed/i)
    })

    it('returns 409 when summary not yet generated', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: {
          tenantId: { S: 'tenant-1' },
          sessionId: { S: 'session-1' },
          status: { S: 'completed' },
          // no summary field
        },
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(409)
      expect(JSON.parse(res.body).message).toMatch(/not ready/i)
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
