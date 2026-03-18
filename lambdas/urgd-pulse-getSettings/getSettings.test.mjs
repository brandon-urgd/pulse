// Unit tests for urgd-pulse-getSettings
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
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
  return { DynamoDBClient, GetItemCommand }
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
    sendSpy.mockResolvedValue({ Item: TENANT_ITEM })
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.tenantId).toBe('tenant-abc')
    expect(body.displayName).toBe('Acme Corp')
    expect(body.tier).toBe('free')
    expect(body.onboardingComplete).toBe(true)
    expect(body.features).toBeDefined()
    expect(body.usage).toBeDefined()
    expect(body.preferences).toBeDefined()
  })

  it('returns 404 when tenant not found', async () => {
    sendSpy.mockResolvedValue({ Item: undefined })
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
    sendSpy.mockResolvedValue({ Item: minimalItem })
    const res = await handler(makeEvent('tenant-min'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.displayName).toBeNull()
    expect(body.email).toBeNull()
    expect(body.preferences).toEqual({})
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
    sendSpy.mockResolvedValue({ Item: itemWithListAndNull })
    const res = await handler(makeEvent('tenant-list'))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.displayName).toBeNull()
    expect(body.features.tags).toEqual(['tag1', 'tag2'])
  })
})
