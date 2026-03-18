// Unit tests for urgd-pulse-getItems (S1 stub)
import { describe, it, expect, vi } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const { handler } = await import('./index.mjs')

const makeEvent = (tenantId = 'tenant-abc') => ({
  headers: { origin: 'https://pulse.urgdstudios.com' },
  requestContext: {
    requestId: 'req-123',
    authorizer: { tenantId },
  },
})

describe('urgd-pulse-getItems (S1 stub)', () => {
  it('returns 200 with empty data array', async () => {
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.data).toEqual([])
  })

  it('returns 401 when tenantId is missing', async () => {
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

  it('response has Content-Type application/json', async () => {
    const res = await handler(makeEvent())
    expect(res.headers['Content-Type']).toBe('application/json')
  })

  it('data array is always empty in S1 stub regardless of tenantId', async () => {
    const res1 = await handler(makeEvent('tenant-1'))
    const res2 = await handler(makeEvent('tenant-2'))
    expect(JSON.parse(res1.body).data).toEqual([])
    expect(JSON.parse(res2.body).data).toEqual([])
  })
})
