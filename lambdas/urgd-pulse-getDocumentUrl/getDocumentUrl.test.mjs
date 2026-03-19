// Unit tests for urgd-pulse-getDocumentUrl
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const getSignedUrlMock = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return sendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlMock(...args),
}))

const { handler } = await import('./index.mjs')

function makeEvent(itemId = 'item-1') {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-1' },
    },
    pathParameters: { itemId },
  }
}

function makeItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
    documentStatus: { S: 'ready' },
    documentKey: { S: 'pulse/tenant-1/items/item-1/document.pdf' },
    ...overrides,
  }
}

describe('urgd-pulse-getDocumentUrl', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    getSignedUrlMock.mockReset()
    getSignedUrlMock.mockResolvedValue('https://s3.example.com/presigned-url')
  })

  describe('successful URL generation', () => {
    it('returns 200 with presigned URL for PDF', async () => {
      sendSpy.mockResolvedValueOnce({ Item: makeItem() })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.url).toBe('https://s3.example.com/presigned-url')
      expect(body.data.contentType).toBe('application/pdf')
      expect(body.data.filename).toBe('document.pdf')
    })

    it('returns originalUrl for .docx files', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeItem({ documentKey: { S: 'pulse/tenant-1/items/item-1/document.docx' } }),
      })

      getSignedUrlMock
        .mockResolvedValueOnce('https://s3.example.com/original-docx')
        .mockResolvedValueOnce('https://s3.example.com/extracted-md')

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.url).toBe('https://s3.example.com/extracted-md')
      expect(body.data.originalUrl).toBe('https://s3.example.com/original-docx')
    })

    it('returns correct contentType for markdown files', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeItem({ documentKey: { S: 'pulse/tenant-1/items/item-1/document.md' } }),
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.contentType).toBe('text/markdown')
    })
  })

  describe('error cases', () => {
    it('returns 404 when documentStatus is not ready', async () => {
      sendSpy.mockResolvedValueOnce({
        Item: makeItem({ documentStatus: { S: 'scanning' } }),
      })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body).message).toMatch(/no document/i)
    })

    it('returns 401 when tenantId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: {} },
        pathParameters: { itemId: 'item-1' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 when item not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(404)
    })

    it('returns 500 on DynamoDB failure', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(500)
    })
  })
})
