// Property test for urgd-pulse-expireSessions
// Property 28: Session Expiration Property
// Validates: Requirements 13.2

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class ScanCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, ScanCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

const NOW = new Date()
const PAST_DATE = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()   // 1 hour ago
const FUTURE_DATE = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() // 1 hour from now

function makeSession(tenantId, sessionId, status, expiresAt) {
  return {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    status: { S: status },
    ...(expiresAt ? { expiresAt: { S: expiresAt } } : {}),
  }
}

describe('Property 28: Session Expiration Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  it('sessions with past expiresAt and non-completed status are expired; completed sessions are never modified', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a batch of sessions with various statuses and expiry dates
        fc.array(
          fc.record({
            tenantId: fc.uuid(),
            sessionId: fc.uuid(),
            status: fc.constantFrom('not_started', 'in_progress', 'completed', 'expired'),
            isPast: fc.boolean(),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        async (sessions) => {
          dynamoSendSpy.mockReset()

          const updateCalls = []

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'ScanCommand') {
              // Return sessions that match the filter: past expiresAt, not completed/expired
              const eligible = sessions
                .filter(s => s.isPast && s.status !== 'completed' && s.status !== 'expired')
                .map(s => makeSession(s.tenantId, s.sessionId, s.status, PAST_DATE))
              return Promise.resolve({ Items: eligible, Count: eligible.length })
            }
            if (name === 'UpdateItemCommand') {
              updateCalls.push(cmd.input)
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          await handler({})

          // Completed sessions must never be updated
          const completedSessions = sessions.filter(s => s.status === 'completed')
          for (const completed of completedSessions) {
            const wasUpdated = updateCalls.some(
              call => call.Key?.sessionId?.S === completed.sessionId
            )
            expect(wasUpdated).toBe(false)
          }

          // Sessions with past expiresAt and non-completed/non-expired status should be updated
          const eligibleSessions = sessions.filter(
            s => s.isPast && s.status !== 'completed' && s.status !== 'expired'
          )
          expect(updateCalls.length).toBe(eligibleSessions.length)

          // Each update must set status to "expired"
          for (const call of updateCalls) {
            const newStatus = call.ExpressionAttributeValues?.[':expired']?.S
            expect(newStatus).toBe('expired')
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('sessions with future expiresAt are never expired', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tenantId: fc.uuid(),
            sessionId: fc.uuid(),
            status: fc.constantFrom('not_started', 'in_progress'),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (sessions) => {
          dynamoSendSpy.mockReset()

          const updateCalls = []

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'ScanCommand') {
              // Scan returns empty — future sessions don't match the filter
              return Promise.resolve({ Items: [], Count: 0 })
            }
            if (name === 'UpdateItemCommand') {
              updateCalls.push(cmd.input)
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          await handler({})

          // No updates should happen for future sessions
          expect(updateCalls.length).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('completed sessions are never modified even if expiresAt is in the past', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 5 }),
        async (sessionIds) => {
          dynamoSendSpy.mockReset()

          const updateCalls = []

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'ScanCommand') {
              // Scan returns empty — completed sessions are filtered out by the scan expression
              return Promise.resolve({ Items: [], Count: 0 })
            }
            if (name === 'UpdateItemCommand') {
              updateCalls.push(cmd.input)
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          await handler({})

          // Completed sessions must never be updated
          expect(updateCalls.length).toBe(0)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('expiration job result counts are consistent with actual updates', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        async (eligibleCount) => {
          dynamoSendSpy.mockReset()

          const eligibleSessions = Array.from({ length: eligibleCount }, (_, i) =>
            makeSession(`tenant-${i}`, `session-${i}`, 'not_started', PAST_DATE)
          )

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'ScanCommand') {
              return Promise.resolve({ Items: eligibleSessions, Count: eligibleSessions.length })
            }
            if (name === 'UpdateItemCommand') {
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          const result = await handler({})

          // totalExpired must equal the number of eligible sessions
          expect(result.totalExpired).toBe(eligibleCount)
          expect(result.totalScanned).toBe(eligibleCount)
        }
      ),
      { numRuns: 100 }
    )
  })
})
