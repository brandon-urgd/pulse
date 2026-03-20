// Unit tests for urgd-pulse-getUploadUrl
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const MOCK_UPLOAD_URL = 'https://s3.amazonaws.com/urgd-shield-quarantine/presigned-url?X-Amz-Signature=abc'

function makeEvent({ tenantId = 'tenant-123', itemId = 'item-456', body = {} } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    pathParameters: itemId ? { itemId } : {},
    body: JSON.stringify(body),
  }
}

describe('urgd-pulse-getUploadUrl', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlSpy.mockReset()
    // GetItemCommand returns a valid item, UpdateItemCommand returns {}
    dynamoSendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-123' }, itemId: { S: 'item-456' } } })
    dynamoSendSpy.mockResolvedValue({})
    getSignedUrlSpy.mockResolvedValue(MOCK_UPLOAD_URL)
  })

  describe('allowed file types return 200 with uploadUrl', () => {
    it.each(['.md', '.txt', '.pdf', '.docx'])('returns 200 for %s file', async (ext) => {
      const res = await handler(makeEvent({
        body: { fileName: `document${ext}`, fileSize: 1024 },
      }))

      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.uploadUrl).toBe(MOCK_UPLOAD_URL)
      expect(body.data.key).toMatch(new RegExp(`document\\${ext}$`)) // nosemgrep: detect-non-literal-regexp
    })

    it('returns 200 for uppercase extension (case-insensitive)', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 'document.PDF', fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(200)
    })

    it('returns 200 when fileSize is not provided', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 'document.md' },
      }))
      expect(res.statusCode).toBe(200)
    })
  })

  describe('disallowed file type returns 400', () => {
    it.each(['.exe', '.js', '.zip', '.png', '.mp4', ''])('returns 400 for %s extension', async (ext) => {
      const res = await handler(makeEvent({
        body: { fileName: `document${ext}`, fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toBe('Unsupported file type')
    })

    it('returns 400 for file with no extension', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 'nodotfile', fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toBe('Unsupported file type')
    })
  })

  describe('file size > 10MB returns 400', () => {
    it('returns 400 when fileSize exceeds 10MB', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 'document.pdf', fileSize: 10 * 1024 * 1024 + 1 },
      }))
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).toBe('File too large')
    })

    it('returns 200 when fileSize is exactly 10MB', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 'document.pdf', fileSize: 10 * 1024 * 1024 },
      }))
      expect(res.statusCode).toBe(200)
    })
  })

  describe('missing fileName returns 400', () => {
    it('returns 400 when fileName is missing', async () => {
      const res = await handler(makeEvent({
        body: { fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when fileName is empty string', async () => {
      const res = await handler(makeEvent({
        body: { fileName: '', fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 when fileName is not a string', async () => {
      const res = await handler(makeEvent({
        body: { fileName: 123, fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(400)
    })
  })

  describe('missing tenantId returns 401', () => {
    it('returns 401 when tenantId is missing from authorizer context', async () => {
      const res = await handler(makeEvent({ tenantId: null }))
      expect(res.statusCode).toBe(401)
    })
  })

  describe('DynamoDB UpdateItem called with documentStatus "scanning"', () => {
    it('calls UpdateItem with documentStatus set to "scanning"', async () => {
      await handler(makeEvent({
        body: { fileName: 'document.pdf', fileSize: 1024 },
      }))

      // First call is GetItemCommand (verify item exists), second is UpdateItemCommand
      expect(dynamoSendSpy).toHaveBeenCalledTimes(2)
      const updateCall = dynamoSendSpy.mock.calls[1][0]
      expect(updateCall.input.UpdateExpression).toContain('documentStatus')
      expect(updateCall.input.ExpressionAttributeValues[':status'].S).toBe('scanning')
    })

    it('stores the S3 key in documentKey', async () => {
      await handler(makeEvent({
        body: { fileName: 'report.docx', fileSize: 2048 },
      }))

      const updateCall = dynamoSendSpy.mock.calls[1][0]
      expect(updateCall.input.ExpressionAttributeValues[':key'].S).toMatch(/pulse\/tenant-123\/items\/item-456\/report\.docx$/)
    })

    it('does not call DynamoDB when file type is invalid', async () => {
      await handler(makeEvent({
        body: { fileName: 'malware.exe', fileSize: 1024 },
      }))
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('returns 500 when DynamoDB throws', async () => {
      getSignedUrlSpy.mockResolvedValue(MOCK_UPLOAD_URL)
      dynamoSendSpy.mockReset()
      dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const res = await handler(makeEvent({
        body: { fileName: 'document.pdf', fileSize: 1024 },
      }))
      expect(res.statusCode).toBe(500)
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { requestId: 'req-test', authorizer: { tenantId: 'tenant-123' } },
        pathParameters: { itemId: 'item-456' },
        body: 'not-json',
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
