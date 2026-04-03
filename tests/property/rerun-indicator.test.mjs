// Property-based tests for rerun indicator timestamp comparison (P11)
// Uses fast-check with vitest to verify indicator logic.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ─── Pure function under test ─────────────────────────────────────────────────

/**
 * Determine whether the rerun indicator dot should be shown.
 * Shown iff any session's completedAt is strictly greater than generatedAt.
 * Returns false if generatedAt is falsy (no pulse check exists).
 */
function shouldShowRerunDot(generatedAt, sessions) {
  if (!generatedAt) return false
  return sessions.some((s) => s.completedAt && s.completedAt > generatedAt)
}

// ─── Generators ───────────────────────────────────────────────────────────────

/** Generate a timestamp as an ISO string within a reasonable range */
const timestampArb = fc
  .integer({
    min: new Date('2024-01-01T00:00:00Z').getTime(),
    max: new Date('2030-12-31T23:59:59Z').getTime(),
  })
  .map((ms) => new Date(ms).toISOString())

/** Generate a session with an optional completedAt timestamp */
const sessionArb = fc.record({
  sessionId: fc.uuid(),
  completedAt: fc.option(timestampArb, { nil: undefined }),
})

/** Generate an array of sessions */
const sessionsArb = fc.array(sessionArb, { minLength: 0, maxLength: 20 })

// ─── Property Tests ───────────────────────────────────────────────────────────

/**
 * Property 11: Rerun Indicator Timestamp Comparison
 *
 * For any item with a pulse check (generatedAt timestamp) and a set of completed
 * sessions (each with completedAt timestamps), the rerun indicator SHALL be shown
 * if and only if at least one session's completedAt is strictly greater than the
 * pulse check's generatedAt. Running a new pulse check (which sets generatedAt
 * to now) SHALL cause the indicator to disappear.
 *
 * **Validates: Requirements 7.1, 7.3**
 */
describe('Property P11: Rerun indicator comparison', () => {
  it('indicator shown iff any completedAt > generatedAt', () => {
    fc.assert(
      fc.property(timestampArb, sessionsArb, (generatedAt, sessions) => {
        const result = shouldShowRerunDot(generatedAt, sessions)
        const expected = sessions.some(
          (s) => s.completedAt && s.completedAt > generatedAt,
        )
        expect(result).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('no indicator when generatedAt is falsy (no pulse check)', () => {
    fc.assert(
      fc.property(sessionsArb, (sessions) => {
        expect(shouldShowRerunDot(null, sessions)).toBe(false)
        expect(shouldShowRerunDot(undefined, sessions)).toBe(false)
        expect(shouldShowRerunDot('', sessions)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('new pulse check (generatedAt = now) clears indicator for past sessions', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({
            min: new Date('2024-01-01T00:00:00Z').getTime(),
            max: new Date('2029-12-31T23:59:59Z').getTime(),
          }).map((ms) => ({ completedAt: new Date(ms).toISOString() })),
          { minLength: 1, maxLength: 10 },
        ),
        (sessions) => {
          // generatedAt set to a time after all possible completedAt values
          const futureGeneratedAt = '2030-12-31T23:59:59.999Z'
          expect(shouldShowRerunDot(futureGeneratedAt, sessions)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('indicator shown when at least one session completed after pulse check', () => {
    fc.assert(
      fc.property(
        fc.integer({
          min: new Date('2024-01-01T00:00:00Z').getTime(),
          max: new Date('2029-12-31T23:59:59Z').getTime(),
        }).map((ms) => new Date(ms).toISOString()),
        (generatedAt) => {
          // Create a session that completed 1 second after generatedAt
          const laterDate = new Date(new Date(generatedAt).getTime() + 1000)
          const sessions = [{ completedAt: laterDate.toISOString() }]
          expect(shouldShowRerunDot(generatedAt, sessions)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})
