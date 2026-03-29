// Unit tests for urgd-pulse-inviteReviewer — frozenSnapshot creation
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789:urgd-pulse-alerts-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const sesSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient {
    send(...args) { return sesSendSpy(...args) }
  }
  class SendEmailCommand { constructor(input) { this.input = input } }
  return { SESClient, SendEmailCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient {
    send(...args) { return snsSendSpy(...args) }
  }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

vi.mock('qrcode', () => ({
  default: { toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-qr')) }
}))

function makeEvent({ tenantId, itemId, emails } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    pathParameters: itemId ? { itemId } : {},
    body: JSON.stringify({ emails: emails || ['reviewer@example.com'] }),
  }
}

function makeTenantRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      tier: { S: 'pro' },
      displayName: { S: 'Test User' },
      email: { S: 'owner@example.com' },
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

function makeItemWithSectionMap() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-123' },
      itemName: { S: 'Test Document' },
      status: { S: 'draft' },
      closeDate: { S: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
      recommendedTimeLimitMinutes: { N: '17' },
      sectionMap: {
        M: {
          sections: {
            L: [
              { M: { id: { S: 's1' }, title: { S: 'Introduction' }, classification: { S: 'substantive' } } },
              { M: { id: { S: 's2' }, title: { S: 'Main Body' }, classification: { S: 'substantive' } } },
              { M: { id: { S: 's3' }, title: { S: 'Conclusion' }, classification: { S: 'substantive' } } },
            ],
          },
          totalSubstantiveSections: { N: '3' },
          analyzedAt: { S: new Date().toISOString() },
        },
      },
      feedbackSections: {
        L: [{ S: 's1' }, { S: 's2' }, { S: 's3' }],
      },
      sectionDepthPreferences: {
        M: {
          s1: { S: 'deep' },
          s2: { S: 'explore' },
          s3: { S: 'skim' },
        },
      },
    },
  }
}

function makeItemWithoutSectionMap() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-123' },
      itemName: { S: 'Test Document' },
      status: { S: 'draft' },
      closeDate: { S: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
      recommendedTimeLimitMinutes: { N: '17' },
      totalSections: { N: '5' },
      // No sectionMap
    },
  }
}

/**
 * Set up DynamoDB mocks in the order the handler calls them:
 * 1. GetItem (item)
 * 2. QueryCommand (existing sessions count)
 * 3. GetItem (tenant) + GetItem (SYSTEM) — parallel
 * 4. PutItem (session)
 * 5. PutObject (QR code S3)
 * 6. SendEmail (SES)
 * 7. UpdateItem (item status)
 */
function setupMocksWithSectionMap() {
  dynamoSendSpy
    .mockResolvedValueOnce(makeItemWithSectionMap()) // GetItem item
    .mockResolvedValueOnce({ Count: 0 }) // QueryCommand existing sessions
    .mockResolvedValueOnce(makeTenantRecord()) // GetItem tenant (parallel)
    .mockResolvedValueOnce(makeSystemRecord()) // GetItem SYSTEM (parallel)
    .mockResolvedValueOnce({}) // PutItem session
    .mockResolvedValueOnce({}) // UpdateItem item status
  s3SendSpy.mockResolvedValue({})
  sesSendSpy.mockResolvedValue({})
  snsSendSpy.mockResolvedValue({})
}

function setupMocksWithoutSectionMap() {
  dynamoSendSpy
    .mockResolvedValueOnce(makeItemWithoutSectionMap()) // GetItem item
    .mockResolvedValueOnce({ Count: 0 }) // QueryCommand existing sessions
    .mockResolvedValueOnce(makeTenantRecord()) // GetItem tenant (parallel)
    .mockResolvedValueOnce(makeSystemRecord()) // GetItem SYSTEM (parallel)
    .mockResolvedValueOnce({}) // PutItem session
    .mockResolvedValueOnce({}) // UpdateItem item status
  s3SendSpy.mockResolvedValue({})
  sesSendSpy.mockResolvedValue({})
  snsSendSpy.mockResolvedValue({})
}

const { handler } = await import('../../lambdas/urgd-pulse-inviteReviewer/index.mjs')

describe('urgd-pulse-inviteReviewer — frozenSnapshot creation', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
  })

  describe('item with sectionMap → session record contains frozenSnapshot', () => {
    it('creates session with frozenSnapshot when item has sectionMap', async () => {
      setupMocksWithSectionMap()

      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123' })
      const result = await handler(event)

      expect(result.statusCode).toBe(201)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      expect(putCall).toBeDefined()

      const sessionItem = putCall.input.Item
      expect(sessionItem.frozenSnapshot).toBeDefined()
      expect(sessionItem.frozenSnapshot.M).toBeDefined()
    })
  })

  describe('frozenSnapshot contains sectionMap, feedbackSections, sectionDepthPreferences', () => {
    it('frozenSnapshot has all three required fields', async () => {
      setupMocksWithSectionMap()

      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123' })
      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      const sessionItem = putCall.input.Item
      const snapshot = sessionItem.frozenSnapshot.M

      expect(snapshot.sectionMap).toBeDefined()
      expect(snapshot.feedbackSections).toBeDefined()
      expect(snapshot.sectionDepthPreferences).toBeDefined()

      // Verify feedbackSections has the right sections
      expect(snapshot.feedbackSections.L).toHaveLength(3)
      expect(snapshot.feedbackSections.L[0].S).toBe('s1')
    })
  })

  describe('sectionCoverage initialized with all feedbackSections set to { touched: false, depth: null }', () => {
    it('initializes sectionCoverage for all feedbackSections', async () => {
      setupMocksWithSectionMap()

      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123' })
      await handler(event)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      const sessionItem = putCall.input.Item

      expect(sessionItem.sectionCoverage).toBeDefined()
      const coverage = sessionItem.sectionCoverage.M

      // All 3 sections should be initialized
      expect(coverage.s1).toBeDefined()
      expect(coverage.s1.M.touched.BOOL).toBe(false)
      expect(coverage.s1.M.depth.NULL).toBe(true)

      expect(coverage.s2).toBeDefined()
      expect(coverage.s2.M.touched.BOOL).toBe(false)

      expect(coverage.s3).toBeDefined()
      expect(coverage.s3.M.touched.BOOL).toBe(false)
    })
  })

  describe('item without sectionMap → no frozenSnapshot on session, totalSections set instead', () => {
    it('creates session without frozenSnapshot when item has no sectionMap', async () => {
      setupMocksWithoutSectionMap()

      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123' })
      const result = await handler(event)

      expect(result.statusCode).toBe(201)

      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const putCall = dynamoCalls.find(c => c.constructor.name === 'PutItemCommand')
      const sessionItem = putCall.input.Item

      // No frozenSnapshot
      expect(sessionItem.frozenSnapshot).toBeUndefined()

      // totalSections should be set instead
      expect(sessionItem.totalSections).toBeDefined()
      expect(sessionItem.totalSections.N).toBe('5')
    })
  })
})
