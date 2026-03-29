// Unit tests for getSettings Lambda handler
// Tests GET /api/manage/settings — enrichedFeatures, BatchGetItem usage, SYSTEM missing.
// Validates: Requirements 6.1, 6.2, 6.3, 6.4

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VALID_FLAGS } from '../../lambdas/shared/tiers.mjs'

// Mock DynamoDB before importing handler
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: class { constructor() { this.send = mockSend } },
    BatchGetItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'BatchGetItem' } },
    QueryCommand: class { constructor(params) { Object.assign(this, params); this._type = 'Query' } },
  }
})

// Set env vars before importing handler
process.env.TENANTS_TABLE = 'test-tenants'
process.env.ITEMS_TABLE = 'test-items'
process.env.SESSIONS_TABLE = 'test-sessions'
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost'

const { handler } = await import('../../lambdas/urgd-pulse-getSettings/index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'http://localhost' },
    requestContext: { requestId: 'test-req', authorizer: { tenantId: 'test-tenant' } },
    ...overrides,
  }
}

/** Build a DynamoDB-marshalled tenant record with free tier features */
function tenantRecord(tenantId = 'test-tenant') {
  return {
    tenantId: { S: tenantId },
    tier: { S: 'free' },
    displayName: { S: 'Test User' },
    email: { S: '[email]@example.com' },
    onboardingComplete: { BOOL: false },
    features: {
      M: {
        maxActiveItems: { N: '1' },
        maxSessionsPerItem: { N: '5' },
        sessionTimeLimitMinutes: { N: '15' },
        maxUploadSizeMb: { N: '10' },
        maxPhotoSizeMb: { N: '5' },
        maxDocumentPages: { N: '10' },
        publicSessions: { BOOL: false },
        selfReview: { BOOL: false },
        pulseCheck: { BOOL: true },
        aiReports: { BOOL: true },
        itemRevisionLoop: { BOOL: false },
        emailReminders: { BOOL: true },
        organizationsEnabled: { BOOL: false },
        maxOrgMembers: { N: '0' },
        monthlySessionsTotal: { N: '5' },
        monthlyPublicSessionsTotal: { N: '0' },
        monthlyItemsCreated: { N: '2' },
      },
    },
    serviceFlags: { M: {} },
  }
}

/** Build a DynamoDB-marshalled SYSTEM record */
function systemRecord() {
  return {
    tenantId: { S: 'SYSTEM' },
    serviceFlags: {
      M: {
        publicSignup: { M: { status: { S: 'active' } } },
      },
    },
  }
}

describe('getSettings handler', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  // Requirement 6.2, 6.3 — returns enrichedFeatures with all 17 flags resolved
  it('returns enrichedFeatures with all 17 flags resolved', async () => {
    // BatchGetItem → tenant + SYSTEM
    mockSend.mockResolvedValueOnce({
      Responses: {
        'test-tenants': [tenantRecord(), systemRecord()],
      },
    })
    // Query for items count
    mockSend.mockResolvedValueOnce({ Count: 0 })
    // Query for sessions count
    mockSend.mockResolvedValueOnce({ Count: 0 })

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.enrichedFeatures).toBeDefined()

    const enrichedKeys = Object.keys(body.data.enrichedFeatures)
    expect(enrichedKeys.length).toBe(17)

    for (const flag of VALID_FLAGS) {
      const entry = body.data.enrichedFeatures[flag]
      expect(typeof entry.allowed).toBe('boolean')
      expect(typeof entry.reason).toBe('string')
      expect(entry.limit === null || typeof entry.limit === 'number').toBe(true)
    }
  })

  // Requirement 6.4 — SYSTEM record missing → enrichedFeatures still populated
  it('returns enrichedFeatures when SYSTEM record is missing', async () => {
    // BatchGetItem → only tenant, no SYSTEM
    mockSend.mockResolvedValueOnce({
      Responses: {
        'test-tenants': [tenantRecord()],
      },
    })
    // Query for items count
    mockSend.mockResolvedValueOnce({ Count: 0 })
    // Query for sessions count
    mockSend.mockResolvedValueOnce({ Count: 0 })

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.enrichedFeatures).toBeDefined()
    expect(Object.keys(body.data.enrichedFeatures).length).toBe(17)
  })

  // Requirement 6.1 — verify BatchGetItem is used (not individual GetItems)
  it('uses BatchGetItem to fetch tenant and SYSTEM in a single call', async () => {
    mockSend.mockResolvedValueOnce({
      Responses: {
        'test-tenants': [tenantRecord(), systemRecord()],
      },
    })
    mockSend.mockResolvedValueOnce({ Count: 0 })
    mockSend.mockResolvedValueOnce({ Count: 0 })

    await handler(makeEvent())

    // First call should be BatchGetItem (check the _type marker from our mock)
    const firstCall = mockSend.mock.calls[0][0]
    expect(firstCall._type).toBe('BatchGetItem')
    expect(firstCall.RequestItems).toBeDefined()
  })
})
