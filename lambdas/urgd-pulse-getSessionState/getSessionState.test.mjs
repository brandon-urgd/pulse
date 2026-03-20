// Unit tests for urgd-pulse-getSessionState
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
  describe('orphan filter (23.2)', () => {
    it('strips unpaired trailing reviewer message from transcript', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [
          makeMessage('01HTEST000000000000000001', 'reviewer', 'Hello'),
          makeMessage('01HTEST000000000000000002', 'agent', 'Hi there!'),
          makeMessage('01HTEST000000000000000003', 'reviewer', 'orphan — no agent reply'),
        ]})
        .mockResolvedValueOnce({ Item: makeItemRecord() })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.messages).toHaveLength(2)
      expect(body.data.messages[1].role).toBe('agent')
    })

    it('returns messages unchanged when transcript is properly paired', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [
          makeMessage('01HTEST000000000000000001', 'reviewer', 'Hello'),
          makeMessage('01HTEST000000000000000002', 'agent', 'Hi there!'),
        ]})
        .mockResolvedValueOnce({ Item: makeItemRecord() })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.messages).toHaveLength(2)
    })

    it('returns empty messages when only an orphan exists', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [
          makeMessage('01HTEST000000000000000001', 'reviewer', 'orphan'),
        ]})
        .mockResolvedValueOnce({ Item: makeItemRecord() })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.messages).toHaveLength(0)
    })
  })

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

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    status: { S: 'in_progress' },
    currentSection: { N: '2' },
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    itemId: { S: 'item-1' },
    ...overrides,
  }
}

function makeMessage(messageId, role, text) {
  return {
    sessionId: { S: 'session-1' },
    messageId: { S: messageId },
    role: { S: role },
    content: { S: text },
    timestamp: { S: new Date().toISOString() },
  }
}

function makeItemRecord() {
  return {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
  }
}

describe('urgd-pulse-getSessionState', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('successful state retrieval', () => {
    it('returns 200 with all required fields', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } } })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.currentSection).toBe(2)
      expect(body.data.totalSections).toBe(5)
      expect(body.data.status).toBe('in_progress')
      expect(body.data.timeLimitMinutes).toBe(30)
      expect(Array.isArray(body.data.messages)).toBe(true)
      expect(Array.isArray(body.data.files)).toBe(true)
    })

    it('returns messages sorted by ULID ascending', async () => {
      const items = [
        { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000001' }, role: { S: 'reviewer' }, content: { S: 'Hello' }, timestamp: { S: '2024-01-01T00:00:00Z' } },
        { sessionId: { S: 'session-1' }, messageId: { S: '01HTEST000000000000000002' }, role: { S: 'agent' }, content: { S: 'Hi there' }, timestamp: { S: '2024-01-01T00:00:01Z' } },
      ]

      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: items })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } } })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.messages).toHaveLength(2)
      expect(body.data.messages[0].role).toBe('reviewer')
      expect(body.data.messages[0].content).toBe('Hello')
      expect(body.data.messages[1].role).toBe('agent')
    })

    it('returns files array with fileId for items with documentKey', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({
          Item: {
            tenantId: { S: 'tenant-1' },
            itemId: { S: 'item-1' },
            documentKey: { S: 'pulse/tenant-1/items/item-1/document.pdf' },
            documentStatus: { S: 'ready' },
          },
        })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.files).toHaveLength(1)
      expect(body.data.files[0].fileId).toBeDefined()
      expect(body.data.files[0].filename).toBe('document.pdf')
      expect(body.data.files[0].contentType).toBe('application/pdf')
    })

    it('returns empty files array for paste-only items (documentStatus none)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession() })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({
          Item: {
            tenantId: { S: 'tenant-1' },
            itemId: { S: 'item-1' },
            documentStatus: { S: 'none' },
          },
        })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.files).toHaveLength(0)
    })

    it('defaults timeLimitMinutes to 30 when not set', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: makeSession({ timeLimitMinutes: undefined }) })
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } } })

      const res = await handler(makeEvent())
      const body = JSON.parse(res.body)
      expect(body.data.timeLimitMinutes).toBe(30)
    })
  })

  describe('error handling', () => {
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
