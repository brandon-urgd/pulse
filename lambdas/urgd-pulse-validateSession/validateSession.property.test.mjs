// Property test for urgd-pulse-validateSession
// Property 17: Session Email Matching Property
// Validates: Requirements 5.8, 5.9

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

const { handler } = await import('./index.mjs')

const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

function makeSessionRecord(reviewerEmail, status = 'not_started') {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test-123' },
    itemId: { S: 'item-test' },
    reviewerEmail: { S: reviewerEmail },
    pulseCode: { S: 'ABCD1234' },
    status: { S: status },
    expiresAt: { S: FUTURE_DATE },
    createdAt: { S: new Date().toISOString() },
  }
}

const ITEM_RECORD = {
  tenantId: { S: 'tenant-test' },
  itemId: { S: 'item-test' },
  itemName: { S: 'Test Item' },
  description: { S: 'A test item' },
}

function makeEvent(pulseCode, email) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-prop-17' },
    body: JSON.stringify({ pulseCode, email }),
  }
}

describe('Property 17: Session Email Matching Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  it('matching email returns session token; non-matching email returns 403 — mutually exclusive', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.emailAddress(),
        async (invitedEmail, providedEmail) => {
          dynamoSendSpy.mockReset()

          // Mock: pulseCode lookup returns session with invitedEmail
          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'QueryCommand') {
              return Promise.resolve({ Items: [makeSessionRecord(invitedEmail)], Count: 1 })
            }
            if (name === 'GetItemCommand') {
              return Promise.resolve({ Item: ITEM_RECORD })
            }
            return Promise.resolve({})
          })

          const event = makeEvent('ABCD1234', providedEmail)
          const result = await handler(event)

          const emailsMatch = invitedEmail.toLowerCase() === providedEmail.toLowerCase().trim()

          if (emailsMatch) {
            // Matching email must return 200 with sessionToken
            expect(result.statusCode).toBe(200)
            const body = JSON.parse(result.body)
            expect(body.sessionToken).toBeDefined()
            expect(typeof body.sessionToken).toBe('string')
            expect(body.sessionToken).toContain(':')
          } else {
            // Non-matching email must return 403
            expect(result.statusCode).toBe(403)
            const body = JSON.parse(result.body)
            expect(body.error).toBeDefined()
          }

          // These two cases are mutually exclusive — never both true
          const got200 = result.statusCode === 200
          const got403 = result.statusCode === 403
          expect(got200 && got403).toBe(false)
          expect(got200 || got403 || result.statusCode === 404 || result.statusCode === 410).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('expired session always returns 410 regardless of email match', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        async (email) => {
          dynamoSendSpy.mockReset()

          // Session with matching email but expired status
          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'QueryCommand') {
              return Promise.resolve({
                Items: [makeSessionRecord(email, 'expired')],
                Count: 1,
              })
            }
            return Promise.resolve({})
          })

          const event = makeEvent('ABCD1234', email)
          const result = await handler(event)

          // Even with matching email, expired session returns 410
          expect(result.statusCode).toBe(410)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('expired-by-date session always returns 410 regardless of email match', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        async (email) => {
          dynamoSendSpy.mockReset()

          const pastDate = new Date(Date.now() - 1000).toISOString()

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'QueryCommand') {
              return Promise.resolve({
                Items: [{
                  ...makeSessionRecord(email, 'not_started'),
                  expiresAt: { S: pastDate },
                }],
                Count: 1,
              })
            }
            return Promise.resolve({})
          })

          const event = makeEvent('ABCD1234', email)
          const result = await handler(event)

          expect(result.statusCode).toBe(410)
        }
      ),
      { numRuns: 100 }
    )
  })
})
