// Unit tests — Terms acceptance fields in updateSettings / getSettings
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── DynamoDB mock ──────────────────────────────────────────────────────────
const mockSend = vi.fn()
vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockSend(cmd) } }
  class UpdateItemCommand { constructor(input) { this._input = input } }
  class GetItemCommand { constructor(input) { this._input = input } }
  class QueryCommand { constructor(input) { this._input = input } }
  class BatchGetItemCommand { constructor(input) { this._input = input } }
  return { DynamoDBClient, UpdateItemCommand, GetItemCommand, QueryCommand, BatchGetItemCommand }
})

// Mock features module used by getSettings handler
vi.mock('./shared/features.mjs', () => ({
  resolveAllFeatures: vi.fn(() => ({})),
}))

// ── Env setup ──────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  process.env.TENANTS_TABLE = 'test-tenants'
  process.env.ITEMS_TABLE = 'test-items'
  process.env.SESSIONS_TABLE = 'test-sessions'
  process.env.CORS_ALLOWED_ORIGINS = 'https://pulse.urgdstudios.com'
})

function makeUpdateEvent(body, tenantId = 'tenant-abc') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-1', authorizer: { tenantId } },
    body: JSON.stringify(body),
  }
}

function makeGetEvent(tenantId = 'tenant-abc') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-1', authorizer: { tenantId } },
  }
}

// ── updateSettings — terms fields ──────────────────────────────────────────
describe('updateSettings — termsAcceptedVersion + termsAcceptedAt', () => {
  it('stores termsAcceptedVersion and termsAcceptedAt when both provided', async () => {
    mockSend.mockResolvedValueOnce({})
    const { handler } = await import('./index.mjs')

    const res = await handler(makeUpdateEvent({
      termsAcceptedVersion: '2026-03-16',
      termsAcceptedAt: '2026-03-22T10:00:00.000Z',
    }))

    expect(res.statusCode).toBe(200)

    const updateCall = mockSend.mock.calls[0][0]._input
    const expr = updateCall.UpdateExpression
    const names = updateCall.ExpressionAttributeNames
    const values = updateCall.ExpressionAttributeValues

    expect(expr).toContain('#termsAcceptedVersion = :termsAcceptedVersion')
    expect(expr).toContain('#termsAcceptedAt = :termsAcceptedAt')
    expect(names['#termsAcceptedVersion']).toBe('termsAcceptedVersion')
    expect(names['#termsAcceptedAt']).toBe('termsAcceptedAt')
    expect(values[':termsAcceptedVersion']).toEqual({ S: '2026-03-16' })
    expect(values[':termsAcceptedAt']).toEqual({ S: '2026-03-22T10:00:00.000Z' })
  })

  it('ignores termsAcceptedVersion when not a string (no error, no update for that field)', async () => {
    mockSend.mockResolvedValueOnce({})
    const { handler } = await import('./index.mjs')

    const res = await handler(makeUpdateEvent({ displayName: 'Alice' }))

    expect(res.statusCode).toBe(200)

    const updateCall = mockSend.mock.calls[0][0]._input
    const expr = updateCall.UpdateExpression
    expect(expr).not.toContain('termsAcceptedVersion')
    expect(expr).not.toContain('termsAcceptedAt')
  })

  it('stores only termsAcceptedVersion when termsAcceptedAt is omitted', async () => {
    mockSend.mockResolvedValueOnce({})
    const { handler } = await import('./index.mjs')

    const res = await handler(makeUpdateEvent({ termsAcceptedVersion: '2026-03-16' }))

    expect(res.statusCode).toBe(200)

    const updateCall = mockSend.mock.calls[0][0]._input
    const expr = updateCall.UpdateExpression
    expect(expr).toContain('#termsAcceptedVersion = :termsAcceptedVersion')
    expect(expr).not.toContain('termsAcceptedAt')
  })
})

// ── getSettings — termsAcceptedVersion field ───────────────────────────────
describe('getSettings — termsAcceptedVersion in response', () => {
  it('returns termsAcceptedVersion when set on tenant record', async () => {
    mockSend.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'BatchGetItemCommand') {
        return Promise.resolve({
          Responses: {
            'test-tenants': [{
              tenantId: { S: 'tenant-abc' },
              displayName: { S: 'Alice' },
              email: { S: 'alice@example.com' },
              tier: { S: 'free' },
              onboardingComplete: { BOOL: true },
              termsAcceptedVersion: { S: '2026-03-16' },
            }],
          },
        })
      }
      if (name === 'QueryCommand') return Promise.resolve({ Count: 0 })
      return Promise.resolve({})
    })

    const { handler } = await import(
      '../urgd-pulse-getSettings/index.mjs'
    )

    const res = await handler(makeGetEvent())
    const body = JSON.parse(res.body)

    expect(res.statusCode).toBe(200)
    expect(body.data.termsAcceptedVersion).toBe('2026-03-16')
  })

  it('returns termsAcceptedVersion as null when not set on tenant record', async () => {
    mockSend.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'BatchGetItemCommand') {
        return Promise.resolve({
          Responses: {
            'test-tenants': [{
              tenantId: { S: 'tenant-abc' },
              email: { S: 'alice@example.com' },
              tier: { S: 'free' },
              onboardingComplete: { BOOL: false },
            }],
          },
        })
      }
      if (name === 'QueryCommand') return Promise.resolve({ Count: 0 })
      return Promise.resolve({})
    })

    const { handler } = await import(
      '../urgd-pulse-getSettings/index.mjs'
    )

    const res = await handler(makeGetEvent())
    const body = JSON.parse(res.body)

    expect(res.statusCode).toBe(200)
    expect(body.data.termsAcceptedVersion).toBeNull()
  })
})
