// Unit tests for urgd-pulse-getUploadUrl — image branch
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('QUARANTINE_BUCKET_NAME', 'urgd-shield-quarantine-dev-123456789')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlMock = vi.fn()

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
  getSignedUrl: (...args) => getSignedUrlMock(...args),
}))

function makeEvent({ tenantId, itemId, fileName, fileSize } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    pathParameters: itemId ? { itemId } : {},
    body: JSON.stringify({ fileName, fileSize }),
  }
}

function makeItemRecord() {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-123' },
      itemName: { S: 'Test Item' },
    },
  }
}

const { handler } = await import('../../lambdas/urgd-pulse-getUploadUrl/index.mjs')

describe('urgd-pulse-getUploadUrl — image branch', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlMock.mockReset()
    dynamoSendSpy.mockResolvedValue(makeItemRecord())
    getSignedUrlMock.mockResolvedValue('https://presigned-upload-url.example.com')
  })

  describe('image/jpeg → accepted (200)', () => {
    it('accepts .jpg file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'photo.jpg', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.uploadUrl).toBeDefined()
    })

    it('accepts .jpeg file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'photo.jpeg', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })
  })

  describe('image/png → accepted (200)', () => {
    it('accepts .png file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'photo.png', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })
  })

  describe('image/webp → accepted (200)', () => {
    it('accepts .webp file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'photo.webp', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })
  })

  describe('image/gif → accepted (200)', () => {
    it('accepts .gif file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'animation.gif', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })
  })

  describe('unsupported MIME type extension → 400', () => {
    it('rejects .exe file with 400', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'malware.exe', fileSize: 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })

    it('rejects .zip file with 400', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'archive.zip', fileSize: 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
    })
  })

  describe('image file exceeding 10MB → 400 (default limit, no TENANTS_TABLE)', () => {
    it('rejects image file over 10MB', async () => {
      const overLimit = 11 * 1024 * 1024 // 11MB
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'photo.jpg', fileSize: overLimit })
      const result = await handler(event)
      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('document MIME types → accepted (200)', () => {
    it('accepts .pdf file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'document.pdf', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })

    it('accepts .docx file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'document.docx', fileSize: 1024 * 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })

    it('accepts .md file', async () => {
      const event = makeEvent({ tenantId: 'tenant-abc', itemId: 'item-123', fileName: 'readme.md', fileSize: 1024 })
      const result = await handler(event)
      expect(result.statusCode).toBe(200)
    })
  })
})
