// Unit tests for urgd-pulse-analyzeDocument
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

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
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient {
    send(...args) { return bedrockSendSpy(...args) }
  }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand }
})

function makeS3Body(text) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(text)
    }
  }
}

function makeBedrockResponse(sections) {
  const body = JSON.stringify({
    content: [{ text: JSON.stringify({ sections }) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  })
  return { body: Buffer.from(body) }
}

const { handler } = await import('../../lambdas/urgd-pulse-analyzeDocument/index.mjs')

describe('urgd-pulse-analyzeDocument', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValue({})
  })

  describe('valid Bedrock response → correct sectionMap written to DynamoDB', () => {
    it('writes sectionMap with correct structure and totalSubstantiveSections', async () => {
      const sections = [
        { id: 's1', title: 'Introduction', classification: 'substantive' },
        { id: 's2', title: 'Table of Contents', classification: 'lightweight' },
        { id: 's3', title: 'Main Body', classification: 'substantive' },
      ]

      s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some extracted document text here.') })
      bedrockSendSpy.mockResolvedValue(makeBedrockResponse(sections))

      await handler({ itemId: 'item-123', tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).toHaveBeenCalledOnce()
      const dynamoCall = dynamoSendSpy.mock.calls[0][0]
      expect(dynamoCall.input.TableName).toBe('urgd-pulse-items-dev')
      expect(dynamoCall.input.Key.tenantId.S).toBe('tenant-abc')
      expect(dynamoCall.input.Key.itemId.S).toBe('item-123')

      // Verify sectionMap structure
      const sectionMapAttr = dynamoCall.input.ExpressionAttributeValues[':sm']
      expect(sectionMapAttr.M).toBeDefined()
      expect(sectionMapAttr.M.sections.L).toHaveLength(3)
      expect(sectionMapAttr.M.sections.L[0].M.id.S).toBe('s1')
      expect(sectionMapAttr.M.sections.L[0].M.title.S).toBe('Introduction')
      expect(sectionMapAttr.M.sections.L[0].M.classification.S).toBe('substantive')
      expect(sectionMapAttr.M.sections.L[1].M.classification.S).toBe('lightweight')

      // Verify totalSubstantiveSections count (2 substantive sections)
      expect(sectionMapAttr.M.totalSubstantiveSections.N).toBe('2')
    })
  })

  describe('S3 read failure → no DynamoDB update', () => {
    it('does not call DynamoDB when S3 throws', async () => {
      s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

      await handler({ itemId: 'item-123', tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('Bedrock timeout → no DynamoDB update', () => {
    it('does not call DynamoDB when Bedrock throws ThrottlingException', async () => {
      s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some document text.') })
      bedrockSendSpy.mockRejectedValue(Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' }))

      await handler({ itemId: 'item-123', tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('malformed Bedrock response → no DynamoDB update', () => {
    it('does not call DynamoDB when Bedrock returns invalid JSON', async () => {
      s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some document text.') })
      const badBody = JSON.stringify({
        content: [{ text: 'this is not valid json {{{' }],
      })
      bedrockSendSpy.mockResolvedValue({ body: Buffer.from(badBody) })

      await handler({ itemId: 'item-123', tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('does not call DynamoDB when Bedrock returns JSON without sections array', async () => {
      s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some document text.') })
      const badBody = JSON.stringify({
        content: [{ text: JSON.stringify({ notSections: [] }) }],
      })
      bedrockSendSpy.mockResolvedValue({ body: Buffer.from(badBody) })

      await handler({ itemId: 'item-123', tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('missing itemId/tenantId → returns without error', () => {
    it('returns without calling DynamoDB when event is empty', async () => {
      await handler({})

      expect(dynamoSendSpy).not.toHaveBeenCalled()
      expect(s3SendSpy).not.toHaveBeenCalled()
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })

    it('returns without calling DynamoDB when itemId is missing', async () => {
      await handler({ tenantId: 'tenant-abc' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })

    it('returns without calling DynamoDB when tenantId is missing', async () => {
      await handler({ itemId: 'item-123' })

      expect(dynamoSendSpy).not.toHaveBeenCalled()
    })
  })
})
