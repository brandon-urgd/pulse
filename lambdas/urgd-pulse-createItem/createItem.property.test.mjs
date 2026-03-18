// Property test for urgd-pulse-createItem
// Property 12: Item Creation Uniqueness Property
// Validates: Requirements 4.1

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
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

const { handler } = await import('./index.mjs')

// Free tenant fixture
const FREE_TENANT = {
  tenantId: { S: 'tenant-test' },
  tier: { S: 'free' },
  features: { M: { maxActiveItems: { N: '1' } } },
}

// Paid tenant fixture
const PAID_TENANT = {
  tenantId: { S: 'tenant-paid' },
  tier: { S: 'paid' },
  features: { M: { maxActiveItems: { N: '25' } } },
}

function makeFutureDate() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}

function makeEvent(tenantId, itemName, description, closeDate) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { tenantId },
    },
    body: JSON.stringify({ itemName, description, closeDate }),
  }
}

describe('Property 12: Item Creation Uniqueness Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  it('for any valid item creation request, creates exactly one item with a unique itemId', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid item names (1-200 chars)
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length >= 1),
        // Generate valid descriptions (1-2000 chars)
        fc.string({ minLength: 1, maxLength: 2000 }).filter(s => s.trim().length >= 1),
        async (itemName, description) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})

          // Tenant exists, no existing items (count = 0)
          sendSpy
            .mockResolvedValueOnce({ Item: PAID_TENANT }) // GetItem for tenant
            .mockResolvedValueOnce({ Count: 0, Items: [] }) // Query for existing items
            .mockResolvedValueOnce({}) // PutItem for new item

          const event = makeEvent('tenant-paid', itemName, description, makeFutureDate())
          const result = await handler(event)

          expect(result.statusCode).toBe(201)
          const body = JSON.parse(result.body)
          expect(body.data).toBeDefined()
          expect(body.data.itemId).toBeDefined()
          expect(typeof body.data.itemId).toBe('string')
          expect(body.data.itemId.length).toBeGreaterThan(0)
          expect(body.data.status).toBe('draft')

          // Verify PutItem was called exactly once
          const putCalls = sendSpy.mock.calls.filter(
            call => call[0]?.constructor?.name === 'PutItemCommand'
          )
          expect(putCalls).toHaveLength(1)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('submitting the same request twice produces two distinct items with different itemIds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length >= 1),
        fc.string({ minLength: 1, maxLength: 2000 }).filter(s => s.trim().length >= 1),
        async (itemName, description) => {
          const closeDate = makeFutureDate()
          const event = makeEvent('tenant-paid', itemName, description, closeDate)

          // First call
          sendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})
          sendSpy
            .mockResolvedValueOnce({ Item: PAID_TENANT })
            .mockResolvedValueOnce({ Count: 0, Items: [] })
            .mockResolvedValueOnce({})

          const result1 = await handler(event)
          expect(result1.statusCode).toBe(201)
          const itemId1 = JSON.parse(result1.body).data.itemId

          // Second call (count is now 1, but paid tenant allows 25)
          sendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})
          sendSpy
            .mockResolvedValueOnce({ Item: PAID_TENANT })
            .mockResolvedValueOnce({ Count: 1, Items: [] })
            .mockResolvedValueOnce({})

          const result2 = await handler(event)
          expect(result2.statusCode).toBe(201)
          const itemId2 = JSON.parse(result2.body).data.itemId

          // The two itemIds must be different (UUID uniqueness)
          expect(itemId1).not.toBe(itemId2)
        }
      ),
      { numRuns: 100 }
    )
  })
})
