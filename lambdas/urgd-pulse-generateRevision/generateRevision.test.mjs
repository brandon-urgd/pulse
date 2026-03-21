// Unit tests for urgd-pulse-generateRevision
// Requirements: 8.1, 8.2, 8.3, 8.13

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-123' },
    },
    pathParameters: { itemId: 'item-456' },
    ...overrides,
  }
}

function makeTenantWithFlag(flagValue) {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      features: { M: { itemRevisionLoop: { BOOL: flagValue } } },
    },
  }
}

function makePulseCheck(status = 'complete') {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      itemId: { S: 'item-456' },
      status: { S: status },
      feedbackPoints: {
        L: [
          {
            M: {
              feedbackPointId: { S: 'fp-1' },
              text: { S: 'The introduction is too long' },
              section: { S: 'Introduction' },
            },
          },
        ],
      },
      decisions: {
        M: {
          'fp-1': {
            M: {
              action: { S: 'accept' },
              tenantNote: { S: '' },
              decidedAt: { S: '2024-01-01T00:00:00.000Z' },
            },
          },
        },
      },
    },
  }
}

function makeItem() {
  return {
    Item: {
      tenantId: { S: 'tenant-123' },
      itemId: { S: 'item-456' },
      itemName: { S: 'My Test Document' },
    },
  }
}

function makeS3TextBody(text) {
  return {
    Body: (async function* () {
      yield Buffer.from(text)
    })(),
  }
}

function makeBedrockResponse(text) {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  }
}

describe('generateRevision handler', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('returns 401 when tenantId is missing', async () => {
    const event = makeEvent({ requestContext: { requestId: 'req', authorizer: {} } })
    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('returns 400 when itemId is missing', async () => {
    const event = makeEvent({ pathParameters: {} })
    const result = await handler(event)
    expect(result.statusCode).toBe(400)
  })

  it('returns 403 when itemRevisionLoop flag is false', async () => {
    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(false))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(403)
    const body = JSON.parse(result.body)
    expect(body.message).toMatch(/not enabled/i)
  })

  it('returns 409 when no completed pulse check exists', async () => {
    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce({ Item: null }) // no pulse check
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
    const body = JSON.parse(result.body)
    expect(body.message).toMatch(/pulse check must be completed/i)
  })

  it('returns 409 when pulse check exists but is not complete', async () => {
    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('generating'))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
  })

  it('returns 404 when no document found in S3', async () => {
    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('complete'))
    sendSpy.mockResolvedValueOnce(makeItem())
    // Both S3 GetObject calls fail
    s3SendSpy.mockRejectedValue(new Error('NoSuchKey'))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(404)
  })

  it('generates revision and stores at unique path, original document unchanged', async () => {
    const originalContent = '# Original Document\n\nThis is the original content.'
    const revisedContent = '# Revised Document\n\nThis is the revised content.'

    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('complete'))
    sendSpy.mockResolvedValueOnce(makeItem())
    // S3 GetObject for extracted.md (not found), then document.md (found)
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody(originalContent))
    // Bedrock response
    bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(revisedContent))
    // S3 PutObject for revision
    s3SendSpy.mockResolvedValueOnce({})
    // DynamoDB UpdateItem for item status
    sendSpy.mockResolvedValueOnce({})

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)

    const body = JSON.parse(result.body)
    expect(body.data.revisionId).toBeTruthy()
    expect(body.data.itemId).toBe('item-456')
    expect(body.data.decisionsApplied).toBe(1)

    // Verify revision stored at unique path (not the original path)
    const putCall = s3SendSpy.mock.calls.find(call =>
      call[0].input?.Key?.includes('/revisions/')
    )
    expect(putCall).toBeTruthy()
    const revisionKey = putCall[0].input.Key
    expect(revisionKey).toMatch(/pulse\/tenant-123\/items\/item-456\/revisions\/.+\/document\.md/)

    // Verify original document path was NOT written to
    const putCalls = s3SendSpy.mock.calls.filter(call => call[0].constructor?.name === 'PutObjectCommand')
    for (const call of putCalls) {
      expect(call[0].input.Key).not.toBe('pulse/tenant-123/items/item-456/document.md')
      expect(call[0].input.Key).not.toBe('pulse/tenant-123/items/item-456/extracted.md')
    }
  })

  it('uses extracted.md when it exists', async () => {
    const extractedContent = '# Extracted Content'
    const revisedContent = '# Revised'

    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('complete'))
    sendSpy.mockResolvedValueOnce(makeItem())
    // extracted.md found
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody(extractedContent))
    bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(revisedContent))
    s3SendSpy.mockResolvedValueOnce({})
    sendSpy.mockResolvedValueOnce({})

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)

    // Verify Bedrock was called with extracted content
    const bedrockCall = bedrockSendSpy.mock.calls[0][0]
    const payload = JSON.parse(bedrockCall.input.body)
    expect(payload.messages[0].content).toContain(extractedContent)
  })

  it('updates item status to "revised" after successful revision', async () => {
    const originalContent = '# Original'
    const revisedContent = '# Revised'

    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('complete'))
    sendSpy.mockResolvedValueOnce(makeItem())
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody(originalContent))
    bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(revisedContent))
    s3SendSpy.mockResolvedValueOnce({})
    sendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // Find the UpdateItem call
    const updateCall = sendSpy.mock.calls.find(call =>
      call[0].input?.UpdateExpression?.includes('revised')
    )
    expect(updateCall).toBeTruthy()
    expect(updateCall[0].input.ExpressionAttributeValues[':revised'].S).toBe('revised')
  })

  it('returns 503 on Bedrock unavailability', async () => {
    const originalContent = '# Original'

    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(makePulseCheck('complete'))
    sendSpy.mockResolvedValueOnce(makeItem())
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody(originalContent))
    const err = new Error('Bedrock unavailable')
    err.name = 'AccessDeniedException'
    bedrockSendSpy.mockRejectedValueOnce(err)

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(503)
  })

  it('returns 409 when all decisions are dismissed (no accepted/revised)', async () => {
    const pulseCheckWithDismissed = {
      Item: {
        tenantId: { S: 'tenant-123' },
        itemId: { S: 'item-456' },
        status: { S: 'complete' },
        feedbackPoints: {
          L: [
            {
              M: {
                feedbackPointId: { S: 'fp-1' },
                text: { S: 'Some feedback' },
                section: { S: 'Introduction' },
              },
            },
          ],
        },
        decisions: {
          M: {
            'fp-1': {
              M: {
                action: { S: 'dismiss' },
                tenantNote: { S: '' },
                decidedAt: { S: '2024-01-01T00:00:00.000Z' },
              },
            },
          },
        },
      },
    }

    sendSpy.mockResolvedValueOnce(makeTenantWithFlag(true))
    sendSpy.mockResolvedValueOnce(pulseCheckWithDismissed)
    sendSpy.mockResolvedValueOnce(makeItem())
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original'))

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(409)
    const body = JSON.parse(result.body)
    expect(body.message).toMatch(/no accepted or revised decisions/i)
  })

  it('returns 500 on unexpected error', async () => {
    sendSpy.mockRejectedValueOnce(new Error('Unexpected DynamoDB error'))

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(500)
  })
})
