// Unit tests for ExtractText Lambda — templateGreeting removal
// Validates: Requirement 13.2 (Phased Cache Priming — template greeting infrastructure removal)
// Updated: templateGreeting is no longer written by the ExtractText Lambda.
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

describe('ExtractText Lambda — templateGreeting no longer written (R13.2)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    vi.mocked(pdfParse).mockReset()
    vi.mocked(mammoth.extractRawText).mockReset()
    s3SendSpy.mockResolvedValue({})
  })

  describe('PDF extraction does not write templateGreeting', () => {
    it('sets documentStatus=ready without templateGreeting for PDF', async () => {
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

      const values = updateCall.input.ExpressionAttributeValues
      expect(values[':status'].S).toBe('ready')
      // templateGreeting should NOT be present
      expect(values[':templateGreeting']).toBeUndefined()
      expect(updateCall.input.UpdateExpression).not.toContain('templateGreeting')
    })
  })

  describe('DOCX extraction does not write templateGreeting', () => {
    it('sets documentStatus=ready without templateGreeting for DOCX', async () => {
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
      // templateGreeting should NOT be present
      expect(values[':templateGreeting']).toBeUndefined()
    })
  })
})
