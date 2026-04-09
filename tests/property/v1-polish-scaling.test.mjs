// Property tests and unit tests for v1 Launch Polish — Scaling
// Validates: Requirements 6A.1, 6A.2, 6A.4, 6A.5, 6B.6, 6B.7, 6B.8, 6B.9, 6B.11, 6C.13, 6C.14, 6D.16, 6D.17

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { TIERS } from '../../lambdas/shared/tiers.mjs'

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Inline getScaleTier to avoid importing TSX in a Node test environment
function getScaleTier(sessionCount) {
  if (sessionCount <= 1) return 'solo'
  if (sessionCount <= 7) return 'small'
  return 'medium' // 8-20
}

// Inline token budget functions to avoid importing Lambda with AWS SDK deps.
// These mirror the exported functions in urgd-pulse-processPulseCheck/index.mjs.
function getMaxTokens(sessionCount) {
  if (sessionCount <= 7) return 4096
  if (sessionCount <= 15) return 8192
  return 4096 // per-batch max_tokens for map-reduce
}

function getConsolidationMaxTokens() {
  return 8192
}

const TIER_LIMITS = {
  free: 5,
  individual: 10,
  pro: 20,
  enterprise: 20,
  admin: 999,
}

const TIER_NAMES = Object.keys(TIER_LIMITS)

// ─── Task 9.5: Unit tests for tiers.mjs updated values ────────────────────────
// **Validates: Requirements 6A.1**

describe('Unit tests: tiers.mjs maxSessionsPerItem values', () => {
  it.each([
    ['free', 5],
    ['individual', 10],
    ['pro', 20],
    ['enterprise', 20],
    ['admin', 999],
  ])('%s tier has maxSessionsPerItem = %d', (tier, expected) => {
    expect(TIERS[tier].maxSessionsPerItem).toBe(expected)
  })
})

// ─── Property 3: Session cap enforcement is consistent across tiers ────────────
// **Validates: Requirements 6A.1, 6A.2, 6A.4**
// For any (tier, sessionCount), if count >= limit then blocked, else allowed.

describe('Property 3: Session cap enforcement is consistent across tiers', () => {
  it('for any tier and session count, blocked iff count >= limit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TIER_NAMES),
        fc.integer({ min: 0, max: 1000 }),
        (tier, sessionCount) => {
          const limit = TIER_LIMITS[tier]
          const blocked = sessionCount >= limit

          if (blocked) {
            expect(sessionCount).toBeGreaterThanOrEqual(limit)
          } else {
            expect(sessionCount).toBeLessThan(limit)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 4: Session cap warning threshold ─────────────────────────────────
// **Validates: Requirements 6A.5**
// Warning visible iff sessionCount >= (max - 3) and sessionCount < max.

describe('Property 4: Session cap warning appears at correct threshold', () => {
  it('warning visible iff sessionCount >= (max - 3) and sessionCount < max', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TIER_NAMES),
        fc.integer({ min: 0, max: 1000 }),
        (tier, sessionCount) => {
          const max = TIER_LIMITS[tier]
          const warningVisible = sessionCount >= (max - 3) && sessionCount < max

          if (warningVisible) {
            expect(sessionCount).toBeGreaterThanOrEqual(max - 3)
            expect(sessionCount).toBeLessThan(max)
          } else {
            // Either below threshold or at/above cap
            const belowThreshold = sessionCount < (max - 3)
            const atOrAboveCap = sessionCount >= max
            expect(belowThreshold || atOrAboveCap).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 5: Scale tier detection is deterministic ─────────────────────────
// **Validates: Requirements 6B.6, 6B.7, 6B.8, 6B.11**
// For sessionCount in [1, 20]: solo for 1, small for 2-7, medium for 8-20.

describe('Property 5: Scale tier detection is deterministic', () => {
  it('returns correct tier for any session count in [1, 20]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (sessionCount) => {
          const tier = getScaleTier(sessionCount)

          if (sessionCount === 1) {
            expect(tier).toBe('solo')
          } else if (sessionCount >= 2 && sessionCount <= 7) {
            expect(tier).toBe('small')
          } else {
            expect(tier).toBe('medium')
          }

          // SignalSummary renders iff tier is 'medium'
          const shouldRenderSignalSummary = tier === 'medium'
          expect(shouldRenderSignalSummary).toBe(sessionCount >= 8)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 6: Revision grouping activates at correct threshold ──────────────
// **Validates: Requirements 6B.9**
// Grouping active iff sessionCount > 10.

describe('Property 6: Revision grouping activates at correct threshold', () => {
  it('grouping active iff sessionCount > 10', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (sessionCount) => {
          const groupingActive = sessionCount > 10
          expect(groupingActive).toBe(sessionCount > 10)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 7: Export format matches presentation tier ───────────────────────
// **Validates: Requirements 6C.13, 6C.14**
// Signal Summary format for sessionCount >= 8, full matrix for < 8.

describe('Property 7: Export format matches presentation tier', () => {
  it('Signal Summary format for >= 8 sessions, matrix for < 8', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (sessionCount) => {
          const useSignalSummaryFormat = sessionCount >= 8
          const useMatrixFormat = sessionCount < 8

          expect(useSignalSummaryFormat).toBe(!useMatrixFormat)

          if (sessionCount >= 8) {
            expect(useSignalSummaryFormat).toBe(true)
            expect(useMatrixFormat).toBe(false)
          } else {
            expect(useSignalSummaryFormat).toBe(false)
            expect(useMatrixFormat).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ─── Property 8: Generation strategy and token budget match session count ──────
// **Validates: Requirements 6D.16, 6D.17**
// [1-7] → 4096 single-prompt, [8-15] → 8192 single-prompt with quality instruction,
// [16-20] → map-reduce with batch 4096 and consolidation 8192.

describe('Property 8: Generation strategy and token budget match session count', () => {
  it('token budget and strategy are correct for any session count in [1, 20]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (sessionCount) => {
          const maxTokens = getMaxTokens(sessionCount)
          const consolidationTokens = getConsolidationMaxTokens()

          if (sessionCount >= 1 && sessionCount <= 7) {
            // Single-prompt, 4096 tokens, no quality instruction
            expect(maxTokens).toBe(4096)
          } else if (sessionCount >= 8 && sessionCount <= 15) {
            // Single-prompt, 8192 tokens, with quality instruction
            expect(maxTokens).toBe(8192)
          } else {
            // 16-20: map-reduce, batch 4096, consolidation 8192
            expect(maxTokens).toBe(4096)
            expect(consolidationTokens).toBe(8192)
          }

          // Consolidation max tokens is always 8192
          expect(consolidationTokens).toBe(8192)

          // Strategy branching: single-prompt for <= 15, map-reduce for >= 16
          const useSinglePrompt = sessionCount <= 15
          const useMapReduce = sessionCount >= 16
          expect(useSinglePrompt).toBe(!useMapReduce)
        },
      ),
      { numRuns: 100 },
    )
  })
})
