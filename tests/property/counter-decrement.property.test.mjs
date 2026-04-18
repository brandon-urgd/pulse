// Feature: async-revision-generation, Property 7: decrementCounter clamps at zero
// Uses fast-check with vitest to verify decrementCounter clamping and drift warning behavior.
// **Validates: Requirements 10.4, 10.5**

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

const mockLog = vi.fn()

vi.mock('./shared/utils.mjs', () => ({
  log: (...args) => mockLog(...args),
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

// currentCount: natural number (>= 0), capped to keep tests fast
const currentCountArb = fc.nat({ max: 1000 })

// amount: natural number >= 1, capped to keep tests fast
const amountArb = fc.integer({ min: 1, max: 1000 })

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * Property 7: decrementCounter clamps at zero and warns on drift
 *
 * For any current counter value c (where c >= 0) and any decrement amount a
 * (where a >= 1), after calling decrementCounter, the resulting counter value
 * should equal max(0, c - a). Additionally, if a > c, a drift warning should
 * be logged.
 *
 * **Validates: Requirements 10.4, 10.5**
 */
describe('Feature: async-revision-generation, Property 7: decrementCounter clamps at zero', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSend.mockReset()
    mockLog.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
  })

  it('resulting count equals max(0, currentCount - amount) and drift warning logged when amount > currentCount', async () => {
    const { decrementCounter } = await import('../../lambdas/shared/counters.mjs')

    await fc.assert(
      fc.asyncProperty(
        counterNameArb,
        currentCountArb,
        amountArb,
        async (counterName, currentCount, amount) => {
          // Reset mocks for each iteration
          mockSend.mockReset()
          mockLog.mockReset()

          const isDrift = amount > currentCount

          // The new implementation tries an atomic conditional UpdateItem first.
          // - Normal path (counter >= amount): UpdateItem succeeds.
          // - Drift path (counter < amount): UpdateItem throws ConditionalCheckFailedException,
          //   then falls back to GetItem + SET to zero.
          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'UpdateItem') {
              if (cmd.input.ConditionExpression && isDrift) {
                // Simulate DynamoDB rejecting the condition (counter < amount)
                const err = new Error('The conditional request failed')
                err.name = 'ConditionalCheckFailedException'
                return Promise.reject(err)
              }
              return Promise.resolve({})
            }
            if (cmd._type === 'GetItem') {
              // Only reached in the drift fallback path
              return Promise.resolve({
                Item: {
                  tenantId: { S: 'test-tenant' },
                  usageCounters: {
                    M: {
                      [counterName]: {
                        M: {
                          count: { N: String(currentCount) },
                          periodStart: { S: '2026-01-01' },
                        },
                      },
                    },
                  },
                },
              })
            }
            return Promise.resolve({})
          })

          const result = await decrementCounter({
            tenantId: 'test-tenant',
            counterName,
            amount,
          })

          const expectedCount = Math.max(0, currentCount - amount)

          // Verify success
          expect(result.success).toBe(true)

          if (isDrift) {
            // Drift case: should clamp to 0
            expect(result.newCount).toBe(0)

            // Verify the fallback SET to zero was called
            const updateCalls = mockSend.mock.calls.filter(
              c => c[0]._type === 'UpdateItem' && !c[0].input.ConditionExpression,
            )
            expect(updateCalls.length).toBe(1)
            const updateInput = updateCalls[0][0].input
            expect(updateInput.UpdateExpression).toContain('SET')
            expect(updateInput.ExpressionAttributeValues[':zero']).toEqual({ N: '0' })

            // Verify drift warning was logged
            const warnCalls = mockLog.mock.calls.filter(c => c[0] === 'warn')
            expect(warnCalls.length).toBeGreaterThanOrEqual(1)
            const driftWarn = warnCalls.find(c =>
              typeof c[1] === 'string' && c[1].includes('drift')
            )
            expect(driftWarn).toBeDefined()
          } else {
            // Normal case: atomic conditional ADD succeeded — no newCount returned
            // (the atomic path doesn't read the value, so newCount is not set)
            expect(result.newCount).toBeUndefined()

            // Verify the conditional UpdateItem was called with ADD
            const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
            expect(updateCalls.length).toBe(1)
            const updateInput = updateCalls[0][0].input
            expect(updateInput.UpdateExpression).toContain('ADD')
            expect(updateInput.ConditionExpression).toBeDefined()
            expect(updateInput.ExpressionAttributeValues[':neg']).toEqual({ N: String(-amount) })

            // No drift warning should be logged
            const warnCalls = mockLog.mock.calls.filter(c => c[0] === 'warn')
            const driftWarn = warnCalls.find(c =>
              typeof c[1] === 'string' && c[1].includes('drift')
            )
            expect(driftWarn).toBeUndefined()
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
