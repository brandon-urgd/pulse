// Feature: pulse, Property 22: Pulse Check Completeness Invariant
// For any item with N completed sessions, runPulseCheck loads exactly N reports for consolidation.
// No report is omitted from the consolidation input.
// Validates: Requirements 7.4

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulseChecks-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('ALERTS_TOPIC_ARN', 'arn:aws:sns:us-west-2:123456789012:pulse-alerts-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const bedrockSendSpy = vi.fn()
const cwSendSpy = vi.fn()
const snsSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class QueryCommand { constructor(input) { this.input = input } }
  class PutItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, QueryCommand, PutItemCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send(...args) { return cwSendSpy(...args) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})

vi.mock('@aws-sdk/client-sns', () => {
  class SNSClient { send(...args) { return snsSendSpy(...args) } }
  class PublishCommand { constructor(input) { this.input = input } }
  return { SNSClient, PublishCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(tenantId, itemId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId } },
    pathParameters: { itemId },
  }
}

function makeSessionItems(count) {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: { S: `session-${i}` },
    status: { S: 'completed' },
  }))
}

function makeReportItems(count, itemId) {
  return Array.from({ length: count }, (_, i) => ({
    tenantId: { S: 'tenant-1' },
    sessionId: { S: `session-${i}` },
    itemId: { S: itemId },
    verdict: { S: 'Worth developing further' },
    conviction: { L: [{ S: 'Good idea' }] },
    tension: { L: [] },
    uncertainty: { L: [] },
    energy: { S: 'engaged' },
    conversationShape: { S: 'tactical' },
    themes: { L: [{ S: 'pricing' }] },
    isSelfReview: { BOOL: false },
  }))
}

function makeBedrockResponse(sessionCount) {
  return {
    output: { message: { content: [{
      text: JSON.stringify({
        verdict: 'Worth developing further',
        themes: [{ themeId: 'pricing', label: 'Pricing', reviewerSignals: [] }],
        sharedConviction: ['Good idea'],
        repeatedTension: [],
        openQuestions: [],
        reviewerVerdicts: Array.from({ length: sessionCount }, (_, i) => ({
          sessionId: `session-${i}`,
          verdict: 'Worth developing further',
          energy: 'engaged',
          isSelfReview: false,
        })),
      }),
    }] } },
    usage: { inputTokens: 1000, outputTokens: 500 },
  }
}

describe('Property 22: Pulse Check Completeness Invariant', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    snsSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  it('for any item with N completed sessions, Bedrock receives exactly N reports in the prompt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 1, max: 10 }),
        async (tenantId, itemId, sessionCount) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          // Query sessions (item-index GSI)
          sendSpy.mockResolvedValueOnce({ Items: makeSessionItems(sessionCount) })
          // Query reports (item-index GSI)
          sendSpy.mockResolvedValueOnce({ Items: makeReportItems(sessionCount, itemId) })
          // PutItem pulse check
          sendSpy.mockResolvedValueOnce({})

          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(sessionCount))

          const result = await handler(makeEvent(tenantId, itemId))
          expect(result.statusCode).toBe(200)

          // Verify Bedrock was called exactly once
          expect(bedrockSendSpy).toHaveBeenCalledTimes(1)

          // Verify the prompt contains all N reports
          const bedrockCall = bedrockSendSpy.mock.calls[0][0]
          const prompt = bedrockCall.input.messages[0].content[0].text

          // Each report is labeled "Reviewer N" — verify all N are present
          for (let i = 0; i < sessionCount; i++) {
            expect(prompt).toContain(`Reviewer ${i + 1}`)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('returns 409 if any session is still open (not completed or expired)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 1, max: 5 }),
        fc.constantFrom('not_started', 'in_progress'),
        async (tenantId, itemId, completedCount, openStatus) => {
          sendSpy.mockReset()

          const sessions = [
            ...makeSessionItems(completedCount),
            { sessionId: { S: 'open-session' }, status: { S: openStatus } },
          ]
          sendSpy.mockResolvedValueOnce({ Items: sessions })

          const result = await handler(makeEvent(tenantId, itemId))
          expect(result.statusCode).toBe(409)

          // Bedrock should NOT be called when sessions are still open
          expect(bedrockSendSpy).not.toHaveBeenCalled()
        }
      ),
      { numRuns: 100 }
    )
  })
})
