// Unit tests for stripeWebhook Lambda handler
// Tests POST /api/webhooks/stripe — signature verification, event routing, idempotence.
// Validates: Requirements 6.1, 6.2, 6.3, 6.4

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
    maxActiveItems: tier === 'free' ? 1 : 10,
    maxSessionsPerItem: tier === 'free' ? 5 : 25,
    sessionTimeLimitMinutes: tier === 'free' ? 15 : 45,
    maxUploadSizeMb: tier === 'free' ? 10 : 25,
    maxPhotoSizeMb: tier === 'free' ? 5 : 15,
    maxDocumentPages: tier === 'free' ? 10 : 50,
    publicSessions: tier !== 'free',
    selfReview: tier !== 'free',
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: tier !== 'free',
    emailReminders: true,
    organizationsEnabled: false,
    maxOrgMembers: 0,
    monthlySessionsTotal: tier === 'free' ? 5 : 50,
    monthlyPublicSessionsTotal: tier === 'free' ? 0 : 20,
    monthlyItemsCreated: tier === 'free' ? 2 : 20,
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeApiEvent(body = '{}') {
  return {
    requestContext: { requestId: 'test-req' },
    headers: { 'Stripe-Signature': 'sig_test_valid' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

function makeStripeEvent(type, overrides = {}) {
  const base = {
    id: 'evt_test_123',
    type,
    created: 1700000100,
    data: { object: { customer: 'cus_test_123' } },
  }
  if (type === 'invoice.paid') {
    base.data.object.lines = { data: [{ metadata: { tier: 'pro' } }] }
    base.data.object.subscription_details = { metadata: { tier: 'pro' } }
  }
  if (type === 'customer.subscription.deleted') {
    // subscription object — customer is on the subscription
  }
  if (type === 'customer.subscription.updated') {
    base.data.object.metadata = { tier: 'enterprise' }
  }
  return { ...base, ...overrides }
}

function setupDefaultMocks(tenantId = 'tenant-abc', lastTs = null) {
  mockSend.mockImplementation((cmd) => {
    if (cmd._type === 'GetParameter') {
      return Promise.resolve({ Parameter: { Value: 'test-secret-key' } })
    }
    if (cmd._type === 'GetItem') {
      const item = { tenantId: { S: tenantId } }
      if (lastTs !== null) {
        item.lastStripeEventTimestamp = { N: String(lastTs) }
      }
      return Promise.resolve({ Item: item })
    }
    if (cmd._type === 'UpdateItem') {
      return Promise.resolve({})
    }
    if (cmd._type === 'Publish') {
      return Promise.resolve({})
    }
    return Promise.resolve({})
  })
  mockCustomerRetrieve.mockResolvedValue({ metadata: { tenantId } })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('stripeWebhook handler', () => {
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

  // 1. Invalid signature → returns 400
  it('returns 400 when constructEvent throws (invalid signature)', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    // SSM returns webhook secret
    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetParameter') {
        return Promise.resolve({ Parameter: { Value: 'whsec_test' } })
      }
      return Promise.resolve({})
    })

    mockConstructEvent.mockImplementation(() => {
      throw new Error('Invalid signature')
    })

    const result = await handler(makeApiEvent('{"test": true}'))

    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.error).toBe('Invalid signature')
  })

  // 2. invoice.paid — happy path
  it('invoice.paid updates tier, features, and zeroes counters', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('invoice.paid')
    mockConstructEvent.mockReturnValue(stripeEvent)
    setupDefaultMocks('tenant-abc')

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    // Verify UpdateItemCommand was called
    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    expect(updateCalls.length).toBe(1)

    const updateInput = updateCalls[0][0].input
    expect(updateInput.ExpressionAttributeValues[':tier']).toEqual({ S: 'pro' })
    expect(updateInput.ExpressionAttributeValues[':ts']).toEqual({ N: String(stripeEvent.created) })

    // Counters should be zeroed
    const counters = updateInput.ExpressionAttributeValues[':counters'].M
    expect(counters.monthlyItemsCreated.M.count).toEqual({ N: '0' })
    expect(counters.monthlySessionsTotal.M.count).toEqual({ N: '0' })
    expect(counters.monthlyPublicSessionsTotal.M.count).toEqual({ N: '0' })
  })

  // 3. customer.subscription.deleted — reverts to free tier
  it('customer.subscription.deleted reverts tenant to free tier', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('customer.subscription.deleted')
    mockConstructEvent.mockReturnValue(stripeEvent)
    setupDefaultMocks('tenant-abc')

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    expect(updateCalls.length).toBe(1)

    const updateInput = updateCalls[0][0].input
    expect(updateInput.ExpressionAttributeValues[':tier']).toEqual({ S: 'free' })
    // subscription.deleted does NOT zero counters — no :counters key
    expect(updateInput.UpdateExpression).not.toContain('usageCounters')
  })

  // 4. customer.subscription.updated — updates tier, does NOT reset counters
  it('customer.subscription.updated updates tier without resetting counters', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('customer.subscription.updated')
    mockConstructEvent.mockReturnValue(stripeEvent)
    setupDefaultMocks('tenant-abc')

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    expect(updateCalls.length).toBe(1)

    const updateInput = updateCalls[0][0].input
    expect(updateInput.ExpressionAttributeValues[':tier']).toEqual({ S: 'enterprise' })
    // subscription.updated does NOT zero counters
    expect(updateInput.UpdateExpression).not.toContain('usageCounters')
  })

  // 5. Out-of-order skip — event.created <= lastStripeEventTimestamp
  it('skips out-of-order event (event.created <= lastStripeEventTimestamp)', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('invoice.paid', { created: 1700000050 })
    mockConstructEvent.mockReturnValue(stripeEvent)
    // lastStripeEventTimestamp is NEWER than event.created
    setupDefaultMocks('tenant-abc', 1700000100)

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    // No UpdateItem should have been called
    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    expect(updateCalls.length).toBe(0)
  })

  // 6. Missing tenantId in customer metadata → returns 200, SNS alert published
  it('publishes SNS alert when customer metadata has no tenantId', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('invoice.paid')
    mockConstructEvent.mockReturnValue(stripeEvent)

    // Customer has no tenantId in metadata
    mockCustomerRetrieve.mockResolvedValue({ metadata: {} })
    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetParameter') {
        return Promise.resolve({ Parameter: { Value: 'test-secret-key' } })
      }
      if (cmd._type === 'Publish') {
        return Promise.resolve({})
      }
      return Promise.resolve({})
    })

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    // SNS PublishCommand should have been called
    const publishCalls = mockSend.mock.calls.filter(c => c[0]._type === 'Publish')
    expect(publishCalls.length).toBe(1)
    expect(publishCalls[0][0].input.TopicArn).toBe(process.env.ALERTS_TOPIC_ARN)

    // No UpdateItem should have been called
    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    expect(updateCalls.length).toBe(0)
  })

  // 7. Unknown event type → returns 200, no processing
  it('returns 200 for unknown event type without processing', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-stripeWebhook/index.mjs')

    const stripeEvent = makeStripeEvent('payment_intent.succeeded')
    mockConstructEvent.mockReturnValue(stripeEvent)

    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetParameter') {
        return Promise.resolve({ Parameter: { Value: 'test-secret-key' } })
      }
      return Promise.resolve({})
    })

    const result = await handler(makeApiEvent())

    expect(result.statusCode).toBe(200)

    // No UpdateItem, no GetItem (for tenant), no Publish
    const updateCalls = mockSend.mock.calls.filter(c => c[0]._type === 'UpdateItem')
    const getCalls = mockSend.mock.calls.filter(c => c[0]._type === 'GetItem')
    expect(updateCalls.length).toBe(0)
    expect(getCalls.length).toBe(0)
  })
})
