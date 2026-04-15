// Unit tests for ExtractText Lambda — template greeting storage
// Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2
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

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('pdf-parse', () => ({
  default: vi.fn(),
}))

vi.mock('mammoth', () => ({
  extractRawText: vi.fn(),
}))

import pdfParse from 'pdf-parse'
import * as mammoth from 'mammoth'
import { GREETING_TEMPLATES } from '../../lambdas/shared/greetingTemplates.mjs'

const { handler } = await import('../../lambdas/urgd-pulse-extractText/index.mjs')

function makeStream(buffer) {
  return {
    [Symbol.asyncIterator]: async function* () { yield buffer },
  }
}

function makeEvent({ tenantId = 'tenant-abc', itemId = 'item-xyz', key, bucket = 'urgd-pulse-data-dev' } = {}) {
  return { tenantId, itemId, key, bucket }
}

/** Find the UpdateItemCommand call from dynamoSendSpy */
function findUpdateCall() {
  return dynamoSendSpy.mock.calls
    .map(c => c[0])
    .find(c => c.constructor.name === 'UpdateItemCommand')
}

describe('ExtractText Lambda — template greeting storage', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    vi.mocked(pdfParse).mockReset()
    vi.mocked(mammoth.extractRawText).mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  describe('PDF items include templateGreeting in UpdateItem call (R1.1, R1.3)', () => {
    it('stores templateGreeting atomically with documentStatus=ready for PDF', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: { itemName: { S: 'My PDF Report' } } })
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Some extracted text content here.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      expect(updateCall).toBeDefined()

      // templateGreeting is in the same UpdateItem call as documentStatus=ready
      const values = updateCall.input.ExpressionAttributeValues
      expect(values[':status'].S).toBe('ready')
      expect(values[':templateGreeting']).toBeDefined()
      expect(values[':templateGreeting'].S).toContain('My PDF Report')

      // Verify the update expression includes both status and templateGreeting
      expect(updateCall.input.UpdateExpression).toContain('documentStatus')
      expect(updateCall.input.UpdateExpression).toContain('templateGreeting')
    })
  })

  describe('DOCX items include templateGreeting in UpdateItem call (R1.1, R1.3)', () => {
    it('stores templateGreeting atomically with documentStatus=ready for DOCX', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: { itemName: { S: 'My DOCX Paper' } } })
        }
        return Promise.resolve({})
      })

      const docxBuffer = Buffer.from('PK fake docx')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(docxBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(mammoth.extractRawText).mockResolvedValueOnce({ value: 'Extracted DOCX text.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.docx' }))

      const updateCall = findUpdateCall()
      expect(updateCall).toBeDefined()

      const values = updateCall.input.ExpressionAttributeValues
      expect(values[':status'].S).toBe('ready')
      expect(values[':templateGreeting']).toBeDefined()
      expect(values[':templateGreeting'].S).toContain('My DOCX Paper')
    })
  })

  describe('correct template selected based on itemType (R1.2, R2.2)', () => {
    it('uses document template for PDF/DOCX items', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: { itemName: { S: 'Design Spec' } } })
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Content here.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      const greeting = updateCall.input.ExpressionAttributeValues[':templateGreeting'].S
      const expectedGreeting = GREETING_TEMPLATES.document.replace('{itemName}', 'Design Spec')
      expect(greeting).toBe(expectedGreeting)
    })
  })

  describe('fallback when itemName is missing or empty (R1.2)', () => {
    it('uses "your document" fallback when itemName is missing', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: {} }) // no itemName field
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Content.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      const greeting = updateCall.input.ExpressionAttributeValues[':templateGreeting'].S
      expect(greeting).toContain('your document')
    })

    it('uses "your document" fallback when itemName is empty string', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: { itemName: { S: '' } } })
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Content.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      const greeting = updateCall.input.ExpressionAttributeValues[':templateGreeting'].S
      expect(greeting).toContain('your document')
    })

    it('uses "your document" fallback when itemName is whitespace only', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.resolve({ Item: { itemName: { S: '   ' } } })
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Content.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      const greeting = updateCall.input.ExpressionAttributeValues[':templateGreeting'].S
      expect(greeting).toContain('your document')
    })

    it('uses "your document" fallback when GetItem for itemName fails', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        if (cmd.constructor.name === 'GetItemCommand') {
          return Promise.reject(new Error('DynamoDB error'))
        }
        return Promise.resolve({})
      })

      const pdfBuffer = Buffer.from('%PDF-1.4 fake')
      s3SendSpy.mockResolvedValueOnce({ Body: makeStream(pdfBuffer) })
      s3SendSpy.mockResolvedValueOnce({})
      vi.mocked(pdfParse).mockResolvedValueOnce({ text: 'Content.' })

      await handler(makeEvent({ key: 'pulse/tenant-abc/items/item-xyz/document.pdf' }))

      const updateCall = findUpdateCall()
      const greeting = updateCall.input.ExpressionAttributeValues[':templateGreeting'].S
      expect(greeting).toContain('your document')
    })
  })
})
