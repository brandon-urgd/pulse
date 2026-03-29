// Unit tests for register Lambda handler
// Tests POST /api/auth/register — SYSTEM publicSignup gate, Cognito flow, tier seeding.
// Validates: Requirements 4.1, 4.3, 4.5, 5.1, 5.2, 5.3

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTierDefaults } from '../../lambdas/shared/tiers.mjs'

// Mock DynamoDB and Cognito before importing handler
const mockSend = vi.fn()
const mockCognitoSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: class { constructor() { this.send = mockSend } },
    GetItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'GetItem' } },
    PutItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'PutItem' } },
  }
})

vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  return {
    CognitoIdentityProviderClient: class { constructor() { this.send = mockCognitoSend } },
    AdminCreateUserCommand: class { constructor(params) { Object.assign(this, params); this._type = 'AdminCreateUser' } },
  }
})

// Set env vars before importing handler
process.env.TENANTS_TABLE = 'test-tenants'
process.env.USER_POOL_ID = 'test-pool-id'
process.env.USER_POOL_CLIENT_ID = 'test-client-id'
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost'

const { handler } = await import('../../lambdas/urgd-pulse-register/index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'http://localhost' },
    requestContext: { requestId: 'test-req' },
    body: JSON.stringify({ name: 'Test User', email: '[email]@example.com' }),
    ...overrides,
  }
}

/** SYSTEM record with publicSignup in maintenance */
function systemMaintenance() {
  return {
    Item: {
      tenantId: { S: 'SYSTEM' },
      serviceFlags: {
        M: {
          publicSignup: { M: { status: { S: 'maintenance' } } },
        },
      },
    },
  }
}

/** SYSTEM record with publicSignup active */
function systemActive() {
  return {
    Item: {
      tenantId: { S: 'SYSTEM' },
      serviceFlags: {
        M: {
          publicSignup: { M: { status: { S: 'active' } } },
        },
      },
    },
  }
}

/** Mock Cognito AdminCreateUser success response */
function cognitoSuccess() {
  return {
    User: {
      Attributes: [
        { Name: 'sub', Value: 'new-tenant-id-123' },
        { Name: 'email', Value: '[email]@example.com' },
      ],
    },
  }
}

describe('register handler', () => {
  beforeEach(() => {
    mockSend.mockReset()
    mockCognitoSend.mockReset()
  })

  // Requirement 5.1 — SYSTEM publicSignup maintenance → 503 before Cognito
  it('returns 503 when SYSTEM publicSignup is maintenance (Cognito NOT called)', async () => {
    mockSend.mockResolvedValueOnce(systemMaintenance())

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(503)
    const body = JSON.parse(res.body)
    expect(body.message).toBe('Public sign-up is not available')
    // Cognito should NOT have been called
    expect(mockCognitoSend).not.toHaveBeenCalled()
  })

  // Requirement 5.2 — SYSTEM publicSignup active → proceeds with Cognito
  it('proceeds with registration when SYSTEM publicSignup is active', async () => {
    // GetItem for SYSTEM → active
    mockSend.mockResolvedValueOnce(systemActive())
    // Cognito → success
    mockCognitoSend.mockResolvedValueOnce(cognitoSuccess())
    // PutItem for tenant record → success
    mockSend.mockResolvedValueOnce({})

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(201)
    expect(mockCognitoSend).toHaveBeenCalledTimes(1)
  })

  // Requirement 5.3 — SYSTEM record missing → proceeds (fail-open)
  it('proceeds with registration when SYSTEM record is missing (fail-open)', async () => {
    // GetItem for SYSTEM → no item
    mockSend.mockResolvedValueOnce({ Item: undefined })
    // Cognito → success
    mockCognitoSend.mockResolvedValueOnce(cognitoSuccess())
    // PutItem for tenant record → success
    mockSend.mockResolvedValueOnce({})

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(201)
    expect(mockCognitoSend).toHaveBeenCalledTimes(1)
  })

  // Requirement 4.1, 4.5 — seeded features match getTierDefaults('free') with all 17 flags
  it('seeds new tenant with all 17 flags from getTierDefaults("free")', async () => {
    mockSend.mockResolvedValueOnce(systemActive())
    mockCognitoSend.mockResolvedValueOnce(cognitoSuccess())
    mockSend.mockResolvedValueOnce({})

    await handler(makeEvent())

    // The PutItem call is the second mockSend call (index 1)
    const putCall = mockSend.mock.calls[1][0]
    const featuresMap = putCall.Item.features.M

    const defaults = getTierDefaults('free')
    const defaultKeys = Object.keys(defaults)

    // All 17 flags must be present
    expect(defaultKeys.length).toBe(17)
    expect(Object.keys(featuresMap).length).toBe(17)

    for (const key of defaultKeys) {
      expect(featuresMap).toHaveProperty(key)
      const val = defaults[key]
      if (typeof val === 'boolean') {
        expect(featuresMap[key]).toEqual({ BOOL: val })
      } else if (typeof val === 'number') {
        expect(featuresMap[key]).toEqual({ N: String(val) })
      }
    }
  })
})
