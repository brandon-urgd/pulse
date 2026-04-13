// Unit tests for urgd-pulse-createSelfSession — PreGenerate invocation
// Requirements: 1.2, 1.8
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('PRE_GENERATE_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-preGenerate-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSpy = vi.fn()
const lambdaSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class PutItemCommand { constructor(input) { this.input = input; this.name = 'PutItemCommand' } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input; this.name = 'InvokeCommand' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
  createResponse: vi.fn((code, body) => ({ statusCode: code, body: JSON.stringify(body) })),
  errorResponse: vi.fn((code, msg, extra) => ({ statusCode: code, body: JSON.stringify({ error: true, message: msg, ...extra }) })),
  unmarshalFeatures: vi.fn(() => ({})),
}))

vi.mock('./shared/features.mjs', () => ({
  resolveFeature: vi.fn(() => ({ allowed: true, limit: 20 })),
}))

vi.mock('./shared/counters.mjs', () => ({
  checkAndIncrement: vi.fn(() => ({ allowed: true })),
}))

vi.mock('crypto', () => ({
  randomUUID: () => 'test-session-uuid',
}))

const { handler } = await import('./index.mjs')

// ── Helpers ──

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-1' },
    },
    pathParameters: { itemId: 'item-1' },
    body: JSON.stringify({}),
    ...overrides,
  }
}

function makeItemRecord(overrides = {}) {
  return {
    Item: {
      tenantId: { S: 'tenant-1' },
      itemId: { S: 'item-1' },
      itemName: { S: 'Test Document' },
      description: { S: 'A test document' },
      status: { S: 'draft' },
      ...overrides,
    },
  }
}

function makeTenantRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-1' },
      tier: { S: 'pro' },
    },
  }
}

function makeSystemRecord() {
  return { Item: { tenantId: { S: 'SYSTEM' } } }
}

// ── Tests ──

describe('createSelfSession — PreGenerate invocation', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    lambdaSpy.mockReset()
  })

  it('invokes PreGenerate async after session PutItem', async () => {
    // DynamoDB call sequence:
    // 1. GetItem item
    // 2. Query existing self-review sessions
    // 3. Query all sessions (count)
    // 4. GetItem tenant + GetItem SYSTEM (parallel)
    // 5. PutItem session
    // 6. UpdateItem item (activate)
    dynamoSpy
      .mockResolvedValueOnce(makeItemRecord())                    // GetItem item
      .mockResolvedValueOnce({ Items: [] })                       // Query existing self-review
      .mockResolvedValueOnce({ Count: 0 })                        // Query all sessions count
      .mockResolvedValueOnce(makeTenantRecord())                  // GetItem tenant
      .mockResolvedValueOnce(makeSystemRecord())                  // GetItem SYSTEM
      .mockResolvedValueOnce({})                                  // PutItem session
      .mockResolvedValueOnce({})                                  // UpdateItem item

    lambdaSpy.mockResolvedValueOnce({})                           // InvokeCommand PreGenerate

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(201)

    // Lambda was invoked with correct payload
    expect(lambdaSpy).toHaveBeenCalledOnce()
    const invokeCall = lambdaSpy.mock.calls[0][0]
    expect(invokeCall.input.InvocationType).toBe('Event')
    const payload = JSON.parse(invokeCall.input.Payload)
    expect(payload.tenantId).toBe('tenant-1')
    expect(payload.sessionId).toBe('test-session-uuid')
  })

  it('invocation failure does not affect 201 response', async () => {
    dynamoSpy
      .mockResolvedValueOnce(makeItemRecord())
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Count: 0 })
      .mockResolvedValueOnce(makeTenantRecord())
      .mockResolvedValueOnce(makeSystemRecord())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    lambdaSpy.mockRejectedValueOnce(new Error('Lambda invoke failed'))

    const res = await handler(makeEvent())
    expect(res.statusCode).toBe(201)
  })
})
