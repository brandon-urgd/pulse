// @vitest-environment jsdom
/**
 * Property 6: Polling resilience with consecutive failure threshold
 *
 * For any sequence of poll responses where network failures and successes are
 * interleaved, the frontend SHALL continue polling through fewer than 10
 * consecutive network failures, SHALL reset the failure counter on any
 * successful poll, and SHALL stop polling after exactly 10 consecutive
 * network failures.
 *
 * **Validates: Requirements 4.5**
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  computePollingState,
  CONSECUTIVE_FAILURE_THRESHOLD,
  type PollOutcome,
} from '../utils/pollingResilience'

// ─── Generators ───────────────────────────────────────────────────────────────

const outcomeArb: fc.Arbitrary<PollOutcome> = fc.constantFrom('success', 'failure')

/** Random sequence of poll outcomes (1–50 items) */
const outcomeSequenceArb = fc.array(outcomeArb, { minLength: 1, maxLength: 50 })

/** Sequence guaranteed to have fewer than 10 consecutive failures */
const safeSequenceArb = outcomeSequenceArb.filter(outcomes => {
  let consecutive = 0
  for (const o of outcomes) {
    if (o === 'failure') {
      consecutive++
      if (consecutive >= CONSECUTIVE_FAILURE_THRESHOLD) return false
    } else {
      consecutive = 0
    }
  }
  return true
})

/** Sequence guaranteed to contain exactly 10 consecutive failures somewhere */
const failingSequenceArb = fc.tuple(
  fc.array(outcomeArb, { minLength: 0, maxLength: 20 }),
  fc.array(outcomeArb, { minLength: 0, maxLength: 20 }),
).map(([prefix, suffix]) => {
  // Ensure prefix doesn't already contain 10 consecutive failures
  const safePrefix: PollOutcome[] = []
  let consecutive = 0
  for (const o of prefix) {
    if (o === 'failure') {
      consecutive++
      if (consecutive >= CONSECUTIVE_FAILURE_THRESHOLD - 1) {
        // Insert a success to break the streak
        safePrefix.push('success')
        consecutive = 0
        continue
      }
    } else {
      consecutive = 0
    }
    safePrefix.push(o)
  }
  // End prefix with a success to reset counter, then add exactly 10 failures
  const tenFailures: PollOutcome[] = Array(CONSECUTIVE_FAILURE_THRESHOLD).fill('failure')
  return [...safePrefix, 'success' as PollOutcome, ...tenFailures, ...suffix]
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Property 6: Polling resilience with consecutive failure threshold', () => {
  it('continues polling when fewer than 10 consecutive failures occur', () => {
    fc.assert(
      fc.property(safeSequenceArb, (outcomes) => {
        const state = computePollingState(outcomes)
        expect(state.shouldContinuePolling).toBe(true)
        expect(state.stoppedByFailures).toBe(false)
        expect(state.consecutiveFailures).toBeLessThan(CONSECUTIVE_FAILURE_THRESHOLD)
      }),
      { numRuns: 200 }
    )
  })

  it('stops polling after exactly 10 consecutive failures', () => {
    fc.assert(
      fc.property(failingSequenceArb, (outcomes) => {
        const state = computePollingState(outcomes)
        expect(state.shouldContinuePolling).toBe(false)
        expect(state.stoppedByFailures).toBe(true)
        expect(state.consecutiveFailures).toBe(CONSECUTIVE_FAILURE_THRESHOLD)
      }),
      { numRuns: 200 }
    )
  })

  it('resets failure counter on any successful poll', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('failure' as PollOutcome), { minLength: 1, maxLength: 9 }),
        (failures) => {
          // failures followed by a success should reset counter
          const outcomes: PollOutcome[] = [...failures, 'success']
          const state = computePollingState(outcomes)
          expect(state.consecutiveFailures).toBe(0)
          expect(state.shouldContinuePolling).toBe(true)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('failure counter equals trailing consecutive failures when polling continues', () => {
    fc.assert(
      fc.property(safeSequenceArb, (outcomes) => {
        const state = computePollingState(outcomes)
        if (!state.shouldContinuePolling) return // skip stopped sequences

        // Count trailing consecutive failures manually
        let trailing = 0
        for (let i = outcomes.length - 1; i >= 0; i--) {
          if (outcomes[i] === 'failure') trailing++
          else break
        }
        expect(state.consecutiveFailures).toBe(trailing)
      }),
      { numRuns: 200 }
    )
  })

  it('exactly 10 failures with no successes stops polling', () => {
    const outcomes: PollOutcome[] = Array(CONSECUTIVE_FAILURE_THRESHOLD).fill('failure')
    const state = computePollingState(outcomes)
    expect(state.shouldContinuePolling).toBe(false)
    expect(state.stoppedByFailures).toBe(true)
    expect(state.consecutiveFailures).toBe(CONSECUTIVE_FAILURE_THRESHOLD)
  })

  it('9 failures followed by success keeps polling alive', () => {
    const outcomes: PollOutcome[] = [
      ...Array(CONSECUTIVE_FAILURE_THRESHOLD - 1).fill('failure'),
      'success',
    ]
    const state = computePollingState(outcomes)
    expect(state.shouldContinuePolling).toBe(true)
    expect(state.consecutiveFailures).toBe(0)
  })
})
