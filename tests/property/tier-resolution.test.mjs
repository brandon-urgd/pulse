// Property-based tests for tier definitions (P1 + P5)
// Uses fast-check with vitest to verify tier correctness invariants.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { TIERS, VALID_FLAGS, VALID_TIERS, getTierDefaults } from '../../lambdas/shared/tiers.mjs'

/**
 * Property 1: Tier Definition Completeness and Parity
 *
 * For any tier name in VALID_TIERS, getTierDefaults(tier) returns an object
 * where: (a) every key in VALID_FLAGS is present with a defined value,
 * (b) no extra keys exist beyond VALID_FLAGS, and (c) for the individual tier,
 * every numeric flag value is >= the free tier value and <= the pro tier value.
 *
 * Validates: Requirements 1.4, 1.6, 1.7, 13.1, 13.2, 13.3
 */
describe('Property P1: Tier Definition Completeness and Parity', () => {
  it('every flag in VALID_FLAGS is defined (non-undefined) in getTierDefaults(tier)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_TIERS), (tier) => {
        const defaults = getTierDefaults(tier)
        for (const flag of VALID_FLAGS) {
          expect(defaults[flag]).not.toBe(undefined)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('no extra keys exist beyond VALID_FLAGS', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_TIERS), (tier) => {
        const defaults = getTierDefaults(tier)
        const extraKeys = Object.keys(defaults).filter((k) => !VALID_FLAGS.includes(k))
        expect(extraKeys).toEqual([])
      }),
      { numRuns: 100 },
    )
  })

  it('individual tier numeric values are between free and pro (inclusive)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FLAGS), (flag) => {
        const indVal = TIERS.individual[flag]
        if (typeof indVal !== 'number') return // skip booleans
        const freeVal = TIERS.free[flag]
        const proVal = TIERS.pro[flag]
        expect(indVal).toBeGreaterThanOrEqual(freeVal)
        expect(indVal).toBeLessThanOrEqual(proVal)
      }),
      { numRuns: 100 },
    )
  })

  it('getTierDefaults returns free tier for unrecognized tier name', () => {
    const result = getTierDefaults('nonexistent')
    expect(result).toEqual(TIERS.free)
  })
})


/**
 * Property 5: VALID_FLAGS ↔ Tier Definition Structural Parity
 *
 * For any tier in TIERS, Object.keys(TIERS[tier]) is exactly equal to
 * VALID_FLAGS (same elements, though order may differ). VALID_FLAGS contains
 * exactly 17 entries. VALID_TIERS contains exactly 5 entries matching
 * ['admin', 'free', 'individual', 'pro', 'enterprise'].
 *
 * Validates: Requirements 1.2, 1.3, 13.2, 13.4
 */
describe('Property P5: VALID_FLAGS ↔ Tier Definition Structural Parity', () => {
  it('Object.keys(TIERS[tier]) set-equals VALID_FLAGS for every tier', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_TIERS), (tier) => {
        const tierKeys = Object.keys(TIERS[tier]).sort()
        const flags = [...VALID_FLAGS].sort()
        expect(tierKeys).toEqual(flags)
      }),
      { numRuns: 100 },
    )
  })

  it('VALID_FLAGS contains exactly 17 entries', () => {
    expect(VALID_FLAGS.length).toBe(17)
  })

  it('VALID_TIERS contains exactly 5 entries', () => {
    expect(VALID_TIERS.length).toBe(5)
  })

  it('VALID_TIERS contains exactly admin, free, individual, pro, enterprise', () => {
    const expected = ['admin', 'free', 'individual', 'pro', 'enterprise'].sort()
    expect([...VALID_TIERS].sort()).toEqual(expected)
  })
})
