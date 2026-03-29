// Unit tests for publicConfig Lambda handler
// Tests GET /api/public/config — SYSTEM record signup state, fail-open behavior.
// Validates: Requirements 8.1, 8.2, 8.4

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock DynamoDB before importing handler
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: class { constructor() { this.send = mockSend } },
    GetItemCommand: class { constructor(params) { Object.assign(this, params); this._type = 'GetItem' } },
  }
})

// Set env vars before importing handler
process.env.TENANTS_TABLE = 'test-tenants'
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost'

const { handler } = await import('../../lambdas/urgd-pulse-publicConfig/index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'http://localhost' },
    requestContext: { requestId: 'test-req' },
    ...overrides,
  }
}

describe('publicConfig handler', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  // Requirement 8.1 — SYSTEM record with active signup → allowed: true
  it('returns publicSignup allowed when SYSTEM has active status', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        tenantId: { S: 'SYSTEM' },
        serviceFlags: {
          M: {
            publicSignup: { M: { status: { S: 'active' } } },
          },
        },
      },
    })

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.publicSignup).toEqual({ allowed: true, reason: 'allowed' })
  })

  // Requirement 8.4 — SYSTEM record with maintenance signup → allowed: false
  it('returns publicSignup not allowed when SYSTEM has maintenance status', async () => {
    mockSend.mockResolvedValueOnce({
      Item: {
        tenantId: { S: 'SYSTEM' },
        serviceFlags: {
          M: {
            publicSignup: { M: { status: { S: 'maintenance' } } },
          },
        },
      },
    })

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.publicSignup).toEqual({ allowed: false, reason: 'maintenance' })
  })

  // Requirement 8.2 — SYSTEM record missing → fail-open (allowed: true)
  it('returns publicSignup allowed when SYSTEM record is missing (fail-open)', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined })

    const res = await handler(makeEvent())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.publicSignup).toEqual({ allowed: true, reason: 'allowed' })
  })
})
