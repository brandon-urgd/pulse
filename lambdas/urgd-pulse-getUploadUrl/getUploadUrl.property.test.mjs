// Property test for urgd-pulse-getUploadUrl
// Property 13: Upload URL File Type Property
// Validates: Requirements 4.2, 4.3, 4.4

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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler } = await import('./index.mjs')

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx']
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

describe('Property 13: Upload URL File Type Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlSpy.mockReset()
    // GetItemCommand returns a valid item, UpdateItemCommand returns {}
    dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-123' }, itemId: { S: 'item-456' }, status: { S: 'draft' } } })
    dynamoSendSpy.mockResolvedValue({})
    getSignedUrlSpy.mockResolvedValue('https://s3.amazonaws.com/presigned-url')
  })

  it('for any allowed file type, getUploadUrl succeeds with 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a filename with an allowed extension
        fc.oneof(fc.constantFrom('.md', '.txt', '.pdf', '.docx')),
        // Generate a valid file name prefix (non-empty, no dots)
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.length > 0 && !s.includes('.')),
        // Generate a valid file size (0 to 10MB)
        fc.integer({ min: 0, max: MAX_FILE_SIZE }),
        async (ext, prefix, fileSize) => {
          dynamoSendSpy.mockReset()
          getSignedUrlSpy.mockReset()
          dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-123' }, itemId: { S: 'item-456' }, status: { S: 'draft' } } })
          dynamoSendSpy.mockResolvedValue({})
          getSignedUrlSpy.mockResolvedValue('https://s3.amazonaws.com/presigned-url')

          const fileName = `${prefix}${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data.uploadUrl).toBeDefined()
          expect(typeof body.data.uploadUrl).toBe('string')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any file type NOT in the allowed set, returns 400 "Unsupported file type"', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a filename with a disallowed extension
        fc.string({ minLength: 1, maxLength: 20 })
          .filter(s => {
            const lower = s.toLowerCase()
            return !ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext)) &&
              s.length > 0 &&
              !s.includes('\0')
          }),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.length > 0 && !s.includes('.')),
        async (ext, prefix) => {
          const fileName = `${prefix}${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize: 1024 })
          const result = await handler(event)

          expect(result.statusCode).toBe(400)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('Unsupported file type')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any file exceeding 10MB, returns 400 "File too large"', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate an allowed extension
        fc.oneof(fc.constantFrom('.md', '.txt', '.pdf', '.docx')),
        // Generate a file size exceeding 10MB
        fc.integer({ min: MAX_FILE_SIZE + 1, max: MAX_FILE_SIZE * 10 }),
        async (ext, fileSize) => {
          const fileName = `document${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)

          expect(result.statusCode).toBe(400)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('File too large')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('allowed type + valid size and oversized are mutually exclusive', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom('.md', '.txt', '.pdf', '.docx')),
        fc.integer({ min: 0, max: MAX_FILE_SIZE * 10 }),
        async (ext, fileSize) => {
          dynamoSendSpy.mockReset()
          getSignedUrlSpy.mockReset()
          dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-123' }, itemId: { S: 'item-456' }, status: { S: 'draft' } } })
          dynamoSendSpy.mockResolvedValue({})
          getSignedUrlSpy.mockResolvedValue('https://s3.amazonaws.com/presigned-url')

          const fileName = `document${ext}`
          const event = makeEvent('tenant-123', 'item-456', { fileName, fileSize })
          const result = await handler(event)

          const isOversized = fileSize > MAX_FILE_SIZE
          if (isOversized) {
            // Must be 400 "File too large"
            expect(result.statusCode).toBe(400)
            expect(JSON.parse(result.body).message).toBe('File too large')
          } else {
            // Must succeed with 200
            expect(result.statusCode).toBe(200)
          }
          // These two cases are mutually exclusive — can't be both
          expect(isOversized ? result.statusCode !== 200 : result.statusCode !== 400).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })
})
