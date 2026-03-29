// Unit tests for urgd-pulse-shieldCallback — image branch
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('QUARANTINE_BUCKET_NAME', 'urgd-shield-quarantine-dev-123456789')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('EXTRACT_TEXT_FUNCTION_NAME', 'urgd-pulse-extractText-dev')
vi.stubEnv('ANALYZE_DOCUMENT_FUNCTION_ARN', 'arn:aws:lambda:us-west-2:123456789:function:urgd-pulse-analyzeDocument-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class CopyObjectCommand { constructor(input) { this.input = input } }
  class DeleteObjectCommand { constructor(input) { this.input = input } }
  class GetObjectTaggingCommand { constructor(input) { this.input = input } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectTaggingCommand, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send(...args) { return lambdaSendSpy(...args) }
  }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

const { handler } = await import('../../lambdas/urgd-pulse-shieldCallback/index.mjs')

const QUARANTINE_BUCKET = 'urgd-shield-quarantine-dev-123456789'
const DATA_BUCKET = 'urgd-pulse-data-dev'

function makeEvent(objectKey) {
  return {
    detail: {
      bucket: { name: QUARANTINE_BUCKET },
      object: { key: objectKey },
    },
  }
}

function mockScanResult(scanStatus) {
  s3SendSpy.mockReset()
  s3SendSpy.mockResolvedValueOnce({
    TagSet: scanStatus ? [{ Key: 'GuardDutyMalwareScanStatus', Value: scanStatus }] : [],
  })
  s3SendSpy.mockResolvedValue({})
}

describe('urgd-pulse-shieldCallback — image branch', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
    mockScanResult('NO_THREATS_FOUND')
  })

  describe('.jpg → no extractText, documentStatus: ready, itemType: image', () => {
    it('handles .jpg image file correctly', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.jpg'
      await handler(makeEvent(objectKey))

      // Should NOT invoke extractText
      expect(lambdaSendSpy).not.toHaveBeenCalled()

      // Should update DynamoDB with documentStatus: ready
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('.jpeg → no extractText, documentStatus: ready, itemType: image', () => {
    it('handles .jpeg image file correctly', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.jpeg'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).not.toHaveBeenCalled()
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('.png → no extractText, documentStatus: ready, itemType: image', () => {
    it('handles .png image file correctly', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.png'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).not.toHaveBeenCalled()
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('.webp → no extractText, documentStatus: ready, itemType: image', () => {
    it('handles .webp image file correctly', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.webp'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).not.toHaveBeenCalled()
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('.gif → no extractText, documentStatus: ready, itemType: image', () => {
    it('handles .gif image file correctly', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/animation.gif'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).not.toHaveBeenCalled()
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('.pdf → extractText invoked (unchanged behavior)', () => {
    it('invokes extractText for .pdf files', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/document.pdf'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).toHaveBeenCalledOnce()
      const lambdaCall = lambdaSendSpy.mock.calls[0][0]
      expect(lambdaCall.input.FunctionName).toBe('urgd-pulse-extractText-dev')
      expect(lambdaCall.input.InvocationType).toBe('Event')
    })
  })

  describe('.docx → extractText invoked (unchanged behavior)', () => {
    it('invokes extractText for .docx files', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/document.docx'
      await handler(makeEvent(objectKey))

      expect(lambdaSendSpy).toHaveBeenCalledOnce()
      const lambdaCall = lambdaSendSpy.mock.calls[0][0]
      expect(lambdaCall.input.FunctionName).toBe('urgd-pulse-extractText-dev')
    })
  })

  describe('image sets itemType: image on DynamoDB record', () => {
    it('sets itemType to image in DynamoDB UpdateItem', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.png'
      await handler(makeEvent(objectKey))

      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':itemType'].S).toBe('image')
    })
  })

  describe('image sets totalSections: 1 and recommendedTimeLimitMinutes: 7', () => {
    it('sets totalSections to 1 and recommendedTimeLimitMinutes to 7 for image files', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/photo.jpg'
      await handler(makeEvent(objectKey))

      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':totalSections'].N).toBe('1')
      expect(dynamoCall.input.ExpressionAttributeValues[':recommendedTimeLimitMinutes'].N).toBe('7')
    })
  })
})
