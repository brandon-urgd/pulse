// Unit tests for urgd-pulse-preGenerate
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSpy = vi.fn()
const s3Spy = vi.fn()
const bedrockSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3Spy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input; this.name = 'ConverseCommand' } }
  return { BedrockRuntimeClient, ConverseCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

vi.mock('./shared/buildSystemPrompt.mjs', async () => {
  const actual = await vi.importActual('../../lambdas/shared/buildSystemPrompt.mjs')
  return actual
})

const { handler } = await import('./index.mjs')

// ── Helpers ──

function makeS3Body(content) {
  return { Body: { [Symbol.asyncIterator]: async function* () { yield Buffer.from(content) } } }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    sessionId: { S: 'session-xyz' },
    itemId: { S: 'item-123' },
    status: { S: 'not_started' },
    timeLimitMinutes: { N: '30' },
    isSelfReview: { BOOL: false },
    frozenSnapshot: { M: {} },
    ...overrides,
  }
}

function makeItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-abc' },
    itemId: { S: 'item-123' },
    itemName: { S: 'Test Document' },
    description: { S: 'Review this.' },
    itemType: { S: 'document' },
    documentKey: { S: 'pulse/tenant-abc/items/item-123/document.pdf' },
    ...overrides,
  }
}

function makeBedrockResponse(text) {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

// ── Tests ──

describe('urgd-pulse-preGenerate', () => {
  beforeEach(() => {
    dynamoSpy.mockReset()
    s3Spy.mockReset()
    bedrockSpy.mockReset()
  })

  it('successful flow: reads session, item, S3 content, invokes Bedrock, writes greeting', async () => {
    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSession() })  // GetItem session
      .mockResolvedValueOnce({ Item: makeItem() })      // GetItem item
      .mockResolvedValueOnce({})                         // UpdateItem (write greeting)

    s3Spy
      .mockResolvedValueOnce(makeS3Body('# Extracted text'))  // extracted.md
      .mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))    // original document

    bedrockSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome to the session!'))

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    // Bedrock was called
    expect(bedrockSpy).toHaveBeenCalledOnce()

    // Greeting was written to session record
    const updateCall = dynamoSpy.mock.calls.find(([cmd]) => cmd.name === 'UpdateItemCommand')
    expect(updateCall).toBeDefined()
    expect(updateCall[0].input.ExpressionAttributeValues[':greeting'].S).toBe('Welcome to the session!')
  })

  it('skips if session already has preGeneratedGreeting', async () => {
    dynamoSpy.mockResolvedValueOnce({
      Item: makeSession({ preGeneratedGreeting: { S: 'Already generated' } }),
    })

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    // Bedrock should NOT be called
    expect(bedrockSpy).not.toHaveBeenCalled()
  })

  it('skips if session is already in_progress', async () => {
    dynamoSpy.mockResolvedValueOnce({
      Item: makeSession({ status: { S: 'in_progress' } }),
    })

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    expect(bedrockSpy).not.toHaveBeenCalled()
  })

  it('exits gracefully when session not found', async () => {
    dynamoSpy.mockResolvedValueOnce({ Item: undefined })

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    expect(bedrockSpy).not.toHaveBeenCalled()
    expect(s3Spy).not.toHaveBeenCalled()
  })

  it('exits gracefully on S3 failure — does not write greeting', async () => {
    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSession() })
      .mockResolvedValueOnce({ Item: makeItem() })

    s3Spy.mockRejectedValue(new Error('S3 access denied'))

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    // Should not write greeting (Bedrock may or may not be called depending on where S3 fails)
    const updateCalls = dynamoSpy.mock.calls.filter(([cmd]) => cmd.name === 'UpdateItemCommand')
    // If Bedrock wasn't called, no update. If it was called with empty content, greeting would be empty and skipped.
    expect(updateCalls.length).toBeLessThanOrEqual(0)
  })

  it('exits gracefully on Bedrock failure — does not write greeting', async () => {
    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSession() })
      .mockResolvedValueOnce({ Item: makeItem() })

    s3Spy
      .mockResolvedValueOnce(makeS3Body('# Extracted text'))
      .mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))

    bedrockSpy.mockRejectedValueOnce(new Error('ThrottlingException'))

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    // No greeting written
    const updateCalls = dynamoSpy.mock.calls.filter(([cmd]) => cmd.name === 'UpdateItemCommand')
    expect(updateCalls).toHaveLength(0)
  })

  it('attaches page images when pageCount > 0', async () => {
    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSession() })
      .mockResolvedValueOnce({ Item: makeItem({ pageCount: { N: '3' } }) })
      .mockResolvedValueOnce({})  // UpdateItem

    s3Spy
      .mockResolvedValueOnce(makeS3Body('# Extracted text'))
      .mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))
      .mockResolvedValueOnce(makeS3Body('page-1'))
      .mockResolvedValueOnce(makeS3Body('page-2'))
      .mockResolvedValueOnce(makeS3Body('page-3'))

    bedrockSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    // Bedrock payload should include image blocks
    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const userContent = bedrockCall.input.messages[0].content
    const imageBlocks = userContent.filter(b => b.image)
    expect(imageBlocks).toHaveLength(3)
  })

  it('does not attach page images when pageCount is absent', async () => {
    dynamoSpy
      .mockResolvedValueOnce({ Item: makeSession() })
      .mockResolvedValueOnce({ Item: makeItem() })  // no pageCount field
      .mockResolvedValueOnce({})  // UpdateItem

    s3Spy
      .mockResolvedValueOnce(makeS3Body('# Extracted text'))
      .mockResolvedValueOnce(makeS3Body('fake-pdf-bytes'))

    bedrockSpy.mockResolvedValueOnce(makeBedrockResponse('Welcome!'))

    await handler({ tenantId: 'tenant-abc', sessionId: 'session-xyz' })

    const bedrockCall = bedrockSpy.mock.calls[0][0]
    const userContent = bedrockCall.input.messages[0].content
    const imageBlocks = userContent.filter(b => b.image)
    expect(imageBlocks).toHaveLength(0)
  })

  it('exits gracefully with missing event fields', async () => {
    await handler({})
    expect(dynamoSpy).not.toHaveBeenCalled()

    await handler({ tenantId: 'tenant-abc' })
    expect(dynamoSpy).not.toHaveBeenCalled()
  })
})
