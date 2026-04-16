// Property-based tests for getSettings Lambda (P14)
// Uses fast-check with vitest to verify usageCounters inclusion.
// **Validates: Requirements 11.1**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Mock AWS SDK ─────────────────────────────────────────────────────────────
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockSend(cmd) } }
  class BatchGetItemCommand { constructor(input) { this.input = input; this._type = 'BatchGetItem' } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  return { DynamoDBClient, BatchGetItemCommand, QueryCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: (code, data, headers, origin) => ({
    statusCode: code,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  }),
  errorResponse: (code, msg, details, origin) => ({
    statusCode: code,
    body: JSON.stringify({ error: true, message: msg }),
    headers: { 'Content-Type': 'application/json' },
  }),
}))

vi.mock('./shared/features.mjs', () => ({
  resolveAllFeatures: vi.fn(() => ({})),
}))

// ── Generators ───────────────────────────────────────────────────────────────
const counterArb = fc.record({
  count: fc.nat({ max: 1000 }),
  periodStart: fc.date({ min: new Date('2024-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z') }).map(d => d.toISOString()),
})

const usageCountersArb = fc.oneof(
  // With usageCounters
  fc.record({
    monthlyItemsCreated: counterArb,
    monthlySessionsTotal: counterArb,
    monthlyPublicSessionsTotal: counterArb,
  }).map(counters => ({ hasCounters: true, counters })),
  // Without usageCounters
  fc.constant({ hasCounters: false, counters: null }),
)


/**
 * Property 14: getSettings Includes Usage Counters
 *
 * For any tenant record that has a usageCounters map, the getSettings response
 * SHALL include the usageCounters field with all counter entries. For any tenant
 * record without usageCounters, the response SHALL include an empty usageCounters object.
 *
 * Validates: Requirements 11.1
 */
describe('Property P14: getSettings includes usageCounters', () => {
  beforeEach(() => {
    mockSend.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
    process.env.ITEMS_TABLE = 'items'
    process.env.SESSIONS_TABLE = 'sessions'
    process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
  })

  it('response includes usageCounters field for tenants with and without counters', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-getSettings/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        usageCountersArb,
        async (tenantId, usageData) => {
          // Build tenant DynamoDB item
          const tenantItem = {
            tenantId: { S: tenantId },
            tier: { S: 'free' },
            onboardingComplete: { BOOL: false },
          }

          if (usageData.hasCounters) {
            tenantItem.usageCounters = {
              M: {
                monthlyItemsCreated: {
                  M: {
                    count: { N: String(usageData.counters.monthlyItemsCreated.count) },
                    periodStart: { S: usageData.counters.monthlyItemsCreated.periodStart },
                  },
                },
                monthlySessionsTotal: {
                  M: {
                    count: { N: String(usageData.counters.monthlySessionsTotal.count) },
                    periodStart: { S: usageData.counters.monthlySessionsTotal.periodStart },
                  },
                },
                monthlyPublicSessionsTotal: {
                  M: {
                    count: { N: String(usageData.counters.monthlyPublicSessionsTotal.count) },
                    periodStart: { S: usageData.counters.monthlyPublicSessionsTotal.periodStart },
                  },
                },
              },
            }
          }

          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'BatchGetItem') {
              return Promise.resolve({
                Responses: {
                  [process.env.TENANTS_TABLE]: [tenantItem],
                },
              })
            }
            if (cmd._type === 'Query') {
              return Promise.resolve({ Count: 0 })
            }
            return Promise.resolve({})
          })

          const event = {
            headers: { origin: 'https://pulse.urgd.dev' },
            requestContext: {
              requestId: 'test-req',
              authorizer: { tenantId },
            },
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)

          // usageCounters field must always be present
          expect(body.data).toHaveProperty('usageCounters')

          if (usageData.hasCounters) {
            // Should contain the counter values
            expect(body.data.usageCounters).toHaveProperty('monthlyItemsCreated')
            expect(body.data.usageCounters.monthlyItemsCreated.count).toBe(
              usageData.counters.monthlyItemsCreated.count,
            )
            expect(body.data.usageCounters).toHaveProperty('monthlySessionsTotal')
            expect(body.data.usageCounters).toHaveProperty('monthlyPublicSessionsTotal')
          } else {
            // Should be empty object
            expect(body.data.usageCounters).toEqual({})
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
