// Unit tests for urgd-pulse-shieldCallback
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('QUARANTINE_BUCKET_NAME', 'urgd-shield-quarantine-dev-123456789')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('EXTRACT_TEXT_FUNCTION_NAME', 'urgd-pulse-extractText-dev')
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
  return { S3Client, CopyObjectCommand, DeleteObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient {
    send(...args) { return lambdaSendSpy(...args) }
  }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent({ bucketName, objectKey, tags = {} } = {}) {
  return {
    detail: {
      bucket: bucketName ? { name: bucketName } : undefined,
      object: objectKey ? { key: objectKey } : undefined,
      tags,
    },
  }
}

const QUARANTINE_BUCKET = 'urgd-shield-quarantine-dev-123456789'
const DATA_BUCKET = 'urgd-pulse-data-dev'

describe('urgd-pulse-shieldCallback', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    lambdaSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValue({})
    s3SendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
  })

  describe('NO_THREATS_FOUND + .md/.txt: copies file, sets documentStatus "ready"', () => {
    it.each(['.md', '.txt'])('handles %s file with NO_THREATS_FOUND', async (ext) => {
      const objectKey = `pulse/tenant-abc/items/item-xyz/document${ext}`
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey,
        tags: { GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' },
      })

      await handler(event)

      // Should copy from quarantine to data bucket
      const s3Calls = s3SendSpy.mock.calls.map(c => c[0])
      const copyCall = s3Calls.find(c => c.constructor.name === 'CopyObjectCommand')
      expect(copyCall).toBeDefined()
      expect(copyCall.input.Bucket).toBe(DATA_BUCKET)
      expect(copyCall.input.Key).toBe(objectKey)

      // Should delete from quarantine
      const deleteCall = s3Calls.find(c => c.constructor.name === 'DeleteObjectCommand')
      expect(deleteCall).toBeDefined()
      expect(deleteCall.input.Bucket).toBe(QUARANTINE_BUCKET)

      // Should set documentStatus to "ready"
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')

      // Should NOT invoke extractText
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('NO_THREATS_FOUND + .pdf/.docx: copies file, sets "extracting", invokes extractText async', () => {
    it.each(['.pdf', '.docx'])('handles %s file with NO_THREATS_FOUND', async (ext) => {
      const objectKey = `pulse/tenant-abc/items/item-xyz/document${ext}`
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey,
        tags: { GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' },
      })

      await handler(event)

      // Should copy file
      const s3Calls = s3SendSpy.mock.calls.map(c => c[0])
      const copyCall = s3Calls.find(c => c.constructor.name === 'CopyObjectCommand')
      expect(copyCall).toBeDefined()

      // Should set documentStatus to "extracting"
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extracting')

      // Should invoke extractText async
      expect(lambdaSendSpy).toHaveBeenCalledOnce()
      const lambdaCall = lambdaSendSpy.mock.calls[0][0]
      expect(lambdaCall.input.FunctionName).toBe('urgd-pulse-extractText-dev')
      expect(lambdaCall.input.InvocationType).toBe('Event')

      // Payload should contain tenantId, itemId, key, bucket
      const payload = JSON.parse(Buffer.from(lambdaCall.input.Payload).toString())
      expect(payload.tenantId).toBe('tenant-abc')
      expect(payload.itemId).toBe('item-xyz')
      expect(payload.key).toBe(objectKey)
      expect(payload.bucket).toBe(DATA_BUCKET)
    })
  })

  describe('THREATS_FOUND: deletes from quarantine, sets "rejected", logs security event', () => {
    it('deletes file and sets documentStatus to "rejected"', async () => {
      const objectKey = 'pulse/tenant-abc/items/item-xyz/malware.pdf'
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey,
        tags: { GuardDutyMalwareScanStatus: 'THREATS_FOUND' },
      })

      await handler(event)

      // Should delete from quarantine
      const s3Calls = s3SendSpy.mock.calls.map(c => c[0])
      const deleteCall = s3Calls.find(c => c.constructor.name === 'DeleteObjectCommand')
      expect(deleteCall).toBeDefined()
      expect(deleteCall.input.Bucket).toBe(QUARANTINE_BUCKET)
      expect(deleteCall.input.Key).toBe(objectKey)

      // Should NOT copy to data bucket
      const copyCall = s3Calls.find(c => c.constructor.name === 'CopyObjectCommand')
      expect(copyCall).toBeUndefined()

      // Should set documentStatus to "rejected"
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('rejected')

      // Should NOT invoke extractText
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('missing bucket/key in event: logs error and returns', () => {
    it('returns without error when bucket is missing', async () => {
      const event = makeEvent({ objectKey: 'pulse/tenant/items/item/doc.pdf' })
      await expect(handler(event)).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('returns without error when key is missing', async () => {
      const event = makeEvent({ bucketName: QUARANTINE_BUCKET })
      await expect(handler(event)).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('returns without error when detail is missing', async () => {
      await expect(handler({})).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('unknown scan result: logs warning', () => {
    it('does not throw and does not update DynamoDB for unknown scan result', async () => {
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey: 'pulse/tenant-abc/items/item-xyz/doc.pdf',
        tags: { GuardDutyMalwareScanStatus: 'UNKNOWN_STATUS' },
      })

      await expect(handler(event)).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
      expect(s3SendSpy).not.toHaveBeenCalled()
    })

    it('handles missing scan result tag gracefully', async () => {
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey: 'pulse/tenant-abc/items/item-xyz/doc.pdf',
        tags: {},
      })

      await expect(handler(event)).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('key parsing', () => {
    it('correctly extracts tenantId and itemId from key path', async () => {
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey: 'pulse/my-tenant-id/items/my-item-id/document.txt',
        tags: { GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' },
      })

      await handler(event)

      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.Key.tenantId.S).toBe('my-tenant-id')
      expect(dynamoCall.input.Key.itemId.S).toBe('my-item-id')
    })

    it('returns without error for malformed key path', async () => {
      const event = makeEvent({
        bucketName: QUARANTINE_BUCKET,
        objectKey: 'bad/path',
        tags: { GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' },
      })

      await expect(handler(event)).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })
})
