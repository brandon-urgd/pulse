// Feature: async-revision-generation, Property 8: Eligible session counting
// Uses fast-check with vitest to verify computeSessionDecrements correctly counts
// non-cancelled/non-discarded sessions and public sessions for cascading decrements.
// **Validates: Requirements 9.2, 9.3**

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// Mock AWS SDK clients to prevent real connections at module load
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class DeleteItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class ListObjectsV2Command { constructor(input) { this.input = input } }
  class DeleteObjectsCommand { constructor(input) { this.input = input } }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand }
})

vi.mock('./shared/counters.mjs', () => ({
  decrementCounter: vi.fn().mockResolvedValue({ success: true }),
}))

// Set required env vars before importing the module under test
process.env.ITEMS_TABLE = 'test-items'
process.env.SESSIONS_TABLE = 'test-sessions'
process.env.TRANSCRIPTS_TABLE = 'test-transcripts'
process.env.REPORTS_TABLE = 'test-reports'
process.env.PULSE_CHECKS_TABLE = 'test-pulse-checks'
process.env.DATA_BUCKET_NAME = 'test-bucket'
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost'

const { computeSessionDecrements } = await import('../../lambdas/urgd-pulse-deleteItem/index.mjs')

// ── Generators ───────────────────────────────────────────────────────────────

const VALID_STATUSES = ['not_started', 'in_progress', 'completed', 'expired', 'cancelled', 'discarded']
const EXCLUDED_STATUSES = ['cancelled', 'discarded']

const statusArb = fc.constantFrom(...VALID_STATUSES)

/** Generate a single DynamoDB-format session object with random status and isPublic */
const sessionArb = fc.record({
  status: statusArb,
  isPublic: fc.boolean(),
}).map(({ status, isPublic }) => ({
  status: { S: status },
  isPublic: { BOOL: isPublic },
  sessionId: { S: fc.sample(fc.uuid(), 1)[0] },
  tenantId: { S: 'test-tenant' },
}))

/** Generate an array of 0–50 session objects */
const sessionsArb = fc.array(sessionArb, { minLength: 0, maxLength: 50 })

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * Property 8: Eligible session counting for cascading decrements
 *
 * For any list of session objects with random statuses (from the set
 * ['not_started', 'in_progress', 'completed', 'expired', 'cancelled', 'discarded'])
 * and random isPublic boolean values, computeSessionDecrements should return:
 * (a) sessionDecrement equal to the count of sessions where status is not 'cancelled'
 *     and not 'discarded', and
 * (b) publicSessionDecrement equal to the count of sessions where isPublic is true
 *     and status is not 'cancelled' and not 'discarded'.
 *
 * **Validates: Requirements 9.2, 9.3**
 */
describe('Feature: async-revision-generation, Property 8: Eligible session counting', () => {
  it('sessionDecrement equals count of non-cancelled/non-discarded sessions and publicSessionDecrement equals count of eligible public sessions', () => {
    fc.assert(
      fc.property(sessionsArb, (sessions) => {
        const result = computeSessionDecrements(sessions)

        // Compute expected values from the raw session data
        const expectedSessionDecrement = sessions.filter(
          (s) => !EXCLUDED_STATUSES.includes(s.status?.S)
        ).length

        const expectedPublicSessionDecrement = sessions.filter(
          (s) => !EXCLUDED_STATUSES.includes(s.status?.S) && s.isPublic?.BOOL === true
        ).length

        expect(result.sessionDecrement).toBe(expectedSessionDecrement)
        expect(result.publicSessionDecrement).toBe(expectedPublicSessionDecrement)
      }),
      { numRuns: 100 },
    )
  })

  it('publicSessionDecrement is always <= sessionDecrement', () => {
    fc.assert(
      fc.property(sessionsArb, (sessions) => {
        const result = computeSessionDecrements(sessions)
        expect(result.publicSessionDecrement).toBeLessThanOrEqual(result.sessionDecrement)
      }),
      { numRuns: 100 },
    )
  })

  it('returns zero decrements when all sessions are cancelled or discarded', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom('cancelled', 'discarded'),
            isPublic: fc.boolean(),
          }).map(({ status, isPublic }) => ({
            status: { S: status },
            isPublic: { BOOL: isPublic },
            sessionId: { S: fc.sample(fc.uuid(), 1)[0] },
            tenantId: { S: 'test-tenant' },
          })),
          { minLength: 1, maxLength: 20 },
        ),
        (sessions) => {
          const result = computeSessionDecrements(sessions)
          expect(result.sessionDecrement).toBe(0)
          expect(result.publicSessionDecrement).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
