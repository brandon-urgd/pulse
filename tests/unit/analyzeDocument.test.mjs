// Unit tests for urgd-pulse-analyzeDocument
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Noop mocks for AWS SDK clients (must be before dynamic import) ──

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

function makeBedrockResponse(sections) {
  return {
    output: {
      message: {
        content: [{ text: JSON.stringify({ sections }) }],
      },
    },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

const { handler, parseSectionMap, marshalSectionMap } = await import('../../lambdas/urgd-pulse-analyzeDocument/index.mjs')

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


// ── v1.1 wordCount unit tests ──────────────────────────────────────────────
// Requirements: 1.1, 1.2, 1.4, 1.5

describe('parseSectionMap — wordCount handling', () => {
  it('extracts wordCount when present as a non-negative integer', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 450 },
        { id: 's2', title: 'Body', classification: 'substantive', wordCount: 0 },
      ],
    })

    const result = parseSectionMap(json)

    expect(result.sections[0].wordCount).toBe(450)
    expect(result.sections[1].wordCount).toBe(0)
  })

  it('omits wordCount when absent from Bedrock response', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive' },
        { id: 's2', title: 'Body', classification: 'lightweight' },
      ],
    })

    const result = parseSectionMap(json)

    expect(result.sections[0]).not.toHaveProperty('wordCount')
    expect(result.sections[1]).not.toHaveProperty('wordCount')
  })

  it('omits wordCount when value is null', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: null },
      ],
    })

    const result = parseSectionMap(json)
    expect(result.sections[0]).not.toHaveProperty('wordCount')
  })

  it('omits wordCount when value is negative', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: -5 },
      ],
    })

    const result = parseSectionMap(json)
    expect(result.sections[0]).not.toHaveProperty('wordCount')
  })

  it('omits wordCount when value is a non-integer float', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 3.7 },
      ],
    })

    const result = parseSectionMap(json)
    expect(result.sections[0]).not.toHaveProperty('wordCount')
  })

  it('omits wordCount when value is a string', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 'many' },
      ],
    })

    const result = parseSectionMap(json)
    expect(result.sections[0]).not.toHaveProperty('wordCount')
  })

  it('preserves other section fields when wordCount is invalid', () => {
    const json = JSON.stringify({
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: -1 },
      ],
    })

    const result = parseSectionMap(json)
    expect(result.sections[0].id).toBe('s1')
    expect(result.sections[0].title).toBe('Intro')
    expect(result.sections[0].classification).toBe('substantive')
  })
})

describe('marshalSectionMap — wordCount handling', () => {
  it('includes wordCount: { N } when wordCount is present', () => {
    const sectionMap = {
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 450 },
      ],
      totalSubstantiveSections: 1,
      analyzedAt: '2025-01-01T00:00:00.000Z',
    }

    const marshalled = marshalSectionMap(sectionMap)
    const entry = marshalled.M.sections.L[0].M

    expect(entry.wordCount).toEqual({ N: '450' })
  })

  it('includes wordCount: { N: "0" } when wordCount is 0', () => {
    const sectionMap = {
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 0 },
      ],
      totalSubstantiveSections: 1,
      analyzedAt: '2025-01-01T00:00:00.000Z',
    }

    const marshalled = marshalSectionMap(sectionMap)
    const entry = marshalled.M.sections.L[0].M

    expect(entry.wordCount).toEqual({ N: '0' })
  })

  it('omits wordCount from DynamoDB entry when absent on section', () => {
    const sectionMap = {
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive' },
      ],
      totalSubstantiveSections: 1,
      analyzedAt: '2025-01-01T00:00:00.000Z',
    }

    const marshalled = marshalSectionMap(sectionMap)
    const entry = marshalled.M.sections.L[0].M

    expect(entry).not.toHaveProperty('wordCount')
  })

  it('handles mixed sections — some with wordCount, some without', () => {
    const sectionMap = {
      sections: [
        { id: 's1', title: 'Intro', classification: 'substantive', wordCount: 300 },
        { id: 's2', title: 'TOC', classification: 'lightweight' },
        { id: 's3', title: 'Body', classification: 'substantive', wordCount: 1200 },
      ],
      totalSubstantiveSections: 2,
      analyzedAt: '2025-01-01T00:00:00.000Z',
    }

    const marshalled = marshalSectionMap(sectionMap)
    const entries = marshalled.M.sections.L

    expect(entries[0].M.wordCount).toEqual({ N: '300' })
    expect(entries[1].M).not.toHaveProperty('wordCount')
    expect(entries[2].M.wordCount).toEqual({ N: '1200' })
  })
})

describe('graceful degradation — sections without wordCount are still written', () => {
  it('writes all sections to DynamoDB even when none have wordCount', async () => {
    // Reset spies for this test since they're shared across describe blocks
    dynamoSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValue({})

    const sections = [
      { id: 's1', title: 'Introduction', classification: 'substantive' },
      { id: 's2', title: 'Appendix', classification: 'lightweight' },
    ]

    s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some document text.') })
    bedrockSendSpy.mockResolvedValue(makeBedrockResponse(sections))
    dynamoSendSpy.mockResolvedValue({})

    await handler({ itemId: 'item-wc1', tenantId: 'tenant-wc1' })

    expect(dynamoSendSpy).toHaveBeenCalledOnce()
    const sectionMapAttr = dynamoSendSpy.mock.calls[0][0].input.ExpressionAttributeValues[':sm']
    expect(sectionMapAttr.M.sections.L).toHaveLength(2)
    expect(sectionMapAttr.M.sections.L[0].M.id.S).toBe('s1')
    expect(sectionMapAttr.M.sections.L[1].M.id.S).toBe('s2')
    // Neither entry has wordCount
    expect(sectionMapAttr.M.sections.L[0].M).not.toHaveProperty('wordCount')
    expect(sectionMapAttr.M.sections.L[1].M).not.toHaveProperty('wordCount')
  })

  it('writes all sections when some have wordCount and some do not', async () => {
    // Reset spies for this test since they're shared across describe blocks
    dynamoSendSpy.mockReset()
    dynamoSendSpy.mockResolvedValue({})

    const sections = [
      { id: 's1', title: 'Introduction', classification: 'substantive', wordCount: 500 },
      { id: 's2', title: 'Appendix', classification: 'lightweight' },
    ]

    s3SendSpy.mockResolvedValue({ Body: makeS3Body('Some document text.') })
    bedrockSendSpy.mockResolvedValue(makeBedrockResponse(sections))

    await handler({ itemId: 'item-wc2', tenantId: 'tenant-wc2' })

    expect(dynamoSendSpy).toHaveBeenCalledOnce()
    const sectionMapAttr = dynamoSendSpy.mock.calls[0][0].input.ExpressionAttributeValues[':sm']
    expect(sectionMapAttr.M.sections.L).toHaveLength(2)
    expect(sectionMapAttr.M.sections.L[0].M.wordCount).toEqual({ N: '500' })
    expect(sectionMapAttr.M.sections.L[1].M).not.toHaveProperty('wordCount')
  })
})
