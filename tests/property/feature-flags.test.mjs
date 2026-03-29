// Property-based tests for feature resolution (P2 + P3)
// Uses fast-check with vitest to verify resolveFeature correctness invariants.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { resolveFeature } from '../../lambdas/shared/features.mjs'
import { TIERS, VALID_FLAGS, VALID_TIERS, getTierDefaults } from '../../lambdas/shared/tiers.mjs'

/**
 * Property 2: resolveFeature() Never Throws
 *
 * For any combination of tenant record (including null, undefined, objects with
 * missing fields, objects with wrong types), feature name (including empty string,
 * null, random strings, valid flag names), and system record (including null,
 * undefined, malformed objects), resolveFeature() returns a valid
 * { allowed: boolean, reason: string, limit: number|null } object without throwing.
 *
 * Validates: Requirements 2.10
 */
describe('Property P2: resolveFeature() Never Throws', () => {
  it('returns { allowed: boolean, reason: string, limit: number|null } for any inputs', () => {
    fc.assert(
      fc.property(
        fc.anything(),
        fc.string(),
        fc.anything(),
        (tenantRecord, featureName, systemRecord) => {
          const result = resolveFeature(tenantRecord, featureName, systemRecord)
          expect(typeof result.allowed).toBe('boolean')
          expect(typeof result.reason).toBe('string')
          expect(result.limit === null || typeof result.limit === 'number').toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})


/**
 * Property 3: Resolution Order Determinism
 *
 * For any tenant record and system record combination, the resolution pipeline
 * follows this exact priority order, and the first matching rule wins:
 *   1. Unknown flag → unknown_feature
 *   2. System circuit breaker → maintenance
 *   3. Tenant circuit breaker → maintenance
 *   4. Tenant override → resolved by type
 *   5. Tier default → resolved by type
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9
 */
describe('Property P3: Resolution Order Determinism', () => {
  it('unknown flag → { allowed: false, reason: "unknown_feature", limit: null }', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !VALID_FLAGS.includes(s)),
        (unknownFlag) => {
          const result = resolveFeature({}, unknownFlag)
          expect(result).toEqual({ allowed: false, reason: 'unknown_feature', limit: null })
        },
      ),
      { numRuns: 100 },
    )
  })

  it('system circuit breaker wins over tenant override', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FLAGS), (flag) => {
        const tenantRecord = {
          tier: 'pro',
          features: { [flag]: true },
          serviceFlags: {},
        }
        const systemRecord = {
          serviceFlags: { [flag]: { status: 'maintenance' } },
        }
        const result = resolveFeature(tenantRecord, flag, systemRecord)
        expect(result).toEqual({ allowed: false, reason: 'maintenance', limit: null })
      }),
      { numRuns: 100 },
    )
  })

  it('tenant circuit breaker wins over tenant override (when no system CB)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FLAGS), (flag) => {
        const tenantRecord = {
          tier: 'pro',
          features: { [flag]: true },
          serviceFlags: { [flag]: { status: 'maintenance' } },
        }
        const systemRecord = { serviceFlags: {} }
        const result = resolveFeature(tenantRecord, flag, systemRecord)
        expect(result).toEqual({ allowed: false, reason: 'maintenance', limit: null })
      }),
      { numRuns: 100 },
    )
  })

  it('tenant override wins over tier default', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FLAGS), (flag) => {
        // Use free tier — pick an override value that differs from the free default
        const freeDefault = TIERS.free[flag]
        let overrideValue
        if (typeof freeDefault === 'boolean') {
          overrideValue = !freeDefault
        } else {
          overrideValue = freeDefault + 100
        }

        const tenantRecord = {
          tier: 'free',
          features: { [flag]: overrideValue },
          serviceFlags: {},
        }
        const result = resolveFeature(tenantRecord, flag, null)

        // The result should reflect the override, not the tier default
        if (typeof overrideValue === 'boolean') {
          if (overrideValue) {
            expect(result).toEqual({ allowed: true, reason: 'allowed', limit: null })
          } else {
            expect(result).toEqual({ allowed: false, reason: 'tier_limit', limit: null })
          }
        } else {
          expect(result).toEqual({ allowed: true, reason: 'allowed', limit: overrideValue })
        }
      }),
      { numRuns: 100 },
    )
  })

  it('getTierDefaults fallback for unknown tier returns TIERS.free', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !VALID_TIERS.includes(s)),
        (unknownTier) => {
          expect(getTierDefaults(unknownTier)).toBe(TIERS.free)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('boolean true override → allowed, boolean false → tier_limit, number → allowed with limit', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FLAGS), (flag) => {
        const base = { tier: 'free', serviceFlags: {} }

        // boolean true → allowed
        const r1 = resolveFeature({ ...base, features: { [flag]: true } }, flag, null)
        expect(r1).toEqual({ allowed: true, reason: 'allowed', limit: null })

        // boolean false → tier_limit
        const r2 = resolveFeature({ ...base, features: { [flag]: false } }, flag, null)
        expect(r2).toEqual({ allowed: false, reason: 'tier_limit', limit: null })

        // number → allowed with limit
        const r3 = resolveFeature({ ...base, features: { [flag]: 42 } }, flag, null)
        expect(r3).toEqual({ allowed: true, reason: 'allowed', limit: 42 })
      }),
      { numRuns: 100 },
    )
  })
})
