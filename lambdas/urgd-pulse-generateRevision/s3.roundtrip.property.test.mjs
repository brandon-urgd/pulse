// Feature: pulse, Property 26: S3 Content Round-Trip Property
//
// For any document content written to S3 (pasted text, extracted text, or revision),
// reading the object immediately after writing returns the same bytes that were written.
// read(write(content)) == content
//
// Validates: Requirements 12.1, 12.4, 12.5
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

/**
 * Simulates an in-memory S3 store to verify round-trip fidelity.
 * The store maps S3 key → content string.
 */
function createS3Store(initialContent) {
  const store = new Map()

  return {
    store,
    mockS3: (key, content) => {
      store.set(key, content)
    },
    setupMocks: (originalKey, originalContent, revisedContent) => {
      s3SendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name

        if (name === 'GetObjectCommand') {
          const key = cmd.input.Key
          const content = store.get(key)
          if (!content) {
            const err = new Error('NoSuchKey')
            err.name = 'NoSuchKey'
            return Promise.reject(err)
          }
          return Promise.resolve({
            Body: (async function* () { yield Buffer.from(content) })(),
          })
        }

        if (name === 'PutObjectCommand') {
          const key = cmd.input.Key
          const body = cmd.input.Body
          // Store the written content
          store.set(key, body)
          return Promise.resolve({})
        }

        return Promise.resolve({})
      })

      // Pre-populate the original document
      store.set(originalKey, originalContent)
    },
  }
}

describe('Property 26: S3 Content Round-Trip Property', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('revision content written to S3 is byte-for-byte identical when read back', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        // Document content: printable ASCII strings of reasonable length
        fc.string({ minLength: 10, maxLength: 1000 }),
        // Revised content: what Bedrock returns
        fc.string({ minLength: 10, maxLength: 1000 }),
        async (tenantId, itemId, originalContent, revisedContent) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          const originalKey = `pulse/${tenantId}/items/${itemId}/document.md`
          const { store, setupMocks } = createS3Store()
          setupMocks(originalKey, originalContent, revisedContent)

          // Setup DynamoDB mocks
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, features: { M: { itemRevisionLoop: { BOOL: true } } } },
          })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId }, itemId: { S: itemId }, status: { S: 'complete' },
              feedbackPoints: { L: [{ M: { feedbackPointId: { S: 'fp-1' }, text: { S: 'Improve it' }, section: { S: 'S1' } } }] },
              decisions: { M: { 'fp-1': { M: { action: { S: 'accept' }, tenantNote: { S: '' } } } } },
            },
          })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Test Item' } },
          })
          dynamoSendSpy.mockResolvedValueOnce({}) // UpdateItem

          // Bedrock returns the revised content
          bedrockSendSpy.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
              content: [{ text: revisedContent }],
              usage: { input_tokens: 50, output_tokens: 30 },
            })),
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          const revisionId = body.data.revisionId
          const revisionKey = `pulse/${tenantId}/items/${itemId}/revisions/${revisionId}/document.md`

          // INVARIANT: The content stored at the revision key equals what Bedrock returned
          const storedContent = store.get(revisionKey)
          expect(storedContent).toBe(revisedContent)

          // INVARIANT: The original document is unchanged
          const originalStored = store.get(originalKey)
          expect(originalStored).toBe(originalContent)

          // INVARIANT: read(write(content)) == content
          // The stored revision content equals the Bedrock output exactly
          expect(storedContent).toBe(revisedContent)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('original document content is preserved byte-for-byte after revision', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 5, maxLength: 500 }),
        fc.string({ minLength: 5, maxLength: 500 }),
        async (tenantId, itemId, originalContent, revisedContent) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          cwSendSpy.mockResolvedValue({})

          const originalKey = `pulse/${tenantId}/items/${itemId}/document.md`
          const { store, setupMocks } = createS3Store()
          setupMocks(originalKey, originalContent, revisedContent)

          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, features: { M: { itemRevisionLoop: { BOOL: true } } } },
          })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: tenantId }, itemId: { S: itemId }, status: { S: 'complete' },
              feedbackPoints: { L: [{ M: { feedbackPointId: { S: 'fp-1' }, text: { S: 'Fix' }, section: { S: 'S1' } } }] },
              decisions: { M: { 'fp-1': { M: { action: { S: 'accept' }, tenantNote: { S: '' } } } } },
            },
          })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Item' } },
          })
          dynamoSendSpy.mockResolvedValueOnce({})

          bedrockSendSpy.mockResolvedValueOnce({
            body: Buffer.from(JSON.stringify({
              content: [{ text: revisedContent }],
              usage: { input_tokens: 20, output_tokens: 10 },
            })),
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req-prop', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          await handler(event)

          // INVARIANT: Original document content is unchanged after revision
          const originalAfter = store.get(originalKey)
          expect(originalAfter).toBe(originalContent)

          // INVARIANT: No write to the original key
          const putCalls = s3SendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'PutObjectCommand')
          for (const call of putCalls) {
            expect(call[0].input.Key).not.toBe(originalKey)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
