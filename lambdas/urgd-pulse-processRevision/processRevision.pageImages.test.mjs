// Unit tests for urgd-pulse-processRevision — Page image attachment
// Requirements: 7.1–7.4
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input; this.name = 'GetItemCommand' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this.name = 'UpdateItemCommand' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input; this.name = 'GetObjectCommand' } }
  class PutObjectCommand { constructor(input) { this.input = input; this.name = 'PutObjectCommand' } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input; this.name = 'ConverseCommand' } }
  return { BedrockRuntimeClient, ConverseCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input; this.name = 'PutMetricDataCommand' } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

const { handler } = await import('./index.mjs')

// ── Helpers ──

function makeEvent(overrides = {}) {
  return {
    tenantId: 'tenant-123',
    itemId: 'item-456',
    revisionId: 'rev-789',
    startedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeS3TextBody(text) {
  return {
    Body: (async function* () { yield Buffer.from(text) })(),
  }
}

function makeS3BytesBody(content) {
  return {
    Body: (async function* () { yield Buffer.from(content) })(),
  }
}

function makePulseCheck() {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      itemId: { S: 'item-456' },
      status: { S: 'complete' },
      decisions: {
        M: {
          'rev-1': { M: { action: { S: 'Accept' }, tenantNote: { S: '' } } },
        },
      },
      proposedRevisions: {
        L: [{
          M: {
            revisionId: { S: 'rev-1' },
            proposal: { S: 'Improve clarity' },
            rationale: { S: 'Reviewers found it unclear' },
            revisionType: { S: 'line-edit' },
          },
        }],
      },
    },
  }
}

function makeBedrockResponse(text) {
  return {
    output: { message: { content: [{ text }] } },
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

function makeItemRecord(overrides = {}) {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      itemId: { S: 'item-456' },
      documentKey: { S: 'pulse/tenant-123/items/item-456/document.pdf' },
      ...overrides,
    },
  }
}

/**
 * Sets up all mocks for a successful happy path with page images.
 */
function mockHappyPathWithPages(pageCount) {
  // S3: extracted.md not found, document.md found
  s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
  s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original Document'))
  // DynamoDB: GetItem item record with pageCount
  dynamoSendSpy.mockResolvedValueOnce(makeItemRecord({ pageCount: { N: String(pageCount) } }))
  // DynamoDB: pulse check
  dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
  // S3: original document for native context
  s3SendSpy.mockResolvedValueOnce(makeS3BytesBody('fake-pdf-bytes'))
  // S3: page images
  for (let i = 1; i <= pageCount; i++) {
    s3SendSpy.mockResolvedValueOnce(makeS3BytesBody(`page-${i}-bytes`))
  }
  // Bedrock response
  bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('# Revised Document'))
  // S3 PutObject for revision
  s3SendSpy.mockResolvedValueOnce({})
  // DynamoDB: UpdateItem revision → complete
  dynamoSendSpy.mockResolvedValueOnce({})
  // DynamoDB: UpdateItem item → revised
  dynamoSendSpy.mockResolvedValueOnce({})
}

// ── Tests ──

describe('processRevision — page image attachment', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('attaches page images when pageCount > 0', async () => {
    mockHappyPathWithPages(2)

    await handler(makeEvent())

    // Bedrock was called with image blocks
    const bedrockCall = bedrockSendSpy.mock.calls[0][0]
    const userContent = bedrockCall.input.messages[0].content
    const imageBlocks = userContent.filter(b => b.image)
    expect(imageBlocks).toHaveLength(2)
    expect(imageBlocks[0].image.format).toBe('png')
  })

  it('handles partial page resilience — some pages fail, others succeed', async () => {
    // S3: extracted.md not found, document.md found
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original Document'))
    // DynamoDB: GetItem item record with pageCount=3
    dynamoSendSpy.mockResolvedValueOnce(makeItemRecord({ pageCount: { N: '3' } }))
    // DynamoDB: pulse check
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
    // S3: original document for native context
    s3SendSpy.mockResolvedValueOnce(makeS3BytesBody('fake-pdf-bytes'))
    // S3: page images — page 1 OK, page 2 fails (returns null), page 3 OK
    s3SendSpy.mockResolvedValueOnce(makeS3BytesBody('page-1-bytes'))
    s3SendSpy.mockResolvedValueOnce({ Body: (async function* () { /* empty */ })() })
    s3SendSpy.mockResolvedValueOnce(makeS3BytesBody('page-3-bytes'))
    // Bedrock response
    bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('# Revised Document'))
    // S3 PutObject for revision
    s3SendSpy.mockResolvedValueOnce({})
    // DynamoDB: UpdateItem revision → complete
    dynamoSendSpy.mockResolvedValueOnce({})
    // DynamoDB: UpdateItem item → revised
    dynamoSendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // Bedrock was still called — partial images are acceptable
    expect(bedrockSendSpy).toHaveBeenCalledOnce()
    const bedrockCall = bedrockSendSpy.mock.calls[0][0]
    const userContent = bedrockCall.input.messages[0].content
    const imageBlocks = userContent.filter(b => b.image)
    // At least some images were attached (page 2 may have been empty buffer)
    expect(imageBlocks.length).toBeGreaterThanOrEqual(2)
  })

  it('does not attach page images when pageCount is absent', async () => {
    // S3: extracted.md not found, document.md found
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original Document'))
    // DynamoDB: GetItem item record WITHOUT pageCount
    dynamoSendSpy.mockResolvedValueOnce(makeItemRecord())
    // DynamoDB: pulse check
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
    // S3: original document for native context
    s3SendSpy.mockResolvedValueOnce(makeS3BytesBody('fake-pdf-bytes'))
    // Bedrock response
    bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('# Revised Document'))
    // S3 PutObject for revision
    s3SendSpy.mockResolvedValueOnce({})
    // DynamoDB: UpdateItem revision → complete
    dynamoSendSpy.mockResolvedValueOnce({})
    // DynamoDB: UpdateItem item → revised
    dynamoSendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // Bedrock was called without image blocks
    const bedrockCall = bedrockSendSpy.mock.calls[0][0]
    const userContent = bedrockCall.input.messages[0].content
    const imageBlocks = userContent.filter(b => b.image)
    expect(imageBlocks).toHaveLength(0)
  })
})
