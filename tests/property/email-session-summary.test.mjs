// Property-based tests for emailSessionSummary Lambda (P8)
// Uses fast-check with vitest to verify email PII is ephemeral.
// **Validates: Requirements 5.4**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Track all calls ──────────────────────────────────────────────────────────
let dynamoWrites, sesCalls, logCalls

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

const mockLog = vi.fn()
vi.mock('./shared/utils.mjs', () => ({
  log: (...args) => { mockLog(...args); },
  requireEnv: vi.fn(),
  createResponse: (code, data, headers, origin) => ({
    statusCode: code,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  }),
  errorResponse: (code, msg, details, origin) => ({
    statusCode: code,
    body: JSON.stringify({ error: true, message: msg }),
    headers: { 'Content-Type': 'application/json' },
  }),
}))

// ── Generators ───────────────────────────────────────────────────────────────
const emailArb = fc.emailAddress()
const sessionDataArb = fc.record({
  sessionId: fc.uuid(),
  tenantId: fc.uuid(),
  summary: fc.record({
    sections: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 3 }),
    themes: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 3 }),
    closingMessage: fc.string({ minLength: 1, maxLength: 100 }),
  }),
})


/**
 * Property 8: Email PII Ephemeral
 *
 * For any session summary email send operation, the reviewer's email address
 * SHALL NOT appear in any DynamoDB write operation's attribute values, SHALL NOT
 * appear in any structured log output, and SHALL only be passed to the SES
 * SendEmail API call.
 *
 * Validates: Requirements 5.4
 */
describe('Property P8: Email PII ephemeral', () => {
  beforeEach(() => {
    dynamoWrites = []
    sesCalls = []
    logCalls = []
    mockDynamoSend.mockReset()
    mockSesSend.mockReset()
    mockLog.mockReset()

    process.env.SESSIONS_TABLE = 'sessions'
    process.env.SES_FROM_EMAIL = 'noreply@pulse.urgd.dev'
    process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
  })

  it('email appears only in SES call args, not in DynamoDB writes or logs', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-emailSessionSummary/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        emailArb,
        sessionDataArb,
        async (email, sessionData) => {
          dynamoWrites = []
          sesCalls = []
          mockLog.mockClear()

          // Mock DynamoDB to return session with summary
          mockDynamoSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: {
                  tenantId: { S: sessionData.tenantId },
                  sessionId: { S: sessionData.sessionId },
                  summary: { S: JSON.stringify(sessionData.summary) },
                  itemName: { S: 'Test Item' },
                },
              })
            }
            // Track any writes
            dynamoWrites.push(JSON.stringify(cmd.input))
            return Promise.resolve({})
          })

          // Mock SES
          mockSesSend.mockImplementation((cmd) => {
            sesCalls.push(JSON.stringify(cmd.input))
            return Promise.resolve({})
          })

          const event = {
            headers: { origin: 'https://pulse.urgd.dev' },
            requestContext: {
              authorizer: {
                sessionId: sessionData.sessionId,
                tenantId: sessionData.tenantId,
              },
            },
            body: JSON.stringify({ email }),
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          // Email SHOULD appear in SES call
          const sesCallStr = sesCalls.join(' ')
          expect(sesCallStr).toContain(email)

          // Email should NOT appear in any DynamoDB write
          for (const write of dynamoWrites) {
            expect(write).not.toContain(email)
          }

          // Email should NOT appear in any log call
          for (const call of mockLog.mock.calls) {
            const logStr = JSON.stringify(call)
            expect(logStr).not.toContain(email)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
