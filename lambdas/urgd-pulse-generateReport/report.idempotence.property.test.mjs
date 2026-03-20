// Feature: pulse, Property 21: Report Idempotence Property
// For any completed session, generateReport produces exactly one report.
// Invoking generateReport a second time for the same session replaces the previous report —
// the reports table contains exactly one record per session after any number of invocations.
// Validates: Requirements 7.1

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, PutItemCommand }
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

function makeBedrockResponse(verdict = 'Worth developing further') {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{
        text: JSON.stringify({
          verdict,
          conviction: ['The pricing model is solid'],
          tension: ['Timeline feels aggressive'],
          uncertainty: ['Not sure about the market size'],
          energy: 'engaged',
          conversationShape: 'tactical',
          themes: ['pricing', 'timeline', 'market'],
        }),
      }],
      usage: { input_tokens: 500, output_tokens: 200 },
    })),
  }
}

function makeTranscriptItems(sessionId, count = 4) {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: { S: sessionId },
    messageId: { S: `01H${String(i).padStart(18, '0')}` },
    role: { S: i % 2 === 0 ? 'agent' : 'reviewer' },
    content: { S: `Message ${i}` },
  }))
}

describe('Property 21: Report Idempotence Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('invoking generateReport N times for the same session always uses PutItem (idempotent replace)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 1, max: 5 }),
        async (sessionId, tenantId, invocations) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          // Each invocation: GetItem(session) + Query(transcripts) + PutItem(report)
          for (let i = 0; i < invocations; i++) {
            sendSpy
              .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } }) // GetItem session
              .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) }) // Query transcripts
              .mockResolvedValueOnce({}) // PutItem report
            bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())
          }

          for (let i = 0; i < invocations; i++) {
            await handler({ sessionId, tenantId })
          }

          // Count PutItem calls — should equal number of invocations (each replaces the previous)
          const putItemCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'PutItemCommand')
          expect(putItemCalls).toHaveLength(invocations)

          // Each PutItem uses the same PK/SK (tenantId + sessionId) — idempotent replace
          for (const call of putItemCalls) {
            expect(call[0].input.Item.tenantId.S).toBe(tenantId)
            expect(call[0].input.Item.sessionId.S).toBe(sessionId)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('each invocation stores exactly one report record (PutItem, not UpdateItem)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (sessionId, tenantId) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy
            .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
            .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) })
            .mockResolvedValueOnce({})
          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

          await handler({ sessionId, tenantId })

          const putItemCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'PutItemCommand')
          const updateItemCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')

          // Must use PutItem (not UpdateItem) for idempotent replace
          expect(putItemCalls).toHaveLength(1)
          expect(updateItemCalls).toHaveLength(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
