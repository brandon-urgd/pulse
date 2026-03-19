// Unit tests for urgd-pulse-acceptConfidentiality
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(sessionId, tenantId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId, tenantId },
    },
    body: '{}',
  }
}

describe('urgd-pulse-acceptConfidentiality', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  describe('successful acceptance', () => {
    it('sets confidentialityAcceptedAt timestamp and returns 200', async () => {
      dynamoSendSpy.mockResolvedValue({})

      const res = await handler(makeEvent('session-xyz', 'tenant-abc'))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.sessionId).toBe('session-xyz')
      expect(body.data.confidentialityAcceptedAt).toBeDefined()

      // Verify it's a valid ISO date
      const ts = new Date(body.data.confidentialityAcceptedAt)
      expect(isNaN(ts.getTime())).toBe(false)
    })

    it('calls DynamoDB UpdateItem with correct table and key', async () => {
      dynamoSendSpy.mockResolvedValue({})

      await handler(makeEvent('session-xyz', 'tenant-abc'))

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const cmd = dynamoSendSpy.mock.calls[0][0]
      expect(cmd.constructor.name).toBe('UpdateItemCommand')
      expect(cmd.input.TableName).toBe('urgd-pulse-sessions-dev')
      expect(cmd.input.Key.tenantId.S).toBe('tenant-abc')
      expect(cmd.input.Key.sessionId.S).toBe('session-xyz')
    })
  })

  describe('auth validation', () => {
    it('returns 401 when sessionId is missing from authorizer context', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-abc' } },
        body: '{}',
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { sessionId: 'session-xyz' } },
        body: '{}',
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 401 when both sessionId and tenantId are missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        body: '{}',
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('error handling', () => {
    it('returns 500 on DynamoDB failure', async () => {
      dynamoSendSpy.mockRejectedValue(new Error('DynamoDB error'))

      const res = await handler(makeEvent('session-xyz', 'tenant-abc'))

      expect(res.statusCode).toBe(500)
      expect(JSON.parse(res.body).message).toMatch(/failed/i)
    })
  })
})
