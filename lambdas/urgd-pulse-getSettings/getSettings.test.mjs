// Unit tests for urgd-pulse-getSettings
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand {
    constructor(input) { this.input = input }
  }
  class QueryCommand {
    constructor(input) { this.input = input }
  }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

const { handler } = await import('./index.mjs')

const TENANT_ITEM = {
  tenantId: { S: 'tenant-abc' },
  displayName: { S: 'Acme Corp' },
  email: { S: 'admin@acme.com' },
  tier: { S: 'free' },
  onboardingComplete: { BOOL: true },
  features: {
    M: {
      maxActiveItems: { N: '1' },
      maxSessionsPerItem: { N: '5' },
    },
  },
  usage: {
    M: {
      itemCount: { N: '0' },
      sessionCount: { N: '0' },
    },
  },
  preferences: {
    M: {
      theme: { S: 'dark' },
    },
  },
}

const makeEvent = (tenantId = 'tenant-abc') => ({
  headers: { origin: 'https://pulse.urgdstudios.com' },
  requestContext: {
    requestId: 'req-123',
    authorizer: { tenantId },
  },
})

describe('urgd-pulse-getSettings', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 200 with all required fields', async () => {
    sendSpy
      .mockResolvedValueOnce({ Item: TENANT_ITEM }) // GetItem tenant
      .mockResolvedValueOnce({ Count: 1 })           // Query items count
      .mockResolvedValueOnce({ Count: 3 })           // Query sessions count
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.tenantId).toBe('tenant-abc')
    expect(body.data.displayName).toBe('Acme Corp')
    expect(body.data.tier).toBe('free')
    expect(body.data.onboardingComplete).toBe(true)
    expect(body.data.features).toBeDefined()
    expect(body.data.usage).toBeDefined()
    expect(body.data.preferences).toBeDefined()
  })

  it('returns live usage counts from DynamoDB queries', async () => {
    sendSpy
      .mockResolvedValueOnce({ Item: TENANT_ITEM })
      .mockResolvedValueOnce({ Count: 2 }) // 2 active items
      .mockResolvedValueOnce({ Count: 7 }) // 7 sessions
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.usage.itemCount).toBe(2)
    expect(body.data.usage.sessionCount).toBe(7)
  })

  it('returns 404 when tenant not found', async () => {
    sendSpy
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce({ Count: 0 })
    const res = await handler(makeEvent('unknown-tenant'))
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).message).toMatch(/not found/i)
  })

  it('returns 401 when tenantId is missing from authorizer context', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: {} },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 401 when authorizer context is absent', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 500 on DynamoDB failure', async () => {
    sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(500)
  })

  it('returns null for missing optional fields (displayName, email, preferences)', async () => {
    const minimalItem = {
      tenantId: { S: 'tenant-min' },
      tier: { S: 'free' },
      onboardingComplete: { BOOL: false },
    }
    sendSpy
      .mockResolvedValueOnce({ Item: minimalItem })
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce({ Count: 0 })
    const res = await handler(makeEvent('tenant-min'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.displayName).toBeNull()
    expect(body.data.email).toBeNull()
    expect(body.data.preferences).toEqual({})
  })

  it('correctly unmarshals list and null DynamoDB types', async () => {
    const itemWithListAndNull = {
      tenantId: { S: 'tenant-list' },
      tier: { S: 'free' },
      onboardingComplete: { BOOL: false },
      // NULL type
      displayName: { NULL: true },
      // L (list) type — not used in current response but exercises unmarshal
      features: {
        M: {
          tags: { L: [{ S: 'tag1' }, { S: 'tag2' }] },
        },
      },
    }
    sendSpy
      .mockResolvedValueOnce({ Item: itemWithListAndNull })
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce({ Count: 0 })
    const res = await handler(makeEvent('tenant-list'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data.displayName).toBeNull()
    expect(body.data.features.tags).toEqual(['tag1', 'tag2'])
  })
})
