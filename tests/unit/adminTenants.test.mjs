// Unit tests for adminTenants Lambda handler
// Tests PATCH /api/admin/tenants/{tenantId} — tier updates, feature validation,
// SYSTEM record protection, and additive feature merge.
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.8

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DynamoDB before importing handler
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: class { constructor() { this.send = mockSend } },
    GetItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'GetItem' } },
    UpdateItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'UpdateItem' } },
  }
})

// Set env vars before importing handler
process.env.TENANTS_TABLE = 'test-tenants'
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost'

const { handler } = await import('../../lambdas/urgd-pulse-adminTenants/index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'http://localhost' },
    requestContext: { requestId: 'test-req', authorizer: { tenantId: 'admin-caller' } },
    pathParameters: { tenantId: 'test-tenant' },
    body: JSON.stringify({}),
    ...overrides,
  }
}

/** Helper: build a DynamoDB-marshalled tenant item */
function tenantItem(tenantId, tier = 'free') {
  return {
    tenantId: { S: tenantId },
    tier: { S: tier },
    features: { M: { maxActiveItems: { N: '1' } } },
    serviceFlags: { M: {} },
    updatedAt: { S: new Date().toISOString() },
  }
}

describe('adminTenants handler', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  // Requirement 7.1 — valid tier update → 200
  it('returns 200 for a valid tier update', async () => {
    // First GetItem → existing tenant
    mockSend.mockResolvedValueOnce({ Item: tenantItem('test-tenant', 'free') })
    // UpdateItem → success
    mockSend.mockResolvedValueOnce({})
    // Second GetItem → updated tenant
    mockSend.mockResolvedValueOnce({ Item: tenantItem('test-tenant', 'pro') })

    const event = makeEvent({ body: JSON.stringify({ tier: 'pro' }) })
    const res = await handler(event)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.tier).toBe('pro')
  })

  // Requirement 7.2 — invalid tier → 400
  it('returns 400 for an invalid tier', async () => {
    const event = makeEvent({ body: JSON.stringify({ tier: 'platinum' }) })
    const res = await handler(event)

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Invalid tier')
  })

  // Requirement 7.3 — invalid feature flag → 400
  it('returns 400 for an invalid feature flag', async () => {
    const event = makeEvent({ body: JSON.stringify({ features: { nonexistent: true } }) })
    const res = await handler(event)

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Invalid feature flag: nonexistent')
  })

  // Requirement 7.4 — SYSTEM record protection: tier/features → 400
  it('returns 400 when modifying tier on SYSTEM record', async () => {
    const event = makeEvent({
      pathParameters: { tenantId: 'SYSTEM' },
      body: JSON.stringify({ tier: 'pro' }),
    })
    const res = await handler(event)

    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Cannot modify tier/features on SYSTEM record')
  })

  // Requirement 7.5 — SYSTEM serviceFlags update → 200
  it('returns 200 when updating serviceFlags on SYSTEM record', async () => {
    const systemItem = {
      tenantId: { S: 'SYSTEM' },
      serviceFlags: { M: {} },
      updatedAt: { S: new Date().toISOString() },
    }
    // GetItem → SYSTEM exists
    mockSend.mockResolvedValueOnce({ Item: systemItem })
    // UpdateItem → success
    mockSend.mockResolvedValueOnce({})
    // Second GetItem → updated SYSTEM
    const updatedSystem = {
      ...systemItem,
      serviceFlags: { M: { publicSignup: { M: { status: { S: 'maintenance' } } } } },
    }
    mockSend.mockResolvedValueOnce({ Item: updatedSystem })

    const event = makeEvent({
      pathParameters: { tenantId: 'SYSTEM' },
      body: JSON.stringify({ serviceFlags: { publicSignup: { status: 'maintenance' } } }),
    })
    const res = await handler(event)

    expect(res.statusCode).toBe(200)
  })

  // Requirement 7.6 — tenant not found → 404
  it('returns 404 when tenant does not exist', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })

    const event = makeEvent({ body: JSON.stringify({ tier: 'pro' }) })
    const res = await handler(event)

    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Tenant not found')
  })

  // Requirement 7.8 — feature merge preserves existing overrides
  it('uses per-field SET for feature merge (not full replace)', async () => {
    mockSend.mockResolvedValueOnce({ Item: tenantItem('test-tenant', 'free') })
    mockSend.mockResolvedValueOnce({})
    mockSend.mockResolvedValueOnce({ Item: tenantItem('test-tenant', 'free') })

    const event = makeEvent({
      body: JSON.stringify({ features: { maxActiveItems: 5 } }),
    })
    await handler(event)

    // The UpdateItemCommand call is the second mockSend call
    const updateCall = mockSend.mock.calls[1][0]
    const updateExpr = updateCall.UpdateExpression
    // Should use per-field SET like #features.#feat_maxActiveItems = :feat_maxActiveItems
    expect(updateExpr).toContain('#features.#feat_maxActiveItems')
    // Should NOT contain a full features replace like '#features = :features'
    expect(updateExpr).not.toMatch(/#features\s*=\s*:features/)
  })
})
