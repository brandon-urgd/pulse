// Unit tests for urgd-pulse-extractText
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

// Mock S3 with a readable stream body
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

// Mock Lambda client (used for analyzeDocument and renderPages invocations)
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

// Mock pdf-parse
vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}))

// Mock mammoth
vi.mock('mammoth', () => ({
  extractRawText: vi.fn(),
}))

import pdfParse from 'pdf-parse'
import * as mammoth from 'mammoth'

const { handler } = await import('./index.mjs')

/**
 * Create an async iterable stream from a buffer (simulates S3 Body).
 */
function makeStream(buffer) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield buffer
    },
  }
}

function makeEvent({ tenantId = 'tenant-abc', itemId = 'item-xyz', key, bucket = 'urgd-pulse-data-dev' } = {}) {
  return { tenantId, itemId, key, bucket }
}

describe('urgd-pulse-extractText', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    vi.mocked(pdfParse).mockReset()
    vi.mocked(mammoth.extractRawText).mockReset()
    // Default: GetItemCommand returns item with itemName, UpdateItemCommand succeeds
    dynamoSendSpy.mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({ Item: { itemName: { S: 'Test Document' } } })
      }
      return Promise.resolve({})
    })
    s3SendSpy.mockResolvedValue({})
  })

  describe('PDF extraction', () => {
    it('reads from S3, calls pdf-parse, stores extracted.md, sets documentStatus "ready"', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) }) // GetObject
      s3SendSpy.mockResolvedValueOnce({}) // PutObject
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: '# Extracted PDF Content\n\nSome text here.' })

      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' })
      await handler(event)

      // Should call pdf-parse with the buffer
      expect(pdfParse).toHaveBeenCalledOnce()
      const pdfCall = vi.mocked(pdfParse).mock.calls[0][0]
      expect(Buffer.isBuffer(pdfCall)).toBe(true)

      // Should store extracted text at extracted.md
      const s3Calls = s3SendSpy.mock.calls.map(c => c[0])
      const putCall = s3Calls.find(c => c.constructor.name === 'PutObjectCommand')
      expect(putCall).toBeDefined()
      expect(putCall.input.Key).toBe('pulse/tenant-abc/items/item-xyz/extracted.md')
      expect(putCall.input.Body).toBe('# Extracted PDF Content\n\nSome text here.')
      expect(putCall.input.ContentType).toBe('text/markdown')

      // Should set documentStatus to "ready" with templateGreeting
      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const updateCall = dynamoCalls.find(c => c.constructor.name === 'UpdateItemCommand')
      expect(updateCall).toBeDefined()
      expect(updateCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(updateCall.input.ExpressionAttributeValues[':extractedKey'].S).toBe(
        'pulse/tenant-abc/items/item-xyz/extracted.md'
      )
      expect(updateCall.input.ExpressionAttributeValues[':templateGreeting'].S).toContain('Test Document')
    })
  })

  describe('DOCX extraction', () => {
    it('reads from S3, calls mammoth, stores extracted.md, sets documentStatus "ready"', async () => {
      const docxBuffer = Buffer.from('PK fake docx content')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(docxBuffer) }) // GetObject
      s3SendSpy.mockResolvedValueOnce({}) // PutObject
      vi.mocked(mammoth.extractRawText).mockResolvedValueOnce({ value: 'Extracted DOCX text content.' })

      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.docx' })
      await handler(event)

      // Should call mammoth with the buffer
      expect(mammoth.extractRawText).toHaveBeenCalledOnce()
      const mammothCall = vi.mocked(mammoth.extractRawText).mock.calls[0][0]
      expect(Buffer.isBuffer(mammothCall.buffer)).toBe(true)

      // Should store extracted text at extracted.md
      const s3Calls = s3SendSpy.mock.calls.map(c => c[0])
      const putCall = s3Calls.find(c => c.constructor.name === 'PutObjectCommand')
      expect(putCall).toBeDefined()
      expect(putCall.input.Key).toBe('pulse/tenant-abc/items/item-xyz/extracted.md')
      expect(putCall.input.Body).toBe('Extracted DOCX text content.')

      // Should set documentStatus to "ready" with templateGreeting
      const dynamoCalls = dynamoSendSpy.mock.calls.map(c => c[0])
      const updateCall = dynamoCalls.find(c => c.constructor.name === 'UpdateItemCommand')
      expect(updateCall).toBeDefined()
      expect(updateCall.input.ExpressionAttributeValues[':status'].S).toBe('ready')
      expect(updateCall.input.ExpressionAttributeValues[':templateGreeting'].S).toContain('Test Document')
    })
  })

  describe('extraction failure', () => {
    it('sets documentStatus to "extraction_failed" when pdf-parse throws', async () => {
      const pdfBuffer = Buffer.from('corrupted pdf')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      vi.mocked(pdfParse).mockRejectedValueOnce(new Error('PDF parse error'))

      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' })
      await handler(event)

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extraction_failed')
    })

    it('sets documentStatus to "extraction_failed" when mammoth throws', async () => {
      const docxBuffer = Buffer.from('corrupted docx')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(docxBuffer) })
      vi.mocked(mammoth.extractRawText).mockRejectedValueOnce(new Error('DOCX parse error'))

      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.docx' })
      await handler(event)

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extraction_failed')
    })

    it('sets documentStatus to "extraction_failed" when S3 GetObject throws', async () => {
      s3SendSpy.mockRejectedValueOnce(new Error('S3 error'))

      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' })
      await handler(event)

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extraction_failed')
    })
  })

  describe('unsupported extension', () => {
    it('sets documentStatus to "extraction_failed" for unsupported extension', async () => {
      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.txt' })
      await handler(event)

      // Should not call pdf-parse or mammoth
      expect(pdfParse).not.toHaveBeenCalled()
      expect(mammoth.extractRawText).not.toHaveBeenCalled()

      // Should set documentStatus to "extraction_failed"
      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extraction_failed')
    })

    it('sets documentStatus to "extraction_failed" for .md extension', async () => {
      const event = makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.md' })
      await handler(event)

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.ExpressionAttributeValues[':status'].S).toBe('extraction_failed')
    })
  })

  describe('missing event fields', () => {
    it('logs error and returns when tenantId is missing', async () => {
      // Pass event directly without tenantId
      await expect(handler({ itemId: 'item-xyz', key: 'pulse/t/items/i/doc.pdf', bucket: 'urgd-pulse-data-dev' })).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('logs error and returns when itemId is missing', async () => {
      await expect(handler({ tenantId: 'tenant-abc', key: 'pulse/t/items/i/doc.pdf', bucket: 'urgd-pulse-data-dev' })).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('logs error and returns when key is missing', async () => {
      await expect(handler({ tenantId: 'tenant-abc', itemId: 'item-xyz', bucket: 'urgd-pulse-data-dev' })).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('logs error and returns when bucket is missing', async () => {
      await expect(handler({ tenantId: 'tenant-abc', itemId: 'item-xyz', key: 'pulse/t/items/i/doc.pdf' })).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('logs error and returns when event is empty', async () => {
      await expect(handler({})).resolves.toBeUndefined()
      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })
})
