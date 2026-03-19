// Property test for urgd-pulse-inviteReviewer
// Property 16: Session Uniqueness Per Reviewer Property
// Validates: Requirements 5.1

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

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

const FREE_ITEM = {
  tenantId: { S: 'tenant-test' },
  itemId: { S: 'item-test' },
  itemName: { S: 'Test Item' },
  status: { S: 'draft' },
  closeDate: { S: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
}

const FREE_TENANT = {
  tenantId: { S: 'tenant-test' },
  tier: { S: 'free' },
  features: { M: { maxSessionsPerItem: { N: '5' } } },
}

function makeEvent(emails, existingCount = 0) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-16',
      authorizer: { tenantId: 'tenant-test' },
    },
    pathParameters: { itemId: 'item-test' },
    body: JSON.stringify({ emails }),
  }
}

describe('Property 16: Session Uniqueness Per Reviewer Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    sesSendSpy.mockReset()
    snsSendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
    sesSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  it('each unique reviewer email produces exactly one session with a unique sessionId and pulseCode', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1-5 unique email addresses
        fc.uniqueArray(
          fc.emailAddress(),
          { minLength: 1, maxLength: 5 }
        ),
        async (emails) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          sesSendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})
          sesSendSpy.mockResolvedValue({})

          const putCalls = []

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'GetItemCommand') {
              // First GetItem is for item, second is for tenant
              const key = cmd.input?.Key
              if (key?.itemId) return Promise.resolve({ Item: FREE_ITEM })
              return Promise.resolve({ Item: FREE_TENANT })
            }
            if (name === 'QueryCommand') {
              return Promise.resolve({ Count: 0, Items: [] })
            }
            if (name === 'PutItemCommand') {
              putCalls.push(cmd.input)
              return Promise.resolve({})
            }
            if (name === 'UpdateItemCommand') {
              return Promise.resolve({})
            }
            return Promise.resolve({})
          })

          const event = makeEvent(emails)
          const result = await handler(event)

          expect(result.statusCode).toBe(201)
          const body = JSON.parse(result.body)
          expect(body.data.sessions).toHaveLength(emails.length)

          // Each session must have a unique sessionId
          const sessionIds = body.data.sessions.map(s => s.sessionId)
          const uniqueSessionIds = new Set(sessionIds)
          expect(uniqueSessionIds.size).toBe(emails.length)

          // Each session must have a unique pulseCode
          const pulseCodes = body.data.sessions.map(s => s.pulseCode)
          const uniquePulseCodes = new Set(pulseCodes)
          expect(uniquePulseCodes.size).toBe(emails.length)

          // Exactly one PutItem per email
          expect(putCalls).toHaveLength(emails.length)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('no two sessions in the system share a pulseCode (uniqueness across calls)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.emailAddress(),
        async (email1, email2) => {
          // Skip if same email (not a valid test case)
          if (email1 === email2) return

          const allPulseCodes = []

          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          sesSendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})
          sesSendSpy.mockResolvedValue({})

          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'GetItemCommand') {
              const key = cmd.input?.Key
              if (key?.itemId) return Promise.resolve({ Item: FREE_ITEM })
              return Promise.resolve({ Item: FREE_TENANT })
            }
            if (name === 'QueryCommand') return Promise.resolve({ Count: 0, Items: [] })
            if (name === 'PutItemCommand') {
              const pulseCode = cmd.input?.Item?.pulseCode?.S
              if (pulseCode) allPulseCodes.push(pulseCode)
              return Promise.resolve({})
            }
            if (name === 'UpdateItemCommand') return Promise.resolve({})
            return Promise.resolve({})
          })

          // First invitation
          const result1 = await handler(makeEvent([email1]))
          expect(result1.statusCode).toBe(201)

          // Reset count to 1 for second call
          dynamoSendSpy.mockImplementation((cmd) => {
            const name = cmd?.constructor?.name
            if (name === 'GetItemCommand') {
              const key = cmd.input?.Key
              if (key?.itemId) return Promise.resolve({ Item: { ...FREE_ITEM, status: { S: 'active' } } })
              return Promise.resolve({ Item: FREE_TENANT })
            }
            if (name === 'QueryCommand') return Promise.resolve({ Count: 1, Items: [] })
            if (name === 'PutItemCommand') {
              const pulseCode = cmd.input?.Item?.pulseCode?.S
              if (pulseCode) allPulseCodes.push(pulseCode)
              return Promise.resolve({})
            }
            if (name === 'UpdateItemCommand') return Promise.resolve({})
            return Promise.resolve({})
          })

          // Second invitation
          const result2 = await handler(makeEvent([email2]))
          expect(result2.statusCode).toBe(201)

          // All pulse codes must be unique
          const uniqueCodes = new Set(allPulseCodes)
          expect(uniqueCodes.size).toBe(allPulseCodes.length)
        }
      ),
      { numRuns: 100 }
    )
  })
})
