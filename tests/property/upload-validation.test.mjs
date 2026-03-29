// Property-based tests for upload URL validation
// Property P14

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('QUARANTINE_BUCKET_NAME', 'urgd-shield-quarantine-dev-123456789')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, PutObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler } = await import('../../lambdas/urgd-pulse-getUploadUrl/index.mjs')

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx', '.jpg', '.jpeg', '.png', '.webp', '.gif']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

function makeEvent(tenantId, itemId, body) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
    body: JSON.stringify(body),
  }
}

function setupMocks() {
  dynamoSendSpy.mockReset()
  s3SendSpy.mockReset()
  getSignedUrlSpy.mockReset()
  // GetItem returns valid item, UpdateItem returns {}
  dynamoSendSpy.mockResolvedValueOnce({
    Item: { tenantId: { S: 'tenant-123' }, itemId: { S: 'item-456' } },
  })
  dynamoSendSpy.mockResolvedValue({})
  getSignedUrlSpy.mockResolvedValue('https://s3.amazonaws.com/presigned-url')
}

/**
 * Property P14: Upload validation
 *
 * - Image extensions (.jpg, .jpeg, .png, .webp, .gif) → accepted
 * - Document extensions (.pdf, .docx, .md, .txt) → accepted
 * - Other extensions → rejected with 400
 * - File size > 10MB → rejected with 400
 *
 * Validates: Requirements 6.8, 6.9
 */
describe('Property P14: Upload validation', () => {
  beforeEach(() => {
    setupMocks()
  })

  it('image extensions are accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.jpg', '.jpeg', '.png', '.webp', '.gif'),
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('.') && s.trim().length > 0),
        async (ext, prefix) => {
          setupMocks()
          const fileName = `${prefix}${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize: 1024 })
          const result = await handler(event)
          expect(result.statusCode).toBe(200)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document extensions are accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.md', '.txt', '.pdf', '.docx'),
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => !s.includes('.') && s.trim().length > 0),
        async (ext, prefix) => {
          setupMocks()
          const fileName = `${prefix}${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize: 1024 })
          const result = await handler(event)
          expect(result.statusCode).toBe(200)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('unsupported extensions are rejected with 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 2, maxLength: 10 })
          .filter(s => {
            const lower = s.toLowerCase()
            return lower.startsWith('.') &&
              !ALLOWED_EXTENSIONS.includes(lower) &&
              /^\.[a-z0-9]+$/.test(lower)
          }),
        async (ext) => {
          const fileName = `document${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize: 1024 })
          const result = await handler(event)
          expect(result.statusCode).toBe(400)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('Unsupported file type')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('file size > 10MB is rejected with 400', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.md', '.txt', '.pdf', '.docx', '.jpg', '.png'),
        fc.integer({ min: MAX_FILE_SIZE + 1, max: MAX_FILE_SIZE * 5 }),
        async (ext, fileSize) => {
          const fileName = `document${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)
          expect(result.statusCode).toBe(400)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('File too large')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('valid size and oversized are mutually exclusive for allowed extensions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('.md', '.txt', '.pdf', '.docx', '.jpg', '.png'),
        fc.integer({ min: 0, max: MAX_FILE_SIZE * 2 }),
        async (ext, fileSize) => {
          setupMocks()
          const fileName = `document${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)

          const isOversized = fileSize > MAX_FILE_SIZE
          if (isOversized) {
            expect(result.statusCode).toBe(400)
            expect(JSON.parse(result.body).message).toBe('File too large')
          } else {
            expect(result.statusCode).toBe(200)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('all allowed extensions produce 200 with valid file size', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALLOWED_EXTENSIONS),
        fc.integer({ min: 1, max: MAX_FILE_SIZE }),
        async (ext, fileSize) => {
          setupMocks()
          const fileName = `testfile${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)
          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data.uploadUrl).toBeDefined()
        },
      ),
      { numRuns: 100 },
    )
  })
})
