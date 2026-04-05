// Unit tests for createCheckoutSession Lambda handler
// Tests POST /api/manage/checkout — Stripe Checkout and Billing Portal sessions.
// Validates: Requirements 7.1, 7.2, 7.3

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock AWS SDK ─────────────────────────────────────────────────────────────
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient { send(cmd) { return mockSend(cmd) } }
  class GetParameterCommand { constructor(input) { this.input = input; this._type = 'GetParameter' } }
  return { SSMClient, GetParameterCommand }
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
    body: JSON.stringify({ error: true, message: msg, ...details }),
    headers: { 'Content-Type': 'application/json' },
  }),
}))

const mockCheckoutCreate = vi.fn()
const mockPortalCreate = vi.fn()

vi.mock('stripe', () => {
  return {
    default: class Stripe {
      constructor() {
        this.checkout = { sessions: { create: mockCheckoutCreate } }
        this.billingPortal = { sessions: { create: mockPortalCreate } }
      }
    },
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(bodyOverrides = {}, authOverrides = {}) {
  const body = { action: 'checkout', priceId: 'pro', ...bodyOverrides }
  return {
    headers: { origin: 'https://pulse.urgd.dev' },
    requestContext: {
      requestId: 'test-req',
      authorizer: { tenantId: 'test-tenant', ...authOverrides },
    },
    body: JSON.stringify(body),
  }
}

function setupDefaultMocks(stripeCustomerId = 'cus_test_123') {
  mockSend.mockImplementation((cmd) => {
    if (cmd._type === 'GetParameter') {
      return Promise.resolve({ Parameter: { Value: 'test-value' } })
    }
    if (cmd._type === 'GetItem') {
      const item = { tenantId: { S: 'test-tenant' } }
      if (stripeCustomerId) {
        item.stripeCustomerId = { S: stripeCustomerId }
      }
      return Promise.resolve({ Item: item })
    }
    return Promise.resolve({})
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createCheckoutSession handler', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSend.mockReset()
    mockCheckoutCreate.mockReset()
    mockPortalCreate.mockReset()
    process.env.TENANTS_TABLE = 'tenants'
    process.env.STRIPE_SECRET_KEY_PARAM = '/pulse/dev/stripe/secret-key'
    process.env.STRIPE_PRICE_INDIVIDUAL_PARAM = '/pulse/dev/stripe/price-individual'
    process.env.STRIPE_PRICE_PRO_PARAM = '/pulse/dev/stripe/price-pro'
    process.env.STRIPE_PRICE_ENTERPRISE_PARAM = '/pulse/dev/stripe/price-enterprise'
    process.env.PLAN_PAGE_URL = 'https://pulse.urgd.dev/admin/plan'
    process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgd.dev'
  })

  // 1. Checkout — happy path
  it('checkout action creates Stripe Checkout Session and returns URL', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    setupDefaultMocks('cus_test_123')
    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/session_abc' })

    const result = await handler(makeEvent({ action: 'checkout', priceId: 'pro' }))

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data.url).toBe('https://checkout.stripe.com/session_abc')
    expect(mockCheckoutCreate).toHaveBeenCalledTimes(1)

    // Verify checkout session params
    const createArgs = mockCheckoutCreate.mock.calls[0][0]
    expect(createArgs.customer).toBe('cus_test_123')
    expect(createArgs.mode).toBe('subscription')
    expect(createArgs.line_items[0].quantity).toBe(1)
  })

  // 2. Portal — happy path
  it('portal action creates Billing Portal session and returns URL', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    setupDefaultMocks('cus_test_123')
    mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/portal_abc' })

    const result = await handler(makeEvent({ action: 'portal' }))

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data.url).toBe('https://billing.stripe.com/portal_abc')
    expect(mockPortalCreate).toHaveBeenCalledTimes(1)

    // Verify portal session params
    const createArgs = mockPortalCreate.mock.calls[0][0]
    expect(createArgs.customer).toBe('cus_test_123')
    expect(createArgs.return_url).toBe(process.env.PLAN_PAGE_URL)
  })

  // 3. Missing stripeCustomerId → returns 400 with reason
  it('returns 400 with reason no_stripe_customer when tenant has no stripeCustomerId', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    // Tenant record without stripeCustomerId
    setupDefaultMocks(null)

    const result = await handler(makeEvent({ action: 'checkout', priceId: 'pro' }))

    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.reason).toBe('no_stripe_customer')
  })

  // 4. Invalid action → returns 400
  it('returns 400 for invalid action', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    const result = await handler(makeEvent({ action: 'invalid' }))

    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.error).toBe(true)
  })

  // 5. Missing priceId for checkout → returns 400
  it('returns 400 when checkout action has no priceId', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    const event = {
      headers: { origin: 'https://pulse.urgd.dev' },
      requestContext: { requestId: 'test-req', authorizer: { tenantId: 'test-tenant' } },
      body: JSON.stringify({ action: 'checkout' }),
    }

    const result = await handler(event)

    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.error).toBe(true)
  })

  // 6. Invalid priceId → returns 400
  it('returns 400 for invalid priceId', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    const result = await handler(makeEvent({ action: 'checkout', priceId: 'platinum' }))

    expect(result.statusCode).toBe(400)
    const body = JSON.parse(result.body)
    expect(body.error).toBe(true)
  })

  // 7. Missing tenantId → returns 401
  it('returns 401 when tenantId is missing from authorizer context', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-createCheckoutSession/index.mjs')

    const event = {
      headers: { origin: 'https://pulse.urgd.dev' },
      requestContext: { requestId: 'test-req', authorizer: {} },
      body: JSON.stringify({ action: 'checkout', priceId: 'pro' }),
    }

    const result = await handler(event)

    expect(result.statusCode).toBe(401)
    const body = JSON.parse(result.body)
    expect(body.error).toBe(true)
  })
})
