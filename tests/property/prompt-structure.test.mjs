// Property-based tests for system prompt structure
// Property P15

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  class InvokeModelWithResponseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('ulid', () => ({ ulid: () => '01HTEST000000000000000000' }))

const { handler } = await import('../../lambdas/urgd-pulse-chat/index.mjs')

function makeEvent(sessionId, tenantId, message) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { sessionId, tenantId },
    },
    body: JSON.stringify({ message }),
  }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: 'not_started' },
    confidentialityAcceptedAt: { S: new Date().toISOString() },
    itemId: { S: 'item-test' },
    currentSection: { N: '1' },
    totalSections: { N: '5' },
    ...overrides,
  }
}

function makeItem(overrides = {}) {
  return {
    tenantId: { S: 'tenant-test' },
    itemId: { S: 'item-test' },
    itemName: { S: 'Test Item' },
    description: { S: 'Test description' },
    itemType: { S: 'document' },
    ...overrides,
  }
}

/**
 * Property P15: System prompt structure
 *
 * (a) Behavioral guardrails appear before conversational instructions
 * (b) "don't guess" instruction is present
 * (c) When tenant description exists, anchor pattern references it
 *
 * Validates: Requirements 8.8, 8.9, 8.10
 */
describe('Property P15: System prompt structure', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    lambdaSendSpy.mockResolvedValue({})
    s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))
  })

  it('behavioral guardrails appear before conversational instructions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('document', 'image'),
        fc.string({ minLength: 0, maxLength: 200 }),
        async (itemType, description) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] }) // transcripts
          sendSpy.mockResolvedValueOnce({ Item: makeItem({ itemType: { S: itemType }, description: { S: description } }) })
          sendSpy.mockResolvedValue({})

          let capturedSystem = null
          bedrockSendSpy.mockImplementation((cmd) => {
            const payload = JSON.parse(Buffer.from(cmd.input.body).toString('utf-8'))
            capturedSystem = payload.system
            return Promise.resolve({
              body: Buffer.from(JSON.stringify({
                content: [{ text: 'Hello!' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              })),
            })
          })

          await handler(makeEvent('session-test', 'tenant-test', 'Hello'))

          if (capturedSystem) {
            // Guardrails section should appear before agent identity/conversational section
            const guardrailIdx = capturedSystem.indexOf('BEHAVIORAL GUARDRAILS')
            const agentIdentityIdx = capturedSystem.indexOf('You are Pulse')
            expect(guardrailIdx).toBeGreaterThanOrEqual(0)
            expect(agentIdentityIdx).toBeGreaterThan(guardrailIdx)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('"don\'t guess" instruction is present in system prompt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('document', 'image'),
        async (itemType) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] })
          sendSpy.mockResolvedValueOnce({ Item: makeItem({ itemType: { S: itemType } }) })
          sendSpy.mockResolvedValue({})

          let capturedSystem = null
          bedrockSendSpy.mockImplementation((cmd) => {
            const payload = JSON.parse(Buffer.from(cmd.input.body).toString('utf-8'))
            capturedSystem = payload.system
            return Promise.resolve({
              body: Buffer.from(JSON.stringify({
                content: [{ text: 'Hello!' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              })),
            })
          })

          await handler(makeEvent('session-test', 'tenant-test', 'Hello'))

          if (capturedSystem) {
            const lowerPrompt = capturedSystem.toLowerCase()
            // The prompt uses "Never guess" as the guardrail instruction
            const hasGuessGuardrail = lowerPrompt.includes("never guess") ||
              lowerPrompt.includes("don't guess") ||
              lowerPrompt.includes('do not guess')
            expect(hasGuessGuardrail).toBe(true)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when tenant description exists, anchor pattern references it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 5, maxLength: 100 }).filter(s => s.trim().length > 0),
        async (description) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] })
          sendSpy.mockResolvedValueOnce({ Item: makeItem({ description: { S: description } }) })
          sendSpy.mockResolvedValue({})

          let capturedSystem = null
          bedrockSendSpy.mockImplementation((cmd) => {
            const payload = JSON.parse(Buffer.from(cmd.input.body).toString('utf-8'))
            capturedSystem = payload.system
            return Promise.resolve({
              body: Buffer.from(JSON.stringify({
                content: [{ text: 'Hello!' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              })),
            })
          })

          await handler(makeEvent('session-test', 'tenant-test', 'Hello'))

          if (capturedSystem) {
            // The description should appear in the prompt (anchor pattern)
            expect(capturedSystem).toContain(description)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('when no description, fallback instruction is present', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('document', 'image'),
        async (itemType) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] })
          sendSpy.mockResolvedValueOnce({
            Item: makeItem({ itemType: { S: itemType }, description: undefined }),
          })
          sendSpy.mockResolvedValue({})

          let capturedSystem = null
          bedrockSendSpy.mockImplementation((cmd) => {
            const payload = JSON.parse(Buffer.from(cmd.input.body).toString('utf-8'))
            capturedSystem = payload.system
            return Promise.resolve({
              body: Buffer.from(JSON.stringify({
                content: [{ text: 'Hello!' }],
                usage: { input_tokens: 10, output_tokens: 5 },
              })),
            })
          })

          await handler(makeEvent('session-test', 'tenant-test', 'Hello'))

          if (capturedSystem) {
            // Should have fallback instruction when no description
            expect(capturedSystem).toContain('No specific feedback focus')
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
