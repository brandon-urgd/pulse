// Property-based tests for async revision delivery mode feature flag
// Uses fast-check with vitest to verify REVISION_DELIVERY_MODE correctness.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { VALID_FLAGS, VALID_TIERS, getTierDefaults } from '../../lambdas/shared/tiers.mjs'
import { resolveDeliveryMode } from '../../lambdas/shared/features.mjs'

/**
 * Property 1: Tier defaults include REVISION_DELIVERY_MODE
 *
 * For any valid tier name in VALID_TIERS, getTierDefaults(tier).REVISION_DELIVERY_MODE
 * should equal 'async', and VALID_FLAGS should include 'REVISION_DELIVERY_MODE'.
 *
 * **Validates: Requirements 1.1**
 */
describe('Feature: async-revision-generation, Property 1: Tier defaults include REVISION_DELIVERY_MODE', () => {
  it('VALID_FLAGS includes REVISION_DELIVERY_MODE', () => {
    expect(VALID_FLAGS).toContain('REVISION_DELIVERY_MODE')
  })

  it('getTierDefaults(tier).REVISION_DELIVERY_MODE === "async" for every valid tier', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_TIERS), (tier) => {
        const defaults = getTierDefaults(tier)
        expect(defaults.REVISION_DELIVERY_MODE).toBe('async')
      }),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 2: resolveDeliveryMode defaults to 'async' for non-sync values
 *
 * For any system record where features.REVISION_DELIVERY_MODE is not the string
 * 'sync' (including undefined, null, empty string, random strings, numbers,
 * booleans, objects, or absent features map), resolveDeliveryMode(systemRecord)
 * should return 'async'. Only the exact string 'sync' produces 'sync'.
 *
 * **Validates: Requirements 1.3**
 */
describe('Feature: async-revision-generation, Property 2: resolveDeliveryMode defaults to async', () => {
  // Generator for arbitrary non-'sync' values
  const nonSyncValueArb = fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant(''),
    fc.constant('async'),
    fc.constant('Sync'),
    fc.constant('SYNC'),
    fc.constant(' sync'),
    fc.constant('sync '),
    fc.string().filter((s) => s !== 'sync'),
    fc.integer(),
    fc.double({ noNaN: true }),
    fc.boolean(),
    fc.constant(0),
    fc.constant(false),
    fc.constant(true),
    fc.dictionary(fc.string(), fc.string()),
    fc.constant([]),
  )

  it('returns "async" when REVISION_DELIVERY_MODE is any non-"sync" value', () => {
    fc.assert(
      fc.property(nonSyncValueArb, (flagValue) => {
        const systemRecord = { features: { REVISION_DELIVERY_MODE: flagValue } }
        expect(resolveDeliveryMode(systemRecord)).toBe('async')
      }),
      { numRuns: 200 },
    )
  })

  it('returns "async" when features map is absent', () => {
    expect(resolveDeliveryMode({})).toBe('async')
    expect(resolveDeliveryMode({ features: {} })).toBe('async')
  })

  it('returns "async" when systemRecord is null or undefined', () => {
    expect(resolveDeliveryMode(null)).toBe('async')
    expect(resolveDeliveryMode(undefined)).toBe('async')
  })

  it('returns "sync" only for the exact string "sync"', () => {
    const systemRecord = { features: { REVISION_DELIVERY_MODE: 'sync' } }
    expect(resolveDeliveryMode(systemRecord)).toBe('sync')
  })

  it('returns either "async" or "sync" for any arbitrary system record shape', () => {
    const arbitrarySystemRecord = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.record({ features: fc.constant(undefined) }),
      fc.record({ features: fc.constant(null) }),
      fc.record({
        features: fc.record({
          REVISION_DELIVERY_MODE: fc.oneof(
            nonSyncValueArb,
            fc.constant('sync'),
          ),
        }),
      }),
    )

    fc.assert(
      fc.property(arbitrarySystemRecord, (systemRecord) => {
        const result = resolveDeliveryMode(systemRecord)
        expect(['async', 'sync']).toContain(result)
      }),
      { numRuns: 200 },
    )
  })
})
