// Unit tests for urgd-pulse-getSessionFile
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlMock = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlMock(...args),
}))

const { handler } = await import('./index.mjs')

// Compute the expected fileId for a given key
import { createHash } from 'crypto'
function hashKey(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

const DOC_KEY = 'pulse/tenant-1/items/item-1/document.pdf'
const VALID_FILE_ID = hashKey(DOC_KEY)

function makeEvent(fileId = VALID_FILE_ID) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { sessionId: 'session-1', tenantId: 'tenant-1' },
    },
    pathParameters: { fileId },
  }
}

describe('urgd-pulse-getSessionFile', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlMock.mockReset()
    getSignedUrlMock.mockResolvedValue('https://s3.example.com/presigned-url')
  })

  describe('successful file URL generation', () => {
    it('returns 200 with presigned URL for PDF', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, sessionId: { S: 'session-1' }, itemId: { S: 'item-1' } } })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' }, documentKey: { S: DOC_KEY } } })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.url).toBe('https://s3.example.com/presigned-url')
      expect(body.data.contentType).toBe('application/pdf')
      expect(body.data.filename).toBe('document.pdf')
      expect(body.data.fileId).toBe(VALID_FILE_ID)
    })

    it('returns originalUrl for .docx files', async () => {
      const docxKey = 'pulse/tenant-1/items/item-1/document.docx'
      const docxFileId = hashKey(docxKey)

      sendSpy
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, sessionId: { S: 'session-1' }, itemId: { S: 'item-1' } } })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' }, documentKey: { S: docxKey } } })

      getSignedUrlMock
        .mockResolvedValueOnce('https://s3.example.com/original-docx')
        .mockResolvedValueOnce('https://s3.example.com/extracted-md')

      const res = await handler(makeEvent(docxFileId))
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.url).toBe('https://s3.example.com/extracted-md')
      expect(body.data.originalUrl).toBe('https://s3.example.com/original-docx')
    })
  })

  describe('error cases', () => {
    it('returns 404 when fileId does not match', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, sessionId: { S: 'session-1' }, itemId: { S: 'item-1' } } })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' }, documentKey: { S: DOC_KEY } } })

      const res = await handler(makeEvent('wrong-file-id'))
      expect(res.statusCode).toBe(404)
    })

    it('returns 401 when sessionId is missing', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-1' } },
        pathParameters: { fileId: VALID_FILE_ID },
      })
      expect(res.statusCode).toBe(401)
    })

    it('returns 404 when session not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: undefined })

      const res = await handler(makeEvent())
      expect(res.statusCode).toBe(404)
    })

    it('returns 404 when item has no documentKey', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, sessionId: { S: 'session-1' }, itemId: { S: 'item-1' } } })
        .mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } } })

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
