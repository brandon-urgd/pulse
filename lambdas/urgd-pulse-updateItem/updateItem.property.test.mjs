// Property test for urgd-pulse-updateItem
// Property 14: Draft-Only Edit Invariant
// Validates: Requirements 4.11, 4.12

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
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
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

const { handler } = await import('./index.mjs')

const NON_DRAFT_STATUSES = ['active', 'closed', 'revised']
const DRAFT_STATUS = 'draft'

function makeFutureDate() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
}

function makeItemRecord(status) {
  return {
    tenantId: { S: 'tenant-test' },
    itemId: { S: 'item-test' },
    itemName: { S: 'Test Item' },
    description: { S: 'Test description' },
    closeDate: { S: makeFutureDate() },
    status: { S: status },
    documentStatus: { NULL: true },
    createdAt: { S: new Date().toISOString() },
    updatedAt: { S: new Date().toISOString() },
  }
}

function makeEvent(tenantId, itemId, updates) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: JSON.stringify(updates),
  }
}

describe('Property 14: Draft-Only Edit Invariant', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  it('for any item in draft status, update operations succeed', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid update payloads
        fc.record({
          itemName: fc.option(
            fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length >= 1),
            { nil: undefined }
          ),
        }),
        async (updates) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})

          const draftItem = makeItemRecord(DRAFT_STATUS)
          const updatedAttributes = {
            ...draftItem,
            updatedAt: { S: new Date().toISOString() },
          }
          if (updates.itemName !== undefined) {
            updatedAttributes.itemName = { S: updates.itemName.trim() }
          }

          sendSpy
            .mockResolvedValueOnce({ Item: draftItem }) // GetItem
            .mockResolvedValueOnce({ Attributes: updatedAttributes }) // UpdateItem

          const payload = {}
          if (updates.itemName !== undefined) payload.itemName = updates.itemName

          const event = makeEvent('tenant-test', 'item-test', payload)
          const result = await handler(event)

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data).toBeDefined()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any item in non-draft status, update operations are rejected with 409', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Pick a non-draft status
        fc.constantFrom(...NON_DRAFT_STATUSES),
        // Generate a valid update payload
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length >= 1),
        async (status, itemName) => {
          sendSpy.mockReset()

          const lockedItem = makeItemRecord(status)
          sendSpy.mockResolvedValueOnce({ Item: lockedItem }) // GetItem

          const event = makeEvent('tenant-test', 'item-test', { itemName })
          const result = await handler(event)

          expect(result.statusCode).toBe(409)
          const body = JSON.parse(result.body)
          expect(body.message).toMatch(/locked/i)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('the set of editable statuses is exactly {"draft"} — draft succeeds, all others fail with 409', async () => {
    await fc.assert(
      fc.asyncProperty(
        // All possible statuses including draft
        fc.constantFrom('draft', 'active', 'closed', 'revised'),
        async (status) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockResolvedValue({})

          const item = makeItemRecord(status)

          if (status === 'draft') {
            const updatedAttributes = {
              ...item,
              itemName: { S: 'Updated Name' },
              updatedAt: { S: new Date().toISOString() },
            }
            sendSpy
              .mockResolvedValueOnce({ Item: item })
              .mockResolvedValueOnce({ Attributes: updatedAttributes })
          } else {
            sendSpy.mockResolvedValueOnce({ Item: item })
          }

          const event = makeEvent('tenant-test', 'item-test', { itemName: 'Updated Name' })
          const result = await handler(event)

          if (status === 'draft') {
            expect(result.statusCode).toBe(200)
          } else {
            expect(result.statusCode).toBe(409)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
