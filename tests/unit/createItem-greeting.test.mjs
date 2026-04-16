// Unit tests for CreateItem Lambda — templateGreeting removal
// Validates: Requirement 13.2 (Phased Cache Priming — template greeting infrastructure removal)
// Updated: templateGreeting is no longer written by the CreateItem Lambda.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send(...args) { return lambdaSendSpy(...args) }
  }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

// Mock shared modules that have unresolvable dependencies in the test environment
vi.mock('../../lambdas/shared/scheduleClose.mjs', () => ({
  upsertCloseSchedule: vi.fn().mockResolvedValue({}),
  deleteCloseSchedule: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../lambdas/shared/counters.mjs', () => ({
  checkAndIncrement: vi.fn().mockResolvedValue({ allowed: true, newCount: 1 }),
}))

const { handler } = await import('../../lambdas/urgd-pulse-createItem/index.mjs')

const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

function makeEvent({ tenantId = 'tenant-abc', body } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    body: JSON.stringify(body || {}),
  }
}

function makeTenantRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      tier: { S: 'pro' },
      features: { M: {} },
      serviceFlags: { M: {} },
    },
  }
}

function makeSystemRecord() {
  return {
    Item: {
      tenantId: { S: 'SYSTEM' },
      serviceFlags: { M: {} },
    },
  }
}

/** Set up DynamoDB mocks for a successful CreateItem flow */
function setupDynamoMocks({ activeCount = 0 } = {}) {
  dynamoSendSpy
    .mockResolvedValueOnce(makeTenantRecord()) // GetItem tenant
    .mockResolvedValueOnce(makeSystemRecord()) // GetItem SYSTEM
    .mockResolvedValueOnce({ Count: activeCount }) // QueryCommand existing items
    .mockResolvedValue({}) // PutItemCommand + any other calls
}

/** Find the PutItemCommand call from dynamoSendSpy */
function findPutCall() {
  return dynamoSendSpy.mock.calls
    .map(c => c[0])
    .find(c => c.constructor.name === 'PutItemCommand')
}

describe('CreateItem Lambda — templateGreeting no longer written (R13.2)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('markdown/text items do not get templateGreeting in PutItem call', () => {
    it('does not store templateGreeting even when content is provided (documentStatus=ready)', async () => {
      setupDynamoMocks()

      const result = await handler(makeEvent({
        body: {
          itemName: 'My Markdown Doc',
          description: 'A text-based review item.',
          closeDate: futureDate,
          content: '# Introduction\n\nThis is the document content.',
        },
      }))

      expect(result.statusCode).toBe(201)

      const putCall = findPutCall()
      expect(putCall).toBeDefined()

      // templateGreeting should NOT be present
      expect(putCall.input.Item.templateGreeting).toBeUndefined()

      // documentStatus should still be ready
      expect(putCall.input.Item.documentStatus.S).toBe('ready')
    })
  })

  describe('items without content still do not get templateGreeting', () => {
    it('does not store templateGreeting when no content is provided', async () => {
      setupDynamoMocks()

      const result = await handler(makeEvent({
        body: {
          itemName: 'Upload-Only Item',
          description: 'Will upload a PDF later.',
          closeDate: futureDate,
        },
      }))

      expect(result.statusCode).toBe(201)

      const putCall = findPutCall()
      expect(putCall).toBeDefined()

      // templateGreeting should NOT be present
      expect(putCall.input.Item.templateGreeting).toBeUndefined()
    })
  })
})
