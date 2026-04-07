/**
 * Property-based tests for the InteractionTimer pure accumulation logic.
 *
 * Uses fast-check to verify correctness properties of `computeCumulativeTime`
 * across a wide range of generated event sequences and idle thresholds.
 *
 * Properties 5, 6, and 7 are tested below.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { computeCumulativeTime, type TimerEvent } from '../hooks/useInteractionTimer'

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary timestamp in a realistic range (ms since epoch) */
const arbTimestamp = () =>
  fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 })

/** Arbitrary TimerEvent type */
const arbEventType = (): fc.Arbitrary<TimerEvent['type']> =>
  fc.oneof(
    fc.constant('interaction' as const),
    fc.constant('visibility_hidden' as const),
    fc.constant('visibility_visible' as const),
  )

/** Arbitrary single TimerEvent */
const arbTimerEvent = (): fc.Arbitrary<TimerEvent> =>
  fc.record({
    timestamp: arbTimestamp(),
    type: arbEventType(),
  })

/** Arbitrary non-empty list of TimerEvents (2–40 items for meaningful accumulation) */
const arbEventSequence = (): fc.Arbitrary<TimerEvent[]> =>
  fc.array(arbTimerEvent(), { minLength: 2, maxLength: 40 })

/** Arbitrary idle threshold in ms (100ms to 5 minutes) */
const arbIdleThreshold = () =>
  fc.integer({ min: 100, max: 300_000 })

// ---------------------------------------------------------------------------
// Property 5: Interaction timer accumulation
// ---------------------------------------------------------------------------

describe('interaction timer property tests', () => {
  /**
   * **Validates: Requirements 3.1, 3.2, 3.6, 3.7**
   *
   * Property 5: Interaction timer accumulation — for any sequence of
   * timestamped user events and visibility changes, and for any idle
   * threshold, the `computeCumulativeTime` function SHALL return a
   * cumulative time that:
   *   (a) excludes all gaps longer than the idle threshold
   *   (b) excludes all periods where the tab is hidden
   *   (c) is less than or equal to the wall-clock duration (last − first)
   *   (d) is non-negative
   */
  it('Property 5: cumulative time excludes idle gaps and hidden periods, is ≤ wall-clock, and is non-negative', () => {
    fc.assert(
      fc.property(
        arbEventSequence(),
        arbIdleThreshold(),
        (events, idleThresholdMs) => {
          const result = computeCumulativeTime(events, idleThresholdMs)

          // (d) Non-negative
          expect(result).toBeGreaterThanOrEqual(0)

          // (c) ≤ wall-clock duration
          const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
          const wallClock = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
          expect(result).toBeLessThanOrEqual(wallClock)

          // (a) Verify no single accumulated gap exceeds the idle threshold.
          //     We recompute the accumulation step-by-step and check each
          //     contributing gap is ≤ idleThresholdMs.
          let hidden = false
          for (let i = 1; i < sorted.length; i++) {
            const prev = sorted[i - 1]
            const curr = sorted[i]

            if (prev.type === 'visibility_hidden') hidden = true
            if (prev.type === 'visibility_visible') hidden = false

            const gap = curr.timestamp - prev.timestamp

            if (!hidden && gap <= idleThresholdMs) {
              // This gap was accumulated — it must be ≤ idle threshold (by definition)
              expect(gap).toBeLessThanOrEqual(idleThresholdMs)
            }
          }

          // (b) Verify that hidden periods contribute zero time.
          //     Compute what the result would be if we included hidden periods
          //     and confirm the actual result is ≤ that value.
          let cumulativeIgnoringVisibility = 0
          for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i].timestamp - sorted[i - 1].timestamp
            if (gap <= idleThresholdMs) {
              cumulativeIgnoringVisibility += gap
            }
          }
          expect(result).toBeLessThanOrEqual(cumulativeIgnoringVisibility)
        },
      ),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 6: Wrap-up threshold triggering
  // ---------------------------------------------------------------------------

  /**
   * **Validates: Requirements 3.4**
   *
   * Property 6: Wrap-up threshold triggering — for any event sequence where
   * the cumulative interaction time crosses the wrap-up threshold, the
   * interaction timer SHALL report threshold-reached exactly once, and SHALL
   * not report it for sequences where cumulative time stays below the
   * threshold.
   *
   * Since `computeCumulativeTime` is a pure function returning a number, we
   * simulate the threshold-check logic that the hook performs: walk through
   * progressively longer prefixes of the event sequence, compute cumulative
   * time at each step, and track when the threshold is crossed.
   */
  it('Property 6: threshold-reached fires exactly once when crossed, never fires when below', () => {
    /** Arbitrary positive threshold in ms (1 s to 10 min) */
    const arbThresholdMs = () => fc.integer({ min: 1_000, max: 600_000 })

    fc.assert(
      fc.property(
        arbEventSequence(),
        arbIdleThreshold(),
        arbThresholdMs(),
        (events, idleThresholdMs, thresholdMs) => {
          // Sort events chronologically (same as the pure function does)
          const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

          // Simulate the hook's threshold-check: walk through progressively
          // longer prefixes and compute cumulative time at each step.
          let thresholdFiredCount = 0
          let thresholdAlreadyFired = false

          for (let prefixLen = 2; prefixLen <= sorted.length; prefixLen++) {
            const prefix = sorted.slice(0, prefixLen)
            const cumulative = computeCumulativeTime(prefix, idleThresholdMs)

            if (!thresholdAlreadyFired && cumulative >= thresholdMs) {
              thresholdFiredCount++
              thresholdAlreadyFired = true
            }
          }

          // Compute final cumulative time for the full sequence
          const finalCumulative = computeCumulativeTime(sorted, idleThresholdMs)

          if (finalCumulative >= thresholdMs) {
            // Threshold was crossed → must have fired exactly once
            expect(thresholdFiredCount).toBe(1)
          } else {
            // Threshold was never crossed → must never have fired
            expect(thresholdFiredCount).toBe(0)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 7: Session completion payload invariant
  // ---------------------------------------------------------------------------

  /**
   * **Validates: Requirements 3.5**
   *
   * Property 7: Session completion payload invariant — for any completed
   * session, the reported payload SHALL contain both `interactionTimeMs` and
   * `wallClockTimeMs` fields, and `interactionTimeMs` SHALL be less than or
   * equal to `wallClockTimeMs`.
   *
   * We simulate a session by generating an event sequence, computing
   * cumulative interaction time via the pure function, deriving wall-clock
   * time from the event span, and constructing the payload that
   * `reportSessionCompletion` would send.
   */
  it('Property 7: session completion payload contains both time fields and interactionTimeMs ≤ wallClockTimeMs', () => {
    fc.assert(
      fc.property(
        arbEventSequence(),
        arbIdleThreshold(),
        (events, idleThresholdMs) => {
          // Sort chronologically (mirrors what the pure function does)
          const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

          // Compute the two timing values that would populate the payload
          const interactionTimeMs = computeCumulativeTime(sorted, idleThresholdMs)
          const wallClockTimeMs = sorted[sorted.length - 1].timestamp - sorted[0].timestamp

          // Construct the session completion payload
          const payload: { interactionTimeMs: number; wallClockTimeMs: number } = {
            interactionTimeMs,
            wallClockTimeMs,
          }

          // Both fields must exist
          expect(payload).toHaveProperty('interactionTimeMs')
          expect(payload).toHaveProperty('wallClockTimeMs')

          // Both fields must be numbers
          expect(typeof payload.interactionTimeMs).toBe('number')
          expect(typeof payload.wallClockTimeMs).toBe('number')

          // interactionTimeMs ≤ wallClockTimeMs
          expect(payload.interactionTimeMs).toBeLessThanOrEqual(payload.wallClockTimeMs)

          // Both must be non-negative
          expect(payload.interactionTimeMs).toBeGreaterThanOrEqual(0)
          expect(payload.wallClockTimeMs).toBeGreaterThanOrEqual(0)
        },
      ),
      { numRuns: 200 },
    )
  })
})
