// Unit tests for urgd-pulse-generateReport
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const VALID_REPORT = {
  verdict: 'Worth developing further',
  conviction: ['The pricing model is solid'],
  tension: ['Timeline feels aggressive'],
  uncertainty: ['Not sure about the market size'],
  energy: 'engaged',
  conversationShape: 'tactical',
  themes: ['pricing', 'timeline', 'market'],
}

function makeBedrockResponse(report = VALID_REPORT) {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text: JSON.stringify(report) }],
      usage: { input_tokens: 500, output_tokens: 200 },
    })),
  }
}

const TRANSCRIPT_ITEMS = [
  { sessionId: { S: 'session-1' }, messageId: { S: '01H001' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
  { sessionId: { S: 'session-1' }, messageId: { S: '01H002' }, role: { S: 'reviewer' }, content: { S: 'Looks good.' } },
  { sessionId: { S: 'session-1' }, messageId: { S: '01H003' }, role: { S: 'agent' }, content: { S: 'Tell me more.' } },
  { sessionId: { S: 'session-1' }, messageId: { S: '01H004' }, role: { S: 'reviewer' }, content: { S: 'The pricing is solid.' } },
]

describe('urgd-pulse-generateReport', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  describe('successful report generation', () => {
    it('sends transcript to Bedrock and stores report with all required fields', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
      expect(putCall).toBeDefined()

      const item = putCall[0].input.Item
      expect(item.tenantId.S).toBe('tenant-1')
      expect(item.sessionId.S).toBe('session-1')
      expect(item.itemId.S).toBe('item-1')
      expect(item.verdict.S).toBe('Worth developing further')
      expect(item.energy.S).toBe('engaged')
      expect(item.conversationShape.S).toBe('tactical')
      expect(item.conviction.L).toHaveLength(1)
      expect(item.tension.L).toHaveLength(1)
      expect(item.uncertainty.L).toHaveLength(1)
      expect(item.themes.L).toHaveLength(3)
      expect(item.generatedAt.S).toBeTruthy()
    })

    it('replaces existing report (idempotent — uses PutItem not UpdateItem)', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'PutItemCommand')
      const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      expect(putCalls).toHaveLength(1)
      expect(updateCalls).toHaveLength(0)
    })

    it('preserves reviewer voice — stores conviction/tension/uncertainty as-is from Bedrock', async () => {
      const rawVoice = {
        ...VALID_REPORT,
        conviction: ["this feels half-baked honestly"],
        tension: ["I don't buy the timeline at all"],
      }
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(rawVoice))

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
      const item = putCall[0].input.Item
      expect(item.conviction.L[0].S).toBe("this feels half-baked honestly")
      expect(item.tension.L[0].S).toBe("I don't buy the timeline at all")
    })

    it('tags isSelfReview correctly from session record', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: true } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
      expect(putCall[0].input.Item.isSelfReview.BOOL).toBe(true)
    })

    it('publishes BedrockLatency, BedrockTokensIn, BedrockTokensOut metrics', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse())

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      expect(cwSendSpy).toHaveBeenCalled()
      const cwCall = cwSendSpy.mock.calls[0][0]
      const metricNames = cwCall.input.MetricData.map(m => m.MetricName)
      expect(metricNames).toContain('BedrockLatency')
      expect(metricNames).toContain('BedrockTokensIn')
      expect(metricNames).toContain('BedrockTokensOut')
    })
  })

  describe('normalization of invalid Bedrock responses', () => {
    it('normalizes invalid verdict to Unclear / needs clarity', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ ...VALID_REPORT, verdict: 'invalid verdict' }))

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
      expect(putCall[0].input.Item.verdict.S).toBe('Unclear / needs clarity')
    })

    it('normalizes invalid energy to neutral', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ ...VALID_REPORT, energy: 'very excited' }))

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
      expect(putCall[0].input.Item.energy.S).toBe('neutral')
    })

    it('handles malformed Bedrock JSON gracefully', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
        .mockResolvedValueOnce({})
      bedrockSendSpy.mockResolvedValueOnce({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Not valid JSON at all' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        })),
      })

      await expect(handler({ sessionId: 'session-1', tenantId: 'tenant-1' })).resolves.toBeUndefined()
    })
  })

  describe('edge cases', () => {
    it('returns early when sessionId is missing', async () => {
      await handler({ tenantId: 'tenant-1' })
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('returns early when tenantId is missing', async () => {
      await handler({ sessionId: 'session-1' })
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('returns early when session not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: null })
      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })

    it('returns early when transcript is empty', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: [] })
      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })

    it('handles DynamoDB failure gracefully (no throw)', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
      await expect(handler({ sessionId: 'session-1', tenantId: 'tenant-1' })).resolves.toBeUndefined()
    })

    it('handles Bedrock failure gracefully — publishes BedrockErrors metric and does not throw', async () => {
      sendSpy
        .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
        .mockResolvedValueOnce({ Items: TRANSCRIPT_ITEMS })
      bedrockSendSpy.mockRejectedValueOnce(Object.assign(new Error('Bedrock error'), { name: 'ServiceUnavailableException' }))

      await expect(handler({ sessionId: 'session-1', tenantId: 'tenant-1' })).resolves.toBeUndefined()

      // BedrockErrors metric should be published
      const errorMetricCall = cwSendSpy.mock.calls.find(c =>
        c[0]?.input?.MetricData?.some(m => m.MetricName === 'BedrockErrors')
      )
      expect(errorMetricCall).toBeDefined()
    })

    it('returns early when session has no itemId', async () => {
      sendSpy.mockResolvedValueOnce({ Item: { isSelfReview: { BOOL: false } } }) // no itemId
      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })
      expect(bedrockSendSpy).not.toHaveBeenCalled()
    })
  })
})
