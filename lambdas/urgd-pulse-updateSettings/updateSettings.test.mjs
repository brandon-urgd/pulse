// Unit tests for urgd-pulse-updateSettings
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class UpdateItemCommand {
    constructor(input) { this.input = input }
  }
  return { DynamoDBClient, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

const makeEvent = (body, tenantId = 'tenant-abc') => ({
  headers: { origin: 'https://pulse.urgdstudios.com' },
  requestContext: {
    requestId: 'req-123',
    authorizer: { tenantId },
  },
  body: JSON.stringify(body),
})

describe('urgd-pulse-updateSettings', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 200 when updating displayName', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ displayName: 'New Name' }))
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toBe('Settings updated')
  })

  it('returns 200 for valid theme: light', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ preferences: { theme: 'light' } }))
    expect(res.statusCode).toBe(200)
  })

  it('returns 200 for valid theme: dark', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ preferences: { theme: 'dark' } }))
    expect(res.statusCode).toBe(200)
  })

  it('returns 200 for valid theme: system', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ preferences: { theme: 'system' } }))
    expect(res.statusCode).toBe(200)
  })

  it('returns 400 for invalid theme value', async () => {
    const res = await handler(makeEvent({ preferences: { theme: 'solarized' } }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/theme must be one of/i)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('returns 400 for empty string theme', async () => {
    const res = await handler(makeEvent({ preferences: { theme: '' } }))
    expect(res.statusCode).toBe(400)
  })

  it('returns 401 when tenantId is missing', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: {} },
      body: JSON.stringify({ displayName: 'Test' }),
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-123', authorizer: { tenantId: 'tenant-abc' } },
      body: '{bad json',
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 500 on DynamoDB failure', async () => {
    sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
    const res = await handler(makeEvent({ displayName: 'Test' }))
    expect(res.statusCode).toBe(500)
  })

  it('accepts empty body (no-op update) without error', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({}))
    expect(res.statusCode).toBe(200)
  })
})
