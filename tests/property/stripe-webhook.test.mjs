// Feature: pulse-s2-s4-billing, Property 3: Webhook Idempotence
// Feature: pulse-s2-s4-billing, Property 4: Webhook Event Ordering
// Uses fast-check with vitest to verify webhook idempotence and event ordering.
// **Validates: Requirements 6.1, 6.2, 6.3**

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

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient { send(cmd) { return mockSend(cmd) } }
  class GetParameterCommand { constructor(input) { this.input = input; this._type = 'GetParameter' } }
  return { SSMClient, GetParameterCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(cmd) { return mockSend(cmd) } }
  class PublishCommand { constructor(input) { this.input = input; this._type = 'Publish' } }
  return { SNSClient, PublishCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

vi.mock('./shared/tiers.mjs', () => ({
  getTierDefaults: vi.fn((tier) => ({
    maxActiveItems: 10,
    maxSessionsPerItem: 25,
    sessionTimeLimitMinutes: 45,
    maxUploadSizeMb: 25,
    maxPhotoSizeMb: 15,
    maxDocumentPages: 50,
    publicSessions: true,
    selfReview: true,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: true,
    emailReminders: true,
    organizationsEnabled: false,
    maxOrgMembers: 0,
    monthlySessionsTotal: 50,
    monthlyPublicSessionsTotal: 20,
    monthlyItemsCreated: 20,
  })),
}))

const mockCustomerRetrieve = vi.fn()
const mockConstructEvent = vi.fn()

vi.mock('stripe', () => {
  return {
    default: class Stripe {
      constructor() {
        this.customers = { retrieve: mockCustomerRetrieve }
      }
      static webhooks = { constructEvent: mockConstructEvent }
    },
  }
})

// ── Generators ───────────────────────────────────────────────────────────────
const VALID_TIERS = ['free', 'individual', 'pro', 'enterprise']

const tierArb = fc.constantFrom(...VALID_TIERS)
const tenantIdArb = fc.uuid()
const timestampArb = fc.integer({ min: 1700000000, max: 1900000000 })

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * Property 3: Webhook Idempotence
 *
 * For any valid invoice.paid event with a tier and tenantId, processing the
 * event twice should produce the same DynamoDB UpdateItem call both times.
 *
 * Validates: Requirements 6.1, 6.2
 */
describe('Property P3: Webhook idempotence', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSend.mockReset()
    mockCustomerRetrieve.mockReset()
    mockConstructEvent.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
    process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:us-west-2:123456789:alerts'
    process.env.STRIPE_WEBHOOK_SECRET_PARAM = '/pulse/dev/stripe/webhook-secret'
    process.env.STRIPE_SECRET_KEY_PARAM = '/pulse/dev/stripe/secret-key'
  })

  it('processing the same event twice produces identical UpdateItem calls', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        tierArb,
        tenantIdArb,
        timestampArb,
        async (tier, tenantId, eventCreated) => {
          mockSend.mockReset()
          mockCustomerRetrieve.mockReset()
          mockConstructEvent.mockReset()

          const stripeEvent = {
            id: 'evt_test',
            type: 'invoice.paid',
            created: eventCreated,
            data: {
              object: {
                customer: 'cus_test',
                lines: { data: [{ metadata: { tier } }] },
                subscription_details: { metadata: { tier } },
              },
            },
          }

          // SSM returns secrets
          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetParameter') {
              return Promise.resolve({ Parameter: { Value: 'test-secret' } })
            }
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: {
                  tenantId: { S: tenantId },
                  lastStripeEventTimestamp: { N: String(eventCreated - 100) },
                },
              })
            }
            if (cmd._type === 'UpdateItem') {
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          mockConstructEvent.mockReturnValue(stripeEvent)
          mockCustomerRetrieve.mockResolvedValue({ metadata: { tenantId } })

          const apiEvent = {
            requestContext: { requestId: 'req-1' },
            headers: { 'Stripe-Signature': 'sig_test' },
            body: JSON.stringify(stripeEvent),
          }

          // Process event first time
          await handler(apiEvent)
          const firstUpdateCalls = mockSend.mock.calls
            .filter(c => c[0]._type === 'UpdateItem')
            .map(c => c[0].input.ExpressionAttributeValues)

          // Reset send mock but keep constructEvent and customerRetrieve
          mockSend.mockReset()
          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetParameter') {
              return Promise.resolve({ Parameter: { Value: 'test-secret' } })
            }
            if (cmd._type === 'GetItem') {
              return Promise.resolve({
                Item: {
                  tenantId: { S: tenantId },
                  lastStripeEventTimestamp: { N: String(eventCreated - 100) },
                },
              })
            }
            if (cmd._type === 'UpdateItem') {
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          // Process event second time
          await handler(apiEvent)
          const secondUpdateCalls = mockSend.mock.calls
            .filter(c => c[0]._type === 'UpdateItem')
            .map(c => c[0].input.ExpressionAttributeValues)

          // Both runs should produce UpdateItem calls with the same attribute values
          expect(firstUpdateCalls.length).toBe(1)
          expect(secondUpdateCalls.length).toBe(1)

          // Compare tier and timestamp values (skip updatedAt since it's time-dependent)
          const first = firstUpdateCalls[0]
          const second = secondUpdateCalls[0]
          expect(first[':tier']).toEqual(second[':tier'])
          expect(first[':ts']).toEqual(second[':ts'])
          expect(first[':features']).toEqual(second[':features'])
          expect(first[':counters']).toEqual(second[':counters'])
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 4: Webhook Event Ordering
 *
 * For any pair of events where event1.created < event2.created, if event2 is
 * processed first (setting lastStripeEventTimestamp), then event1 should be
 * skipped due to out-of-order detection.
 *
 * Validates: Requirements 6.3
 */
describe('Property P4: Webhook event ordering', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSend.mockReset()
    mockCustomerRetrieve.mockReset()
    mockConstructEvent.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
    process.env.ALERTS_TOPIC_ARN = 'arn:aws:sns:us-west-2:123456789:alerts'
    process.env.STRIPE_WEBHOOK_SECRET_PARAM = '/pulse/dev/stripe/webhook-secret'
    process.env.STRIPE_SECRET_KEY_PARAM = '/pulse/dev/stripe/secret-key'
  })

  it('older event is skipped when newer event was already processed', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        timestampArb,
        fc.integer({ min: 1, max: 10000 }),
        async (tenantId, ts1, delta) => {
          const ts2 = ts1 + delta // ts2 > ts1 always

          mockSend.mockReset()
          mockCustomerRetrieve.mockReset()
          mockConstructEvent.mockReset()

          mockCustomerRetrieve.mockResolvedValue({ metadata: { tenantId } })

          // Track UpdateItem calls
          let updateItemCallCount = 0

          // --- Process event2 first (newer event, no prior timestamp) ---
          const stripeEvent2 = {
            id: 'evt_newer',
            type: 'invoice.paid',
            created: ts2,
            data: {
              object: {
                customer: 'cus_test',
                lines: { data: [{ metadata: { tier: 'pro' } }] },
                subscription_details: { metadata: { tier: 'pro' } },
              },
            },
          }

          mockConstructEvent.mockReturnValue(stripeEvent2)
          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetParameter') {
              return Promise.resolve({ Parameter: { Value: 'test-secret' } })
            }
            if (cmd._type === 'GetItem') {
              // No prior timestamp — first event processed
              return Promise.resolve({ Item: { tenantId: { S: tenantId } } })
            }
            if (cmd._type === 'UpdateItem') {
              updateItemCallCount++
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          const apiEvent2 = {
            requestContext: { requestId: 'req-2' },
            headers: { 'Stripe-Signature': 'sig_test' },
            body: JSON.stringify(stripeEvent2),
          }

          const result2 = await handler(apiEvent2)
          expect(result2.statusCode).toBe(200)
          expect(updateItemCallCount).toBe(1) // event2 was processed

          // --- Now process event1 (older event, lastStripeEventTimestamp = ts2) ---
          const stripeEvent1 = {
            id: 'evt_older',
            type: 'invoice.paid',
            created: ts1,
            data: {
              object: {
                customer: 'cus_test',
                lines: { data: [{ metadata: { tier: 'pro' } }] },
                subscription_details: { metadata: { tier: 'pro' } },
              },
            },
          }

          mockConstructEvent.mockReturnValue(stripeEvent1)
          mockSend.mockReset()
          updateItemCallCount = 0

          mockSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetParameter') {
              return Promise.resolve({ Parameter: { Value: 'test-secret' } })
            }
            if (cmd._type === 'GetItem') {
              // lastStripeEventTimestamp is ts2 (newer event already processed)
              return Promise.resolve({
                Item: {
                  tenantId: { S: tenantId },
                  lastStripeEventTimestamp: { N: String(ts2) },
                },
              })
            }
            if (cmd._type === 'UpdateItem') {
              updateItemCallCount++
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          const apiEvent1 = {
            requestContext: { requestId: 'req-1' },
            headers: { 'Stripe-Signature': 'sig_test' },
            body: JSON.stringify(stripeEvent1),
          }

          const result1 = await handler(apiEvent1)
          expect(result1.statusCode).toBe(200)
          // event1 should be SKIPPED — no UpdateItem call
          expect(updateItemCallCount).toBe(0)
        },
      ),
      { numRuns: 100 },
    )
  })
})
