// Unit tests for urgd-pulse-runPulseCheck
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const COMPLETED_SESSIONS = [
  { sessionId: { S: 'session-1' }, status: { S: 'completed' } },
  { sessionId: { S: 'session-2' }, status: { S: 'completed' } },
]

const EXPIRED_SESSIONS = [
  { sessionId: { S: 'session-1' }, status: { S: 'completed' } },
  { sessionId: { S: 'session-2' }, status: { S: 'expired' } },
]

const REPORT_ITEMS = [
  {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-1' },
    itemId: { S: 'item-1' },
    verdict: { S: 'Worth developing further' },
    conviction: { L: [{ S: 'Pricing is solid' }] },
    tension: { L: [] },
    uncertainty: { L: [] },
    energy: { S: 'engaged' },
    conversationShape: { S: 'tactical' },
    themes: { L: [{ S: 'pricing' }] },
    isSelfReview: { BOOL: false },
  },
  {
    tenantId: { S: 'tenant-1' },
    sessionId: { S: 'session-2' },
    itemId: { S: 'item-1' },
    verdict: { S: 'Not there yet' },
    conviction: { L: [] },
    tension: { L: [{ S: 'Timeline is too aggressive' }] },
    uncertainty: { L: [{ S: 'Market size unclear' }] },
    energy: { S: 'neutral' },
    conversationShape: { S: 'philosophical' },
    themes: { L: [{ S: 'timeline' }, { S: 'market' }] },
    isSelfReview: { BOOL: false },
  },
]

const SELF_REVIEW_REPORT = {
  tenantId: { S: 'tenant-1' },
  sessionId: { S: 'session-self' },
  itemId: { S: 'item-1' },
  verdict: { S: 'Worth developing further' },
  conviction: { L: [{ S: 'I believe in this' }] },
  tension: { L: [] },
  uncertainty: { L: [] },
  energy: { S: 'engaged' },
  conversationShape: { S: 'emotional' },
  themes: { L: [{ S: 'vision' }] },
  isSelfReview: { BOOL: true },
}

function makeBedrockResponse() {
  return {
    output: { message: { content: [{
      text: JSON.stringify({
        verdict: 'Worth developing further',
        themes: [{ themeId: 'pricing', label: 'Pricing', reviewerSignals: [] }],
        sharedConviction: ['Pricing is solid'],
        repeatedTension: [],
        openQuestions: ['What is the market size?'],
        reviewerVerdicts: [
          { sessionId: 'session-1', verdict: 'Worth developing further', energy: 'engaged', isSelfReview: false },
          { sessionId: 'session-2', verdict: 'Not there yet', energy: 'neutral', isSelfReview: false },
        ],
      }),
    }] } },
    usage: { inputTokens: 1000, outputTokens: 500 },
  }
}

describe('urgd-pulse-runPulseCheck', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    snsSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
    snsSendSpy.mockResolvedValue({})
  })

  describe('successful pulse check', () => {
    it('loads all N reports and consolidates via Bedrock', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS }) // Query sessions
        .mockResolvedValueOnce({ Items: REPORT_ITEMS }) // Query reports
        .mockResolvedValueOnce({}) // PutItem pulse check
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      expect(body.data.verdict).toBe('Worth developing further')
      expect(body.data.sessionCount).toBe(2)
      expect(body.data.status).toBe('complete')
    })

    it('returns verdict, themes, sharedConviction, repeatedTension, openQuestions, reviewerVerdicts', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      const body = JSON.parse(result.body)
      const pc = body.data

      expect(pc).toHaveProperty('verdict')
      expect(pc).toHaveProperty('themes')
      expect(pc).toHaveProperty('sharedConviction')
      expect(pc).toHaveProperty('repeatedTension')
      expect(pc).toHaveProperty('openQuestions')
      expect(pc).toHaveProperty('reviewerVerdicts')
      expect(pc).toHaveProperty('sessionCount')
      expect(pc).toHaveProperty('generatedAt')
    })

    it('accepts expired sessions as valid (completed or expired)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: EXPIRED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(200)
    })

    it('separates self-review signals from external signals in the prompt', async () => {
      const selfReviewSession = { sessionId: { S: 'session-self' }, status: { S: 'completed' } }
      sendSpy
        .mockResolvedValueOnce({ Items: [...COMPLETED_SESSIONS, selfReviewSession] })
        .mockResolvedValueOnce({ Items: [...REPORT_ITEMS, SELF_REVIEW_REPORT] })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler(makeEvent('tenant-1', 'item-1'))

      const bedrockCall = bedrockSendSpy.mock.calls[0][0]
      const prompt = bedrockCall.input.messages[0].content[0].text

      // Self-review should be labeled in the prompt
      expect(prompt).toContain('Self-Review')
    })

    it('publishes Bedrock metrics', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler(makeEvent('tenant-1', 'item-1'))

      expect(cwSendSpy).toHaveBeenCalled()
      const cwCall = cwSendSpy.mock.calls[0][0]
      const metricNames = cwCall.input.MetricData.map(m => m.MetricName)
      expect(metricNames).toContain('BedrockLatency')
      expect(metricNames).toContain('BedrockTokensIn')
      expect(metricNames).toContain('BedrockTokensOut')
    })
  })

  describe('409 when sessions still open', () => {
    it('returns 409 if any session is in_progress', async () => {
      sendSpy.mockResolvedValueOnce({
        Items: [
          { sessionId: { S: 'session-1' }, status: { S: 'completed' } },
          { sessionId: { S: 'session-2' }, status: { S: 'in_progress' } },
        ],
      })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(409)
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })

    it('returns 409 if any session is not_started', async () => {
      sendSpy.mockResolvedValueOnce({
        Items: [
          { sessionId: { S: 'session-1' }, status: { S: 'not_started' } },
        ],
      })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(409)
    })
  })

  describe('Bedrock error handling', () => {
    it('returns 503 on Bedrock error and publishes SNS alert', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
      bedrockSendSpy.mockRejectedValueOnce(Object.assign(new Error('Bedrock error'), { name: 'ServiceUnavailableException' }))

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(503)
      expect(snsSendSpy).toHaveBeenCalled()
    })
  })

  describe('error cases', () => {
    it('returns 401 when tenantId is missing', async () => {
      const result = await handler({
        headers: {},
        requestContext: { authorizer: {} },
        pathParameters: { itemId: 'item-1' },
      })
      expect(result.statusCode).toBe(401)
    })

    it('returns 404 when no sessions found', async () => {
      sendSpy.mockResolvedValueOnce({ Items: [] })
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(404)
    })

    it('handles malformed Bedrock JSON gracefully — normalizes to defaults', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce({
        output: { message: { content: [{ text: 'not valid json at all' }] } },
        usage: { inputTokens: 100, outputTokens: 50 },
      })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.verdict).toBe('Unclear / needs clarity')
    })

    it('returns 500 on unexpected DynamoDB error after Bedrock succeeds', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: COMPLETED_SESSIONS })
        .mockResolvedValueOnce({ Items: REPORT_ITEMS })
        .mockRejectedValueOnce(new Error('DynamoDB PutItem failed'))
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(500)
    })
  })
})
