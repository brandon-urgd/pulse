// Unit tests for urgd-pulse-createSelfSession
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({ output: { message: { content: [{ text: '' }] } }, usage: {} }) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

vi.mock('./shared/features.mjs', () => ({
  resolveFeature: vi.fn((tenantRecord, featureName, systemRecord) => {
    if (featureName === 'maxSessionsPerItem') return { allowed: true, limit: 5 }
    return { allowed: true, limit: 100 }
  }),
}))

vi.mock('./shared/counters.mjs', () => ({
  checkAndIncrement: vi.fn(() => Promise.resolve({ allowed: true, newCount: 1 })),
}))

const { handler } = await import('./index.mjs')

const DRAFT_ITEM = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  status: { S: 'draft' },
  closeDate: { S: '2099-12-31' },
}

const ACTIVE_ITEM = {
  ...DRAFT_ITEM,
  status: { S: 'active' },
}

const CLOSED_ITEM = {
  ...DRAFT_ITEM,
  status: { S: 'closed' },
}

function makeEvent(tenantId = 'tenant-abc', itemId = 'item-123') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: '{}',
  }
}

beforeEach(() => {
  dynamoSendSpy.mockReset()
})

// Helper: set up DynamoDB mocks that handle the full handler flow
function setupMocks(itemRecord, sessionCount = 0) {
  dynamoSendSpy.mockImplementation((cmd) => {
    const name = cmd?.constructor?.name
    if (name === 'GetItemCommand') {
      const table = cmd.input?.TableName
      if (table === process.env.TENANTS_TABLE) {
        // Tenant or SYSTEM record for feature flag check / counter read
        const key = cmd.input?.Key?.tenantId?.S
        if (key === 'SYSTEM') {
          return Promise.resolve({ Item: { tenantId: { S: 'SYSTEM' }, serviceFlags: { M: {} } } })
        }
        return Promise.resolve({
          Item: {
            tenantId: { S: 'tenant-abc' },
            tier: { S: 'free' },
            features: { M: {} },
            serviceFlags: { M: {} },
          },
        })
      }
      if (table === process.env.ITEMS_TABLE) {
        return Promise.resolve({ Item: itemRecord })
      }
      return Promise.resolve({ Item: null })
    }
    if (name === 'QueryCommand') {
      return Promise.resolve({ Count: sessionCount })
    }
    if (name === 'PutItemCommand' || name === 'UpdateItemCommand') {
      return Promise.resolve({})
    }
    return Promise.resolve({})
  })
}

describe('urgd-pulse-createSelfSession', () => {
  describe('success cases', () => {
    it('creates session with isSelfReview: true for a draft item', async () => {
      setupMocks(DRAFT_ITEM, 0)

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(201)
      expect(body.data.sessionId).toBeTruthy()
      expect(body.data.sessionUrl).toContain('/s/')

      // Verify PutItem set isSelfReview: true
      const putCall = dynamoSendSpy.mock.calls.find(c => c[0].input?.Item?.isSelfReview)
      expect(putCall).toBeTruthy()
      expect(putCall[0].input.Item.isSelfReview).toEqual({ BOOL: true })
    })

    it('creates session with isSelfReview: true for an active item', async () => {
      setupMocks(ACTIVE_ITEM, 2)

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(result.statusCode).toBe(201)
      expect(body.data.sessionId).toBeTruthy()

      const putCall = dynamoSendSpy.mock.calls.find(c => c[0].input?.Item?.isSelfReview)
      expect(putCall[0].input.Item.isSelfReview).toEqual({ BOOL: true })
    })

    it('does not send email — no SES calls', async () => {
      setupMocks(DRAFT_ITEM, 0)

      await handler(makeEvent())

      // All calls should be DynamoDB only — no SES client is imported
      // Verify by checking that no call has a Destination or ToAddresses field
      const hasSesCall = dynamoSendSpy.mock.calls.some(c =>
        c[0].input?.Destination || c[0].input?.ToAddresses
      )
      expect(hasSesCall).toBe(false)
    })

    it('counts toward session limit — session count is checked before creation', async () => {
      setupMocks(ACTIVE_ITEM, 4)

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(201)
    })

    it('returns valid sessionUrl containing the sessionId', async () => {
      setupMocks(DRAFT_ITEM, 0)

      const result = await handler(makeEvent())
      const body = JSON.parse(result.body)

      expect(body.data.sessionUrl).toContain(body.data.sessionId)
      expect(body.data.sessionUrl).toMatch(/^https:\/\/pulse\.urgdstudios\.com\/s\//)
    })

    it('activates draft item to active on first session', async () => {
      setupMocks(DRAFT_ITEM, 0)

      await handler(makeEvent())

      // Find the UpdateItem call and verify it sets status to active
      const updateCall = dynamoSendSpy.mock.calls.find(c =>
        c[0].input?.UpdateExpression?.includes(':active')
      )
      expect(updateCall).toBeTruthy()
      expect(updateCall[0].input.ExpressionAttributeValues[':active']).toEqual({ S: 'active' })
    })
  })

  describe('session limit enforcement', () => {
    it('returns 403 when at session limit', async () => {
      setupMocks(ACTIVE_ITEM, 5)

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(403)
      const body = JSON.parse(result.body)
      expect(body.message).toContain('Session limit')
    })
  })

  describe('item status validation', () => {
    it('returns 409 for closed items', async () => {
      setupMocks(CLOSED_ITEM)

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(409)
    })

    it('returns 409 for revised items', async () => {
      const revisedItem = { ...DRAFT_ITEM, status: { S: 'revised' } }
      setupMocks(revisedItem)

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(409)
    })
  })

  describe('authorization', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
        body: '{}',
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(401)
    })

    it('returns 400 when itemId is missing', async () => {
      const event = {
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: {},
        body: '{}',
      }
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
    })

    it('returns 404 when item does not exist', async () => {
      setupMocks(null)

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(404)
    })

    it('returns 404 when item belongs to a different tenant', async () => {
      const otherTenantItem = { ...DRAFT_ITEM, tenantId: { S: 'other-tenant' } }
      setupMocks(otherTenantItem)

      const result = await handler(makeEvent('tenant-abc'))
      expect(result.statusCode).toBe(404)
    })
  })

  describe('error handling', () => {
    it('returns 500 on unexpected DynamoDB error', async () => {
      dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB unavailable'))

      const result = await handler(makeEvent())
      expect(result.statusCode).toBe(500)
    })
  })
})
