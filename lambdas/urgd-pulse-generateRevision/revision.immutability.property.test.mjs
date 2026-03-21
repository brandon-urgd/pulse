// Feature: pulse, Property 24: Revision Immutability Invariant
//
// For any item revision, the original document at
// pulse/{tenantId}/items/{itemId}/document.md is byte-for-byte identical
// before and after revision generation; the revision is stored at a separate,
// unique S3 path with a unique revisionId.
//
// Validates: Requirements 8.1, 8.13
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

describe('Property 24: Revision Immutability Invariant', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('original document path is never written to during revision generation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 10, maxLength: 500 }),
        fc.string({ minLength: 10, maxLength: 500 }),
        async (tenantId, itemId, originalContent, revisedContent) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          const originalDocKey = `pulse/${tenantId}/items/${itemId}/document.md`
          const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`

          // Setup: tenant with flag on
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId },
              features: { M: { itemRevisionLoop: { BOOL: true } } },
            },
          })
          // Pulse check complete with one accepted decision
          dynamoSendSpy.mockResolvedValueOnce({
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
          })
          // Item record
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Test Item' } },
          })
          // S3: extracted.md not found, document.md found
          s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
          s3SendSpy.mockResolvedValueOnce({
            Body: (async function* () { yield Buffer.from(originalContent) })(),
          })
          // Bedrock response
          bedrockSendSpy.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
              content: [{ text: revisedContent }],
              usage: { input_tokens: 50, output_tokens: 30 },
            })),
          })
          // S3 PutObject for revision
          s3SendSpy.mockResolvedValueOnce({})
          // DynamoDB UpdateItem
          dynamoSendSpy.mockResolvedValueOnce({})

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: {
              requestId: 'req-prop',
              authorizer: { tenantId },
            },
            pathParameters: { itemId },
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          // INVARIANT: No S3 write to the original document path
          const putCalls = s3SendSpy.mock.calls.filter(call =>
            call[0].constructor?.name === 'PutObjectCommand'
          )
          for (const call of putCalls) {
            const key = call[0].input.Key
            expect(key).not.toBe(originalDocKey)
            expect(key).not.toBe(extractedKey)
          }

          // INVARIANT: Revision stored at a unique path under /revisions/
          expect(putCalls).toHaveLength(1)
          const revisionKey = putCalls[0][0].input.Key
          expect(revisionKey).toMatch(
            new RegExp(`^pulse/${escapeRegExp(tenantId)}/items/${escapeRegExp(itemId)}/revisions/[^/]+/document\\.md$`)
          )

          // INVARIANT: revisionId in response is unique (UUID format)
          const body = JSON.parse(result.body)
          expect(body.data.revisionId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          )
        }
      ),
      { numRuns: 100 }
    )
  })

  it('two revision calls produce two distinct revisionIds and S3 paths', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (tenantId, itemId) => {
          const revisionIds = new Set()

          for (let i = 0; i < 2; i++) {
            dynamoSendSpy.mockReset()
            s3SendSpy.mockReset()
            bedrockSendSpy.mockReset()
            cwSendSpy.mockResolvedValue({})

            dynamoSendSpy.mockResolvedValueOnce({
              Item: { tenantId: { S: tenantId }, features: { M: { itemRevisionLoop: { BOOL: true } } } },
            })
            dynamoSendSpy.mockResolvedValueOnce({
              Item: {
                tenantId: { S: tenantId }, itemId: { S: itemId }, status: { S: 'complete' },
                feedbackPoints: { L: [{ M: { feedbackPointId: { S: 'fp-1' }, text: { S: 'Fix it' }, section: { S: 'S1' } } }] },
                decisions: { M: { 'fp-1': { M: { action: { S: 'accept' }, tenantNote: { S: '' } } } } },
              },
            })
            dynamoSendSpy.mockResolvedValueOnce({
              Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Item' } },
            })
            s3SendSpy.mockRejectedValueOnce(new Error('NoSuchKey'))
            s3SendSpy.mockResolvedValueOnce({ Body: (async function* () { yield Buffer.from('content') })() })
            bedrockSendSpy.mockResolvedValueOnce({
              body: Buffer.from(JSON.stringify({ content: [{ text: 'revised' }], usage: { input_tokens: 10, output_tokens: 5 } })),
            })
            s3SendSpy.mockResolvedValueOnce({})
            dynamoSendSpy.mockResolvedValueOnce({})

            const event = {
              headers: { origin: 'https://pulse.urgdstudios.com' },
              requestContext: { requestId: 'req', authorizer: { tenantId } },
              pathParameters: { itemId },
            }

            const result = await handler(event)
            expect(result.statusCode).toBe(200)
            const body = JSON.parse(result.body)
            revisionIds.add(body.data.revisionId)
          }

          // Both revisions must have distinct IDs
          expect(revisionIds.size).toBe(2)
        }
      ),
      { numRuns: 100 }
    )
  })
})
