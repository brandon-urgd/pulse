// Unit tests for urgd-pulse-processRevision (worker Lambda)
// Requirements: 2.1, 2.2, 2.3, 2.4

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
  class InvokeModelCommand { constructor(input) { this.input = input; this.name = 'InvokeModelCommand' } }
  return { BedrockRuntimeClient, InvokeModelCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input; this.name = 'PutMetricDataCommand' } }
  return { CloudWatchClient, PutMetricDataCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(overrides = {}) {
  return {
    tenantId: 'tenant-123',
    itemId: 'item-456',
    revisionId: 'rev-789',
    startedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
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

function makeS3TextBody(text) {
  return {
    Body: (async function* () { yield Buffer.from(text) })(),
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

/** Sets up all mocks for a successful happy path */
function mockHappyPath() {
  // S3: extracted.md not found, document.md found
  s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
  s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original Document'))
  // DynamoDB: pulse check
  dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
  // Bedrock response
  bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse('# Revised Document'))
  // S3 PutObject for revision
  s3SendSpy.mockResolvedValueOnce({})
  // DynamoDB: UpdateItem revision → complete
  dynamoSendSpy.mockResolvedValueOnce({})
  // DynamoDB: UpdateItem item → revised
  dynamoSendSpy.mockResolvedValueOnce({})
}

describe('processRevision handler (worker)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  // --- Error handling tests (Task 4.4) ---

  it('Bedrock AccessDeniedException results in failed status and BedrockErrors metric', async () => {
    // S3: document found
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original'))
    // DynamoDB: pulse check
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
    // Bedrock: AccessDeniedException
    const err = new Error('Access denied')
    err.name = 'AccessDeniedException'
    bedrockSendSpy.mockRejectedValueOnce(err)
    // DynamoDB: UpdateItem to mark failed
    dynamoSendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    // Verify revision marked as failed
    const updateCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' &&
              call[0].input.TableName === 'urgd-pulse-revisions-dev'
    )
    expect(updateCall).toBeTruthy()
    expect(updateCall[0].input.ExpressionAttributeValues[':failed'].S).toBe('failed')

    // Verify BedrockErrors metric published
    const metricCall = cwSendSpy.mock.calls.find(
      call => call[0].input.MetricData.some(m => m.MetricName === 'BedrockErrors')
    )
    expect(metricCall).toBeTruthy()
  })

  it('Bedrock ThrottlingException results in failed status and BedrockErrors metric', async () => {
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockResolvedValueOnce(makeS3TextBody('# Original'))
    dynamoSendSpy.mockResolvedValueOnce(makePulseCheck())
    const err = new Error('Throttled')
    err.name = 'ThrottlingException'
    bedrockSendSpy.mockRejectedValueOnce(err)
    dynamoSendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    const updateCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' &&
              call[0].input.ExpressionAttributeValues?.[':failed']?.S === 'failed'
    )
    expect(updateCall).toBeTruthy()

    const metricCall = cwSendSpy.mock.calls.find(
      call => call[0].input.MetricData.some(m => m.MetricName === 'BedrockErrors')
    )
    expect(metricCall).toBeTruthy()
  })

  it('S3 GetObject failure (document not found) results in failed status', async () => {
    // Both S3 GetObject calls fail
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
    // DynamoDB: UpdateItem to mark failed
    dynamoSendSpy.mockResolvedValueOnce({})

    await handler(makeEvent())

    const updateCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' &&
              call[0].input.ExpressionAttributeValues?.[':failed']?.S === 'failed'
    )
    expect(updateCall).toBeTruthy()

    // Bedrock should NOT have been called
    expect(bedrockSendSpy).not.toHaveBeenCalled()
  })

  it('item status updated to revised on success', async () => {
    mockHappyPath()

    await handler(makeEvent())

    // Find the UpdateItem call for the Items table
    const updateItemCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' &&
              call[0].input.TableName === 'urgd-pulse-items-dev'
    )
    expect(updateItemCall).toBeTruthy()
    expect(updateItemCall[0].input.ExpressionAttributeValues[':revised'].S).toBe('revised')
  })

  it('CloudWatch metrics published on success', async () => {
    mockHappyPath()

    await handler(makeEvent())

    // Verify metrics published
    const metricCall = cwSendSpy.mock.calls.find(
      call => call[0].input.MetricData.some(m => m.MetricName === 'BedrockLatency')
    )
    expect(metricCall).toBeTruthy()
    const metricData = metricCall[0].input.MetricData
    const metricNames = metricData.map(m => m.MetricName)
    expect(metricNames).toContain('BedrockLatency')
    expect(metricNames).toContain('BedrockTokensIn')
    expect(metricNames).toContain('BedrockTokensOut')
  })

  it('does nothing when tenantId is missing', async () => {
    await handler({ itemId: 'item-456', revisionId: 'rev-789' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(s3SendSpy).not.toHaveBeenCalled()
    expect(bedrockSendSpy).not.toHaveBeenCalled()
  })

  it('does nothing when itemId is missing', async () => {
    await handler({ tenantId: 'tenant-123', revisionId: 'rev-789' })
    expect(dynamoSendSpy).not.toHaveBeenCalled()
    expect(s3SendSpy).not.toHaveBeenCalled()
    expect(bedrockSendSpy).not.toHaveBeenCalled()
  })

  it('stores revised document at correct S3 path on success', async () => {
    mockHappyPath()

    await handler(makeEvent())

    const putCall = s3SendSpy.mock.calls.find(
      call => call[0].name === 'PutObjectCommand'
    )
    expect(putCall).toBeTruthy()
    expect(putCall[0].input.Key).toBe('pulse/tenant-123/items/item-456/revisions/rev-789/document.md')
    expect(putCall[0].input.Body).toBe('# Revised Document')
    expect(putCall[0].input.ContentType).toBe('text/markdown')
  })

  it('updates revision record to complete with completedAt on success', async () => {
    mockHappyPath()

    await handler(makeEvent())

    const updateCall = dynamoSendSpy.mock.calls.find(
      call => call[0].name === 'UpdateItemCommand' &&
              call[0].input.TableName === 'urgd-pulse-revisions-dev' &&
              call[0].input.ExpressionAttributeValues?.[':complete']
    )
    expect(updateCall).toBeTruthy()
    expect(updateCall[0].input.ExpressionAttributeValues[':complete'].S).toBe('complete')
    expect(updateCall[0].input.ExpressionAttributeValues[':completedAt'].S).toBeTruthy()
  })
})
