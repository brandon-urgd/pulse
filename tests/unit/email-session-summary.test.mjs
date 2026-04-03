// Unit tests for emailSessionSummary Lambda
// Tests: valid send, invalid email, session not found, SES failure
// **Validates: Requirements 5.1, 5.3, 5.4, 5.6**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockDynamoSend = vi.fn()
const mockSesSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockDynamoSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient { send(cmd) { return mockSesSend(cmd) } }
  class SendEmailCommand { constructor(input) { this.input = input; this._type = 'SendEmail' } }
  return { SESClient, SendEmailCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: (code, data, headers, origin) => ({
    statusCode: code,
    body: JSON.stringify(data),
  }),
  errorResponse: (code, msg, details, origin) => ({
    statusCode: code,
    body: JSON.stringify({ error: true, message: msg }),
  }),
}))

function makeEvent(sessionId, tenantId, body) {
  return {
    headers: { origin: 'https://pulse.urgd.dev' },
    requestContext: {
      authorizer: { sessionId, tenantId },
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

const SESSION_ITEM = {
  tenantId: { S: 'tenant-1' },
  sessionId: { S: 'sess-1' },
  summary: { S: JSON.stringify({ sections: ['Intro'], themes: ['Quality'], closingMessage: 'Great work!' }) },
  itemName: { S: 'My Item' },
}

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockSesSend.mockReset()
  process.env.SESSIONS_TABLE = 'sessions'
  process.env.SES_FROM_EMAIL = 'noreply@pulse.urgd.dev'
  process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
})

describe('emailSessionSummary unit tests', () => {
  it('sends email successfully for valid request', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-emailSessionSummary/index.mjs')

    mockDynamoSend.mockResolvedValue({ Item: SESSION_ITEM })
    mockSesSend.mockResolvedValue({})

    const result = await handler(makeEvent('sess-1', 'tenant-1', { email: 'reviewer@example.com' }))
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body).data.sent).toBe(true)
    expect(mockSesSend).toHaveBeenCalledTimes(1)
  })

  it('returns 400 for invalid email', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-emailSessionSummary/index.mjs')

    const result = await handler(makeEvent('sess-1', 'tenant-1', { email: 'not-an-email' }))
    expect(result.statusCode).toBe(400)
  })

  it('returns 404 when session not found', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-emailSessionSummary/index.mjs')

    mockDynamoSend.mockResolvedValue({ Item: null })

    const result = await handler(makeEvent('sess-missing', 'tenant-1', { email: 'reviewer@example.com' }))
    expect(result.statusCode).toBe(404)
  })

  it('returns 500 on SES failure', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-emailSessionSummary/index.mjs')

    mockDynamoSend.mockResolvedValue({ Item: SESSION_ITEM })
    mockSesSend.mockRejectedValue(new Error('SES throttled'))

    const result = await handler(makeEvent('sess-1', 'tenant-1', { email: 'reviewer@example.com' }))
    expect(result.statusCode).toBe(500)
  })
})
