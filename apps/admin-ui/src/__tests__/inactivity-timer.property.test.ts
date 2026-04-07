/**
 * Property 8: Inactivity timer detection
 *
 * For any event sequence and timeout duration, warning fires when and only when
 * gap exceeds `timeoutMs - warningBeforeMs`, timeout fires when and only when
 * gap exceeds `timeoutMs`.
 *
 * Validates: Requirements 4.3, 4.4
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { computeInactivityState } from '../hooks/useInactivityTimer'

describe('Property 8: Inactivity timer detection', () => {
  // Generators
  const lastActivityArb = fc.integer({ min: 0, max: 2_000_000_000_000 }) // epoch ms
  const timeoutMsArb = fc.integer({ min: 1000, max: 3_600_000 })        // 1s – 1h

  /**
   * Build a consistent tuple: (lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
   * where nowMs >= lastActivityMs and 0 < warningBeforeMs < timeoutMs.
   */
  const stateArb = lastActivityArb.chain((lastActivityMs) =>
    timeoutMsArb.chain((timeoutMs) =>
      fc
        .integer({ min: 1, max: timeoutMs - 1 }) // warningBeforeMs ∈ (0, timeoutMs)
        .chain((warningBeforeMs) =>
          fc
            .integer({ min: 0, max: timeoutMs * 2 }) // elapsed can overshoot timeout
            .map((elapsed) => ({
              lastActivityMs,
              nowMs: lastActivityMs + elapsed,
              timeoutMs,
              warningBeforeMs,
              elapsed,
            }))
        )
    )
  )

  it('isWarning is true iff elapsed >= timeoutMs - warningBeforeMs AND elapsed < timeoutMs', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs, elapsed }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        const warningThreshold = timeoutMs - warningBeforeMs
        const expectedWarning = elapsed >= warningThreshold && elapsed < timeoutMs
        expect(state.isWarning).toBe(expectedWarning)
      }),
      { numRuns: 200 }
    )
  })

  it('isTimedOut is true iff elapsed >= timeoutMs', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs, elapsed }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        expect(state.isTimedOut).toBe(elapsed >= timeoutMs)
      }),
      { numRuns: 200 }
    )
  })

  it('remainingMs equals max(0, timeoutMs - elapsed)', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs, elapsed }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        expect(state.remainingMs).toBe(Math.max(0, timeoutMs - elapsed))
      }),
      { numRuns: 200 }
    )
  })

  it('remainingMs is always non-negative', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        expect(state.remainingMs).toBeGreaterThanOrEqual(0)
      }),
      { numRuns: 200 }
    )
  })

  it('isWarning and isTimedOut are mutually exclusive', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        // Both cannot be true at the same time
        expect(state.isWarning && state.isTimedOut).toBe(false)
      }),
      { numRuns: 200 }
    )
  })

  it('when remainingMs is 0, isTimedOut must be true', () => {
    fc.assert(
      fc.property(stateArb, ({ lastActivityMs, nowMs, timeoutMs, warningBeforeMs }) => {
        const state = computeInactivityState(lastActivityMs, nowMs, timeoutMs, warningBeforeMs)
        if (state.remainingMs === 0) {
          expect(state.isTimedOut).toBe(true)
        }
      }),
      { numRuns: 200 }
    )
  })
})
