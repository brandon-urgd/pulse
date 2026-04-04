// Feature: pulse-s2-s4-billing, Property 1: Counter enforcement correctness
// Feature: pulse-s2-s4-billing, Property 2: Lazy reset for free tier
// Uses fast-check with vitest to verify counter enforcement and lazy reset logic.
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Mock AWS SDK ─────────────────────────────────────────────────────────────
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this._type = 'UpdateItem' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

vi.mock('./shared/features.mjs', () => ({
  resolveFeature: vi.fn(),
}))

// ── Generators ───────────────────────────────────────────────────────────────
const counterNameArb = fc.constantFrom(
  'monthlyItemsCreated',
  'monthlySessionsTotal',
  'monthlyPublicSessionsTotal',
)

const countArb = fc.nat({ max: 500 })
const limitArb = fc.integer({ min: 1, max: 500 })

const tierArb = fc.constantFrom('free', 'individual', 'pro', 'enterprise', 'admin')

// Generate a periodStart that is in the current month
const currentMonthPeriodStart = fc.constant(
  (() => {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().split('T')[0]
  })()
)

// Generate a periodStart that is in a previous month
const previousMonthPeriodStart = fc.integer({ min: 1, max: 24 }).map(monthsAgo => {
  const now = new Date()
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
  return d.toISOString().split('T')[0]
})

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * Property 1: Counter Enforcement Correctness
 *
 * For any counter name, current count, and resolved limit:
 * - If count >= limit, checkAndIncrement returns { allowed: false, reason: 'monthly_limit' }
 *   with a valid resetDate string.
 * - If count < limit, checkAndIncrement returns { allowed: true } and the counter
 *   is incremented by exactly 1.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5
 */
describe('Property P1: Counter enforcement correctness', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSend.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
    process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
  })

  it('blocks when count >= limit, allows and increments when count < limit', async () => {
    const { resolveFeature } = await import('../../lambdas/shared/features.mjs')

    await fc.assert(
      fc.asyncProperty(
        counterNameArb,
        countArb,
        limitArb,
        currentMonthPeriodStart,
        async (counterName, count, limit, periodStart) => {
          // Reset mocks for each iteration
          mockSend.mockReset()
          resolveFeature.mockReset()

          // Mock resolveFeature to return the limit
          resolveFeature.mockReturnValue({ allowed: true, reason: 'allowed', limit })

          // Mock DynamoDB GetItem to return current counter state
          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: {
                  tenantId: { S: 'test-tenant' },
                  tier: { S: 'pro' }, // Non-free tier to skip lazy reset
                  usageCounters: {
                    M: {
                      [counterName]: {
                        M: {
                          count: { N: String(count) },
                          periodStart: { S: periodStart },
                        },
                      },
                    },
                  },
                },
              })
            }
            if (cmd._type === 'UpdateItem') {
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          // Import fresh to pick up mocks
          const { checkAndIncrement } = await import('../../lambdas/shared/counters.mjs')

          const tenantRecord = { tier: 'pro', features: {}, serviceFlags: {} }
          const result = await checkAndIncrement({
            tenantId: 'test-tenant',
            counterName,
            tenantRecord,
            systemRecord: null,
          })

          if (count >= limit) {
            // Should be blocked
            expect(result.allowed).toBe(false)
            expect(result.reason).toBe('monthly_limit')
            expect(result.counter).toBe(counterName)
            expect(typeof result.resetDate).toBe('string')
            expect(result.resetDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          } else {
            // Should be allowed and incremented
            expect(result.allowed).toBe(true)
            // Verify UpdateItem was called (atomic increment)
            const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
            expect(updateCalls.length).toBeGreaterThanOrEqual(1)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})


/**
 * Property 2: Lazy Reset for Free Tier
 *
 * For any free tier tenant with periodStart in a previous calendar month,
 * needsLazyReset returns true. For periodStart in the current month,
 * needsLazyReset returns false. For non-free tiers, always returns false.
 *
 * Validates: Requirements 4.7, 4.8
 */
describe('Property P2: Lazy reset for free tier', () => {
  it('returns true for free tier with previous month periodStart', async () => {
    const { needsLazyReset } = await import('../../lambdas/shared/counters.mjs')

    await fc.assert(
      fc.property(
        previousMonthPeriodStart,
        (periodStart) => {
          expect(needsLazyReset('free', periodStart)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns false for free tier with current month periodStart', async () => {
    const { needsLazyReset } = await import('../../lambdas/shared/counters.mjs')

    await fc.assert(
      fc.property(
        currentMonthPeriodStart,
        (periodStart) => {
          expect(needsLazyReset('free', periodStart)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns false for non-free tiers regardless of periodStart', async () => {
    const { needsLazyReset } = await import('../../lambdas/shared/counters.mjs')

    const nonFreeTier = fc.constantFrom('individual', 'pro', 'enterprise', 'admin')
    const anyPeriodStart = fc.oneof(currentMonthPeriodStart, previousMonthPeriodStart)

    await fc.assert(
      fc.property(
        nonFreeTier,
        anyPeriodStart,
        (tier, periodStart) => {
          expect(needsLazyReset(tier, periodStart)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('returns true for free tier with null/undefined/invalid periodStart', async () => {
    const { needsLazyReset } = await import('../../lambdas/shared/counters.mjs')

    expect(needsLazyReset('free', null)).toBe(true)
    expect(needsLazyReset('free', undefined)).toBe(true)
    expect(needsLazyReset('free', 'not-a-date')).toBe(true)
  })
})

/**
 * calculateResetDate: returns first of next month from any valid periodStart.
 */
describe('calculateResetDate', () => {
  it('returns first of next month for any valid date', async () => {
    const { calculateResetDate } = await import('../../lambdas/shared/counters.mjs')

    await fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).map(d => d.toISOString().split('T')[0]),
        (periodStart) => {
          const result = calculateResetDate(periodStart)
          expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)

          const input = new Date(periodStart)
          const output = new Date(result)
          // Output should be after input
          expect(output.getTime()).toBeGreaterThan(input.getTime())
          // Output should be the 1st of a month
          expect(output.getUTCDate()).toBe(1)
        },
      ),
      { numRuns: 100 },
    )
  })
})
