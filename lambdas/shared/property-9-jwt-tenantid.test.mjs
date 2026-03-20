// Feature: pulse, Property 9: JWT tenantId Extraction Invariant
// Validates: Requirements 3.10, 9.3, 9.5
//
// For any authenticated API request, the tenantId used for DynamoDB queries is
// extracted from the Cognito JWT authorizer context, never from request path or
// body. A JWT for tenant A cannot access data for tenant B.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Shared send spy + key capture ─────────────────────────────────────────────
const sendSpy = vi.fn()
let lastGetItemKey = null

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand {
    constructor(input) {
      lastGetItemKey = input.Key
      this.input = input
    }
  }
  class QueryCommand {
    constructor(input) { this.input = input }
  }
  class UpdateItemCommand {
    constructor(input) { this.input = input }
  }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand }
})

const { handler: getSettings } = await import('../urgd-pulse-getSettings/index.mjs')
const { handler: getItems } = await import('../urgd-pulse-getItems/index.mjs')

// ── Arbitraries ───────────────────────────────────────────────────────────────
// Use distinct UUIDs by generating two and filtering for inequality
const twoDifferentUuids = fc.tuple(fc.uuid(), fc.uuid()).filter(([a, b]) => a !== b)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 9: JWT tenantId Extraction Invariant', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    lastGetItemKey = null
  })

  it('getSettings uses tenantId from authorizer context, not from request body', async () => {
    await fc.assert(
      fc.asyncProperty(twoDifferentUuids, async ([authTenantId, bodyTenantId]) => {
        lastGetItemKey = null
        sendSpy.mockResolvedValue({ Item: undefined })

        await getSettings({
          headers: { origin: 'https://pulse.urgdstudios.com' },
          requestContext: {
            requestId: 'req-test',
            authorizer: { tenantId: authTenantId },
          },
          // Body contains a different tenantId — must be ignored
          body: JSON.stringify({ tenantId: bodyTenantId }),
        })

        // The DynamoDB key must use the authorizer tenantId, not the body one
        expect(lastGetItemKey?.tenantId?.S).toBe(authTenantId)
        expect(lastGetItemKey?.tenantId?.S).not.toBe(bodyTenantId)
      }),
      { numRuns: 100 }
    )
  })

  it('getSettings with no authorizer tenantId returns 401 without querying DynamoDB', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (bodyTenantId) => {
        sendSpy.mockResolvedValue({})

        const res = await getSettings({
          headers: { origin: 'https://pulse.urgdstudios.com' },
          requestContext: { requestId: 'req-test', authorizer: {} },
          body: JSON.stringify({ tenantId: bodyTenantId }),
        })

        expect(res.statusCode).toBe(401)
        expect(sendSpy).not.toHaveBeenCalled()
      }),
      { numRuns: 100 }
    )
  })

  it('getItems with no authorizer tenantId returns 401 without querying DynamoDB', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (bodyTenantId) => {
        sendSpy.mockResolvedValue({})

        const res = await getItems({
          headers: { origin: 'https://pulse.urgdstudios.com' },
          requestContext: { requestId: 'req-test', authorizer: {} },
          body: JSON.stringify({ tenantId: bodyTenantId }),
        })

        expect(res.statusCode).toBe(401)
        expect(sendSpy).not.toHaveBeenCalled()
      }),
      { numRuns: 100 }
    )
  })

  it('tenant A authorizer context cannot retrieve tenant B data', async () => {
    await fc.assert(
      fc.asyncProperty(twoDifferentUuids, async ([tenantA, tenantB]) => {
        lastGetItemKey = null
        // Simulate tenant B's record exists in DynamoDB
        sendSpy.mockResolvedValue({ Item: { tenantId: { S: tenantB } } })

        await getSettings({
          headers: { origin: 'https://pulse.urgdstudios.com' },
          requestContext: {
            requestId: 'req-test',
            authorizer: { tenantId: tenantA },
          },
        })

        // DynamoDB was queried with tenantA's key — not tenantB's
        expect(lastGetItemKey?.tenantId?.S).toBe(tenantA)
      }),
      { numRuns: 100 }
    )
  })
})
