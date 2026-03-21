// Feature: pulse, Property 27: Feature Flag Enforcement Property
//
// For any Feature Flag that is false for a tenant, the corresponding API endpoint
// returns 403 and the Admin UI does not render the feature.
// For any Feature Flag that is true, the endpoint is accessible and the feature
// is visible. These are mutually exclusive states.
//
// Validates: Requirements 9.8, 9.9
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('TENANTS_TABLE', 'urgd-pulse-tenants-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
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

function makeCompletePulseCheck(tenantId, itemId) {
  return {
    Item: {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
      status: { S: 'complete' },
      feedbackPoints: {
        L: [{
          M: {
            feedbackPointId: { S: 'fp-1' },
            text: { S: 'Improve clarity' },
            section: { S: 'Introduction' },
          },
        }],
      },
      decisions: {
        M: {
          'fp-1': { M: { action: { S: 'accept' }, tenantNote: { S: '' } } },
        },
      },
    },
  }
}

describe('Property 27: Feature Flag Enforcement Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('itemRevisionLoop=false always returns 403 regardless of other conditions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (tenantId, itemId) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          // Flag is explicitly false
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: false } } },
            },
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          // INVARIANT: flag=false → 403
          expect(result.statusCode).toBe(403)
          const body = JSON.parse(result.body)
          expect(body.message).toMatch(/not enabled/i)

          // INVARIANT: No S3 or Bedrock calls when flag is off
          expect(s3SendSpy).not.toHaveBeenCalled()
          expect(bedrockSendSpy).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('itemRevisionLoop=true allows access to the revision endpoint', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 10, maxLength: 200 }),
        fc.string({ minLength: 10, maxLength: 200 }),
        async (tenantId, itemId, originalContent, revisedContent) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          // Flag is true
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: true } } },
            },
          })
          dynamoSendSpy.mockResolvedValueOnce(makeCompletePulseCheck(tenantId, itemId))
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Item' } },
          })
          dynamoSendSpy.mockResolvedValueOnce({}) // UpdateItem

          // S3: extracted.md not found, document.md found
          s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
          s3SendSpy.mockResolvedValueOnce({
            Body: (async function* () { yield Buffer.from(originalContent) })(),
          })
          s3SendSpy.mockResolvedValueOnce({}) // PutObject

          bedrockSendSpy.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
              content: [{ text: revisedContent }],
              usage: { input_tokens: 30, output_tokens: 20 },
            })),
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          // INVARIANT: flag=true → accessible (not 403)
          expect(result.statusCode).not.toBe(403)
          // Should succeed with 200
          expect(result.statusCode).toBe(200)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('flag=false and flag=true outcomes are mutually exclusive', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.boolean(),
        fc.string({ minLength: 10, maxLength: 100 }),
        fc.string({ minLength: 10, maxLength: 100 }),
        async (tenantId, itemId, flagEnabled, originalContent, revisedContent) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: flagEnabled } } },
            },
          })

          if (flagEnabled) {
            dynamoSendSpy.mockResolvedValueOnce(makeCompletePulseCheck(tenantId, itemId))
            dynamoSendSpy.mockResolvedValueOnce({
              Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Item' } },
            })
            dynamoSendSpy.mockResolvedValueOnce({})
            s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
            s3SendSpy.mockResolvedValueOnce({
              Body: (async function* () { yield Buffer.from(originalContent) })(),
            })
            s3SendSpy.mockResolvedValueOnce({})
            bedrockSendSpy.mockResolvedValueOnce({
              body: Buffer.from(JSON.stringify({
                content: [{ text: revisedContent }],
                usage: { input_tokens: 20, output_tokens: 10 },
              })),
            })
          }

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)

          if (flagEnabled) {
            // Flag on → accessible
            expect(result.statusCode).not.toBe(403)
          } else {
            // Flag off → 403
            expect(result.statusCode).toBe(403)
          }

          // These outcomes are mutually exclusive
          const is403 = result.statusCode === 403
          expect(is403).toBe(!flagEnabled)
        }
      ),
      { numRuns: 100 }
    )
  })
})
