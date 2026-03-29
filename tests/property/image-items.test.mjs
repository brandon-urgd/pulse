// Property-based tests for image item handling
// Properties P10, P11, P12, P13

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Env stubs ──
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('QUARANTINE_BUCKET_NAME', 'urgd-shield-quarantine-dev')
vi.stubEnv('EXTRACT_TEXT_FUNCTION_NAME', 'urgd-pulse-extractText-dev')
vi.stubEnv('ANALYZE_DOCUMENT_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-analyzeDocument-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const lambdaSendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

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
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  class CopyObjectCommand { constructor(input) { this.input = input } }
  class DeleteObjectCommand { constructor(input) { this.input = input } }
  class GetObjectTaggingCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectTaggingCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler: createItemHandler } = await import('../../lambdas/urgd-pulse-createItem/index.mjs')
const { handler: shieldCallbackHandler } = await import('../../lambdas/urgd-pulse-shieldCallback/index.mjs')

// ── Multimodal content block logic (mirroring chat lambda) ──
function buildBedrockMessages(itemType, imageBase64, imageMediaType, userMessage, history) {
  const messages = [...history, { role: 'user', content: userMessage }]
  if (itemType === 'image' && imageBase64) {
    const lastIdx = messages.length - 1
    const lastMsg = messages[lastIdx]
    if (lastMsg.role === 'user') {
      messages[lastIdx] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageMediaType, data: imageBase64 } },
          { type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : '' },
        ],
      }
    }
  }
  return messages
}

// ── PulseLine visibility logic ──
function shouldShowPulseLine(totalSections) {
  return totalSections > 1
}

function makeCreateItemEvent(tenantId, itemType) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { tenantId },
    },
    body: JSON.stringify({
      itemName: 'Test Item',
      description: 'A test description for the item',
      closeDate: new Date(Date.now() + 86400000 * 30).toISOString(),
      itemType,
    }),
  }
}

function makeShieldEvent(bucket, key) {
  return {
    detail: { bucket: { name: bucket }, object: { key } },
  }
}

/**
 * Property P10: Image item defaults
 *
 * Image MIME types → itemType: "image", totalSections: 1, recommendedTimeLimitMinutes: 7
 * Document MIME types → itemType: "document"
 *
 * Validates: Requirements 6.1, 6.6, 12.2
 */
describe('Property P10: Image item defaults', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()

    // Tenant lookup
    dynamoSendSpy.mockResolvedValueOnce({
      Item: {
        tenantId: { S: 'tenant-test' },
        tier: { S: 'pro' },
        features: { M: { maxActiveItems: { N: '100' } } },
        serviceFlags: { M: {} },
      },
    })
    // SYSTEM lookup
    dynamoSendSpy.mockResolvedValueOnce({ Item: null })
    // Count query
    dynamoSendSpy.mockResolvedValueOnce({ Count: 0 })
    // PutItem
    dynamoSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
    s3SendSpy.mockResolvedValue({})
  })

  it('image MIME type → itemType: image, totalSections: 1, recommendedTimeLimitMinutes: 7', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('image/jpeg', 'image/png', 'image/webp', 'image/gif'),
        async (mimeType) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          s3SendSpy.mockReset()

          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: 'tenant-test' },
              tier: { S: 'pro' },
              features: { M: { maxActiveItems: { N: '100' } } },
              serviceFlags: { M: {} },
            },
          })
          dynamoSendSpy.mockResolvedValueOnce({ Item: null })
          dynamoSendSpy.mockResolvedValueOnce({ Count: 0 })

          let capturedPutItem = null
          dynamoSendSpy.mockImplementation((cmd) => {
            if (cmd.input?.Item) {
              capturedPutItem = cmd.input.Item
            }
            return Promise.resolve({})
          })
          lambdaSendSpy.mockResolvedValue({})
          s3SendSpy.mockResolvedValue({})

          const event = makeCreateItemEvent('tenant-test', mimeType)
          const result = await createItemHandler(event)

          expect(result.statusCode).toBe(201)
          expect(capturedPutItem).not.toBeNull()
          expect(capturedPutItem.itemType?.S).toBe('image')
          expect(capturedPutItem.totalSections?.N).toBe('1')
          expect(capturedPutItem.recommendedTimeLimitMinutes?.N).toBe('7')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document MIME type → itemType: document, no totalSections override', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('application/pdf', 'text/markdown', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        async (mimeType) => {
          dynamoSendSpy.mockReset()
          lambdaSendSpy.mockReset()
          s3SendSpy.mockReset()

          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: 'tenant-test' },
              tier: { S: 'pro' },
              features: { M: { maxActiveItems: { N: '100' } } },
              serviceFlags: { M: {} },
            },
          })
          dynamoSendSpy.mockResolvedValueOnce({ Item: null })
          dynamoSendSpy.mockResolvedValueOnce({ Count: 0 })

          let capturedPutItem = null
          dynamoSendSpy.mockImplementation((cmd) => {
            if (cmd.input?.Item) {
              capturedPutItem = cmd.input.Item
            }
            return Promise.resolve({})
          })
          lambdaSendSpy.mockResolvedValue({})
          s3SendSpy.mockResolvedValue({})

          const event = makeCreateItemEvent('tenant-test', mimeType)
          const result = await createItemHandler(event)

          expect(result.statusCode).toBe(201)
          expect(capturedPutItem).not.toBeNull()
          expect(capturedPutItem.itemType?.S).toBe('document')
          // Document items should NOT have totalSections: 1 set
          expect(capturedPutItem.totalSections?.N).not.toBe('1')
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P11: Image shield callback bypass
 *
 * Image extensions → no extractText invocation, documentStatus: "ready" immediately.
 * Document extensions → extractText invoked.
 *
 * Validates: Requirements 6.2
 */
describe('Property P11: Image shield callback bypass', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
  })

  it('image extension → no extractText invocation, documentStatus: ready', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.jpg', '.jpeg', '.png', '.webp', '.gif'),
        async (ext) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          lambdaSendSpy.mockReset()

          const key = `pulse/tenant-test/items/item-test/photo${ext}`

          // GetObjectTagging → NO_THREATS_FOUND
          s3SendSpy.mockResolvedValueOnce({
            TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }],
          })
          // CopyObject
          s3SendSpy.mockResolvedValueOnce({})
          // DeleteObject
          s3SendSpy.mockResolvedValueOnce({})
          // DynamoDB UpdateItem
          dynamoSendSpy.mockResolvedValue({})
          lambdaSendSpy.mockResolvedValue({})

          await shieldCallbackHandler(makeShieldEvent('quarantine-bucket', key))

          // Lambda (extractText) should NOT have been called
          expect(lambdaSendSpy).not.toHaveBeenCalled()

          // DynamoDB update should have been called with documentStatus: ready
          expect(dynamoSendSpy).toHaveBeenCalled()
          const updateCall = dynamoSendSpy.mock.calls[0][0]
          expect(updateCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('pdf/docx extension → extractText invoked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.pdf', '.docx'),
        async (ext) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          lambdaSendSpy.mockReset()

          const key = `pulse/tenant-test/items/item-test/document${ext}`

          s3SendSpy.mockResolvedValueOnce({
            TagSet: [{ Key: 'GuardDutyMalwareScanStatus', Value: 'NO_THREATS_FOUND' }],
          })
          s3SendSpy.mockResolvedValueOnce({}) // CopyObject
          s3SendSpy.mockResolvedValueOnce({}) // DeleteObject
          dynamoSendSpy.mockResolvedValue({})
          lambdaSendSpy.mockResolvedValue({})

          await shieldCallbackHandler(makeShieldEvent('quarantine-bucket', key))

          // Lambda (extractText) SHOULD have been called
          expect(lambdaSendSpy).toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P12: Multimodal Bedrock request construction
 *
 * image itemType → messages contain at least one type: "image" content block with source.type: "base64"
 * document itemType → no image content blocks
 *
 * Validates: Requirements 6.3
 */
describe('Property P12: Multimodal Bedrock request construction', () => {
  it('image itemType with imageBase64 → last user message has image content block', () => {
    fc.assert(
      fc.property(
        fc.base64String({ minLength: 10, maxLength: 100 }),
        fc.constantFrom('image/jpeg', 'image/png', 'image/webp', 'image/gif'),
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant'),
            content: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        (imageBase64, mediaType, userMessage, history) => {
          const messages = buildBedrockMessages('image', imageBase64, mediaType, userMessage, history)

          // Find the last user message
          const lastUserMsg = messages.filter(m => m.role === 'user').pop()
          expect(lastUserMsg).toBeDefined()
          expect(Array.isArray(lastUserMsg.content)).toBe(true)

          const imageBlock = lastUserMsg.content.find(b => b.type === 'image')
          expect(imageBlock).toBeDefined()
          expect(imageBlock.source.type).toBe('base64')
          expect(imageBlock.source.data).toBe(imageBase64)
          expect(imageBlock.source.media_type).toBe(mediaType)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document itemType → no image content blocks', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.array(
          fc.record({
            role: fc.constantFrom('user', 'assistant'),
            content: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        (userMessage, history) => {
          const messages = buildBedrockMessages('document', null, 'image/jpeg', userMessage, history)

          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              const imageBlocks = msg.content.filter(b => b.type === 'image')
              expect(imageBlocks.length).toBe(0)
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('image itemType without imageBase64 → no image content blocks', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (userMessage) => {
          const messages = buildBedrockMessages('image', null, 'image/jpeg', userMessage, [])

          for (const msg of messages) {
            if (Array.isArray(msg.content)) {
              const imageBlocks = msg.content.filter(b => b.type === 'image')
              expect(imageBlocks.length).toBe(0)
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P13: PulseLine visibility
 *
 * totalSections === 1 → PulseLine hidden (false)
 * totalSections > 1 → PulseLine shown (true)
 *
 * Validates: Requirements 6.7, 10.3
 */
describe('Property P13: PulseLine visibility', () => {
  it('totalSections === 1 → PulseLine hidden', () => {
    expect(shouldShowPulseLine(1)).toBe(false)
  })

  it('totalSections > 1 → PulseLine shown', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 20 }),
        (totalSections) => {
          expect(shouldShowPulseLine(totalSections)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('totalSections 1 and >1 are mutually exclusive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (totalSections) => {
          const shown = shouldShowPulseLine(totalSections)
          if (totalSections === 1) {
            expect(shown).toBe(false)
          } else {
            expect(shown).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
