// Unit tests for urgd-pulse-inviteReviewer
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('APP_URL', 'https://pulse.urgdstudios.com')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789012:urgd-pulse-alerts-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const sesSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/client-ses', () => {
  class SESClient { send(...args) { return sesSendSpy(...args) } }
  class SendEmailCommand { constructor(input) { this.input = input } }
  class SendRawEmailCommand { constructor(input) { this.input = input } }
  return { SESClient, SendEmailCommand, SendRawEmailCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

vi.mock('qrcode', () => ({
  default: { toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-qr')) },
}))

const { handler } = await import('./index.mjs')

const DRAFT_ITEM = {
  tenantId: { S: 'tenant-abc' },
  itemId: { S: 'item-123' },
  itemName: { S: 'My Review Item' },
  status: { S: 'draft' },
  closeDate: { S: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
}

const ACTIVE_ITEM = { ...DRAFT_ITEM, status: { S: 'active' } }

const FREE_TENANT = {
  tenantId: { S: 'tenant-abc' },
  tier: { S: 'free' },
  features: { M: { maxSessionsPerItem: { N: '5' } } },
}

const PAID_TENANT = {
  tenantId: { S: 'tenant-abc' },
  tier: { S: 'paid' },
  features: { M: { maxSessionsPerItem: { N: '50' } } },
}

function makeEvent(tenantId, itemId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-inviteReviewer', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
    sesSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  describe('creates N sessions for N emails', () => {
    it('creates 3 sessions for 3 emails with unique pulseCodes, sends SES emails, updates item to active', async () => {
      const emails = ['a@test.com', 'b@test.com', 'c@test.com']
      const putCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        if (name === 'PutItemCommand') {
          putCalls.push(cmd.input)
          return Promise.resolve({})
        }
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails }))

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.sessions).toHaveLength(3)

      // Unique sessionIds
      const sessionIds = new Set(body.data.sessions.map(s => s.sessionId))
      expect(sessionIds.size).toBe(3)

      // Unique pulseCodes
      const pulseCodes = new Set(body.data.sessions.map(s => s.pulseCode))
      expect(pulseCodes.size).toBe(3)

      // SES called 3 times
      expect(sesSendSpy).toHaveBeenCalledTimes(3)

      // UpdateItem called to set item to active
      const updateCalls = dynamoSendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('creates 1 session for 1 email', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        if (name === 'PutItemCommand') return Promise.resolve({})
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['reviewer@example.com'] }))

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.data.sessions).toHaveLength(1)
      expect(body.data.sessions[0].sessionId).toBeDefined()
      expect(body.data.sessions[0].pulseCode).toBeDefined()
      expect(body.data.sessions[0].status).toBe('not_started')
    })
  })

  describe('maxSessionsPerItem limit returns 403', () => {
    it('returns 403 when free tenant limit (5) would be exceeded', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 5, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['x@test.com'] }))

      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body).message).toMatch(/feedback limit/i)
    })

    it('returns 403 when paid tenant limit (50) would be exceeded', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: ACTIVE_ITEM })
          return Promise.resolve({ Item: PAID_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 50, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['x@test.com'] }))

      expect(res.statusCode).toBe(403)
    })

    it('allows invite when under free limit', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 4, Items: [] })
        if (name === 'PutItemCommand') return Promise.resolve({})
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['x@test.com'] }))

      expect(res.statusCode).toBe(201)
    })
  })

  describe('input validation', () => {
    it('returns 400 for invalid emails array (non-email strings)', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['not-an-email', 'also-bad'] }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toMatch(/email/i)
    })

    it('returns 400 for empty emails array', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: [] }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when emails is not an array', async () => {
      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: 'single@test.com' }))
      expect(res.statusCode).toBe(400)
    })
  })

  describe('item lookup', () => {
    it('returns 404 when item not found', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: undefined })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-999', { emails: ['a@test.com'] }))
      expect(res.statusCode).toBe(404)
    })

    it('returns 409 when item is not in draft or active status', async () => {
      const closedItem = { ...DRAFT_ITEM, status: { S: 'closed' } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: closedItem })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        return Promise.resolve({})
      })

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails: ['a@test.com'] }))
      expect(res.statusCode).toBe(409)
    })
  })

  describe('SES failure handling', () => {
    it('publishes SNS alert and continues (does not throw) when SES fails', async () => {
      const emails = ['a@test.com', 'b@test.com']

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        if (name === 'PutItemCommand') return Promise.resolve({})
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      sesSendSpy.mockRejectedValue(new Error('SES unavailable'))

      const res = await handler(makeEvent('tenant-abc', 'item-123', { emails }))

      // Should still return 201 — SES failure is non-fatal
      expect(res.statusCode).toBe(201)

      // SNS alert should have been published for each SES failure
      expect(snsSendSpy).toHaveBeenCalled()
    })
  })

  describe('auth', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-123' },
        body: JSON.stringify({ emails: ['a@test.com'] }),
      })
      expect(res.statusCode).toBe(401)
    })

    it('tenantId comes from authorizer context only, not request body', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'GetItemCommand') {
          const key = cmd.input?.Key
          if (key?.itemId) return Promise.resolve({ Item: DRAFT_ITEM })
          return Promise.resolve({ Item: FREE_TENANT })
        }
        if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
        if (name === 'PutItemCommand') return Promise.resolve({})
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-abc' } },
        pathParameters: { itemId: 'item-123' },
        body: JSON.stringify({ emails: ['a@test.com'], tenantId: 'injected-tenant' }),
      })

      expect(res.statusCode).toBe(201)
      // Verify DynamoDB was called with the authorizer tenantId, not the injected one
      const getItemCalls = dynamoSendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'GetItemCommand')
      const itemLookup = getItemCalls.find(c => c[0].input?.Key?.itemId)
      expect(itemLookup[0].input.Key.tenantId.S).toBe('tenant-abc')
    })
  })
})
