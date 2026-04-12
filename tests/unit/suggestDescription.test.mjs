// Unit tests for urgd-pulse-suggestDescription
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return dynamoSendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send(...args) { return bedrockSendSpy(...args) }
  }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

function makeS3Body(text) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(text)
    }
  }
}

function makeEvent({ tenantId, itemId, body } = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: tenantId ? { tenantId } : {},
    },
    pathParameters: itemId ? { itemId } : {},
    body: JSON.stringify(body || {}),
  }
}

function makeItemRecord(overrides = {}) {
  return {
    Item: {
      tenantId: { S: 'tenant-abc' },
      itemId: { S: 'item-123' },
      itemName: { S: 'Test Item' },
      itemType: { S: 'document' },
      documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
      ...overrides,
    },
  }
}

function makeBedrockResponse(suggestion) {
  return {
    output: { message: { content: [{ text: suggestion }] } },
    usage: { inputTokens: 50, outputTokens: 30 },
  }
}

const { handler } = await import('../../lambdas/urgd-pulse-suggestDescription/index.mjs')

describe('urgd-pulse-suggestDescription', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
  })

  describe('document item with roughInput → 200 with suggestion', () => {
    it('returns 200 and suggestion when roughInput is provided', async () => {
      dynamoSendSpy.mockResolvedValue(makeItemRecord())
      // S3 returns null (no extracted text) — roughInput is enough
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
      bedrockSendSpy.mockResolvedValue(makeBedrockResponse("I'd like feedback on the clarity of my proposal."))

      const event = makeEvent({
        tenantId: 'tenant-abc',
        itemId: 'item-123',
        body: { roughInput: 'Is my proposal clear?' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.suggestion).toBe("I'd like feedback on the clarity of my proposal.")
    })
  })

  describe('no roughInput AND no document → 400', () => {
    it('returns 400 when no roughInput and S3 returns nothing', async () => {
      dynamoSendSpy.mockResolvedValue(makeItemRecord({ documentKey: undefined }))
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

      const event = makeEvent({
        tenantId: 'tenant-abc',
        itemId: 'item-123',
        body: {},
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('item not found → 404', () => {
    it('returns 404 when DynamoDB returns no item', async () => {
      dynamoSendSpy.mockResolvedValue({ Item: null })

      const event = makeEvent({
        tenantId: 'tenant-abc',
        itemId: 'item-not-found',
        body: { roughInput: 'some input' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(404)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('Bedrock error → 500', () => {
    it('returns 500 when Bedrock throws', async () => {
      dynamoSendSpy.mockResolvedValue(makeItemRecord())
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
      bedrockSendSpy.mockRejectedValue(Object.assign(new Error('ServiceUnavailableException'), { name: 'ServiceUnavailableException' }))

      const event = makeEvent({
        tenantId: 'tenant-abc',
        itemId: 'item-123',
        body: { roughInput: 'Is my proposal clear?' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(500)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('unauthorized (no tenantId) → 401', () => {
    it('returns 401 when tenantId is missing', async () => {
      const event = makeEvent({ itemId: 'item-123', body: { roughInput: 'test' } })
      // Remove tenantId from authorizer
      event.requestContext.authorizer = {}

      const result = await handler(event)

      expect(result.statusCode).toBe(401)
      const body = JSON.parse(result.body)
      expect(body.error).toBe(true)
    })
  })

  describe('document item reads extracted text from S3', () => {
    it('reads extracted.md from S3 and passes it to Bedrock', async () => {
      dynamoSendSpy.mockResolvedValue(makeItemRecord())
      // First S3 call (extracted.md) succeeds
      s3SendSpy.mockResolvedValueOnce({ Body: makeS3Body('Extracted document content here.') })
      bedrockSendSpy.mockResolvedValue(makeBedrockResponse("I'd like feedback on the document."))

      const event = makeEvent({
        tenantId: 'tenant-abc',
        itemId: 'item-123',
        body: { roughInput: 'Is it clear?' },
      })

      const result = await handler(event)

      expect(result.statusCode).toBe(200)
      // Verify S3 was called for extracted text
      expect(s3SendSpy).toHaveBeenCalled()
      const s3Call = s3SendSpy.mock.calls[0][0]
      expect(s3Call.input.Bucket).toBe('urgd-pulse-data-dev')
      expect(s3Call.input.Key).toContain('extracted.md')
    })
  })
})
