// Unit tests for urgd-pulse-createTenant
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class PutItemCommand {
    constructor(input) { this.input = input }
  }
  class BatchWriteItemCommand {
    constructor(input) { this.input = input }
  }
  class UpdateItemCommand {
    constructor(input) { this.input = input }
  }
  return { DynamoDBClient, PutItemCommand, BatchWriteItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-ssm', () => {
  class SSMClient { send() { return Promise.resolve({}) } }
  class GetParameterCommand { constructor(input) { this.input = input } }
  return { SSMClient, GetParameterCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

const { handler } = await import('./index.mjs')

const makeEvent = (body = {}) => ({
  headers: { origin: 'https://pulse.urgdstudios.com' },
  requestContext: { requestId: 'req-123' },
  body: JSON.stringify(body),
})

describe('urgd-pulse-createTenant', () => {
  beforeEach(() => sendSpy.mockReset())

  it('returns 201 with tenantId and free tier defaults', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.tenantId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.tier).toBe('free')
    expect(body.onboardingComplete).toBe(false)
  })

  it('creates a unique tenantId (UUID) on each call', async () => {
    sendSpy.mockResolvedValue({})
    const res1 = await handler(makeEvent())
    const res2 = await handler(makeEvent())
    const id1 = JSON.parse(res1.body).tenantId
    const id2 = JSON.parse(res2.body).tenantId
    expect(id1).not.toBe(id2)
  })

  it('includes all free tier feature flags', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent())
    const { features } = JSON.parse(res.body)
    expect(features.maxActiveItems).toBe(1)
    expect(features.maxSessionsPerItem).toBe(5)
    expect(features.sessionTimeLimitMinutes).toBe(15)
    expect(features.itemRevisionLoop).toBe(false)
    expect(features.emailReminders).toBe(true)
    expect(features.pulseCheck).toBe(true)
  })

  it('includes usage with zero counts', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent())
    const { usage } = JSON.parse(res.body)
    expect(usage.itemCount).toBe(0)
    expect(usage.sessionCount).toBe(0)
  })

  it('includes createdAt and updatedAt ISO timestamps', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent())
    const { createdAt, updatedAt } = JSON.parse(res.body)
    expect(new Date(createdAt).toISOString()).toBe(createdAt)
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt)
  })

  it('returns 500 on DynamoDB failure', async () => {
    sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(500)
  })

  it('returns 201 even with invalid JSON body (body is not parsed)', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-bad' },
      body: '{bad json',
    })
    expect(res.statusCode).toBe(201)
  })
})
