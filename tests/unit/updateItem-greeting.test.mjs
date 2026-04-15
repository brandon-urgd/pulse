// Unit tests for UpdateItem Lambda — template greeting regeneration
// Validates: Requirement 1.4
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
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

import { GREETING_TEMPLATES } from '../../lambdas/shared/greetingTemplates.mjs'

const { handler } = await import('../../lambdas/urgd-pulse-updateItem/index.mjs')

function makeEvent({ tenantId = 'tenant-abc', itemId = 'item-xyz', body } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    pathParameters: { itemId },
    body: JSON.stringify(body || {}),
  }
}

/**
 * Build a mock existing item record in DynamoDB wire format.
 * @param {object} overrides - Fields to override on the base item
 */
function makeExistingItem(overrides = {}) {
  const base = {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-xyz' },
    itemName: { S: 'Old Name' },
    description: { S: 'A test item.' },
    status: { S: 'draft' },
    createdAt: { S: '2026-01-01T00:00:00.000Z' },
    updatedAt: { S: '2026-01-01T00:00:00.000Z' },
  }
  return { ...base, ...overrides }
}

/** Find the UpdateItemCommand call from dynamoSendSpy */
function findUpdateCall() {
  return dynamoSendSpy.mock.calls
    .map(c => c[0])
    .find(c => c.constructor.name === 'UpdateItemCommand')
}

describe('UpdateItem Lambda — template greeting regeneration', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
    s3SendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('regenerates templateGreeting when itemName changes and item has existing greeting (R1.4)', () => {
    it('regenerates greeting with new name for document type', async () => {
      const existingGreeting = GREETING_TEMPLATES.document.replace('{itemName}', 'Old Name')
      const existingItem = makeExistingItem({
        templateGreeting: { S: existingGreeting },
        itemType: { S: 'document' },
      })

      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: existingItem })
        }
        // UpdateItemCommand — return updated attributes
        return Promise.resolve({ Attributes: {
          ...existingItem,
          itemName: { S: 'New Name' },
          updatedAt: { S: new Date().toISOString() },
        }})
      })

      const result = await handler(makeEvent({
        body: { itemName: 'New Name' },
      }))

      expect(result.statusCode).toBe(200)

      const updateCall = findUpdateCall()
      expect(updateCall).toBeDefined()

      // templateGreeting should be regenerated with the new name
      const values = updateCall.input.ExpressionAttributeValues
      expect(values[':templateGreeting']).toBeDefined()
      expect(values[':templateGreeting'].S).toContain('New Name')
      expect(values[':templateGreeting'].S).not.toContain('Old Name')

      // Should use the document template
      const expectedGreeting = GREETING_TEMPLATES.document.replace('{itemName}', 'New Name')
      expect(values[':templateGreeting'].S).toBe(expectedGreeting)

      // Update expression should include templateGreeting
      expect(updateCall.input.UpdateExpression).toContain('templateGreeting')
    })

    it('regenerates greeting with new name for image type', async () => {
      const existingGreeting = GREETING_TEMPLATES.image.replace('{itemName}', 'Old Photo')
      const existingItem = makeExistingItem({
        itemName: { S: 'Old Photo' },
        templateGreeting: { S: existingGreeting },
        itemType: { S: 'image' },
      })

      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: existingItem })
        }
        return Promise.resolve({ Attributes: {
          ...existingItem,
          itemName: { S: 'New Photo' },
          updatedAt: { S: new Date().toISOString() },
        }})
      })

      const result = await handler(makeEvent({
        body: { itemName: 'New Photo' },
      }))

      expect(result.statusCode).toBe(200)

      const updateCall = findUpdateCall()
      const values = updateCall.input.ExpressionAttributeValues

      // Should use the image template, not document
      const expectedGreeting = GREETING_TEMPLATES.image.replace('{itemName}', 'New Photo')
      expect(values[':templateGreeting'].S).toBe(expectedGreeting)
    })
  })

  describe('no regeneration when item has no existing templateGreeting (R1.4)', () => {
    it('does not add templateGreeting when item lacks the field (pre-feature item)', async () => {
      const existingItem = makeExistingItem({
        // no templateGreeting field
        itemType: { S: 'document' },
      })

      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: existingItem })
        }
        return Promise.resolve({ Attributes: {
          ...existingItem,
          itemName: { S: 'Updated Name' },
          updatedAt: { S: new Date().toISOString() },
        }})
      })

      const result = await handler(makeEvent({
        body: { itemName: 'Updated Name' },
      }))

      expect(result.statusCode).toBe(200)

      const updateCall = findUpdateCall()
      const values = updateCall.input.ExpressionAttributeValues

      // templateGreeting should NOT be in the update
      expect(values[':templateGreeting']).toBeUndefined()
      expect(updateCall.input.UpdateExpression).not.toContain('templateGreeting')
    })
  })

  describe('correct template type is preserved on regeneration (R1.4)', () => {
    it('defaults to document template when itemType is missing on existing record', async () => {
      const existingGreeting = GREETING_TEMPLATES.document.replace('{itemName}', 'Old Name')
      const existingItem = makeExistingItem({
        templateGreeting: { S: existingGreeting },
        // no itemType field — should default to 'document'
      })

      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: existingItem })
        }
        return Promise.resolve({ Attributes: {
          ...existingItem,
          itemName: { S: 'Renamed Item' },
          updatedAt: { S: new Date().toISOString() },
        }})
      })

      const result = await handler(makeEvent({
        body: { itemName: 'Renamed Item' },
      }))

      expect(result.statusCode).toBe(200)

      const updateCall = findUpdateCall()
      const values = updateCall.input.ExpressionAttributeValues

      // Should use document template (default)
      const expectedGreeting = GREETING_TEMPLATES.document.replace('{itemName}', 'Renamed Item')
      expect(values[':templateGreeting'].S).toBe(expectedGreeting)
    })
  })
})
