// Feature: async-revision-generation, Property 3: Worker completion transitions revision to complete with stored document
//
// For any valid worker invocation where Bedrock returns successfully, the worker Lambda
// SHALL store the revised document in S3 at the path
// pulse/{tenantId}/items/{itemId}/revisions/{revisionId}/document.md
// AND SHALL update the revision record to status 'complete' with a valid completedAt ISO-8601 timestamp.
//
// **Validates: Requirements 2.2**
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

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

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// Generator for valid Bedrock responses
const validBedrockResponseArb = fc.record({
  tenantId: fc.uuid(),
  itemId: fc.uuid(),
  revisionId: fc.uuid(),
  originalContent: fc.string({ minLength: 10, maxLength: 500 }),
  revisedContent: fc.string({ minLength: 10, maxLength: 500 }),
  tokensIn: fc.integer({ min: 10, max: 5000 }),
  tokensOut: fc.integer({ min: 5, max: 2000 }),
})

function makePulseCheck(tenantId, itemId) {
  return {
    Item: {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
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

describe('Property 3: Worker completion transitions revision to complete with stored document', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('valid Bedrock responses produce correct S3 storage and revision status transition', async () => {
    await fc.assert(
      fc.asyncProperty(
        validBedrockResponseArb,
        async ({ tenantId, itemId, revisionId, originalContent, revisedContent, tokensIn, tokensOut }) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          // S3: extracted.md not found, document.md found
          s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
          s3SendSpy.mockResolvedValueOnce({
            Body: (async function* () { yield Buffer.from(originalContent) })(),
          })
          // S3 PutObject for revision
          s3SendSpy.mockResolvedValueOnce({})

          // DynamoDB: pulse check
          dynamoSendSpy.mockResolvedValueOnce(makePulseCheck(tenantId, itemId))
          // DynamoDB: UpdateItem revision → complete
          dynamoSendSpy.mockResolvedValueOnce({})
          // DynamoDB: UpdateItem item → revised
          dynamoSendSpy.mockResolvedValueOnce({})

          // Bedrock response
          bedrockSendSpy.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
              content: [{ text: revisedContent }],
              usage: { input_tokens: tokensIn, output_tokens: tokensOut },
            })),
          })

          const event = {
            tenantId,
            itemId,
            revisionId,
            startedAt: new Date().toISOString(),
          }

          await handler(event)

          // INVARIANT 1: S3 PutObject at correct path
          const putCall = s3SendSpy.mock.calls.find(
            call => call[0].name === 'PutObjectCommand'
          )
          expect(putCall).toBeTruthy()
          const expectedKey = `pulse/${tenantId}/items/${itemId}/revisions/${revisionId}/document.md`
          expect(putCall[0].input.Key).toBe(expectedKey)
          expect(putCall[0].input.Body).toBe(revisedContent)
          expect(putCall[0].input.Bucket).toBe('urgd-pulse-data-dev')

          // INVARIANT 2: Revision record updated to 'complete' with completedAt
          const updateRevisionCall = dynamoSendSpy.mock.calls.find(
            call => call[0].name === 'UpdateItemCommand' &&
                    call[0].input.TableName === 'urgd-pulse-revisions-dev'
          )
          expect(updateRevisionCall).toBeTruthy()
          expect(updateRevisionCall[0].input.ExpressionAttributeValues[':complete'].S).toBe('complete')
          const completedAt = updateRevisionCall[0].input.ExpressionAttributeValues[':completedAt'].S
          expect(completedAt).toMatch(ISO_8601_REGEX)
        }
      ),
      { numRuns: 100 }
    )
  })
})
