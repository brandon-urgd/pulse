// Unit tests for urgd-pulse-generateSessionSummary
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, QueryCommand, UpdateItemCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class InvokeModelCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, InvokeModelCommand }
})

const { handler } = await import('./index.mjs')

function makeBedrockResponse(json) {
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text: JSON.stringify(json) }],
      usage: { input_tokens: 200, output_tokens: 100 },
    })),
  }
}

const VALID_SUMMARY = {
  sections: ['Introduction', 'Main Content', 'Conclusion'],
  themes: ['Theme 1', 'Theme 2', 'Theme 3'],
  closingMessage: 'Thank you for your thoughtful feedback.',
}

describe('urgd-pulse-generateSessionSummary', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
  })

  describe('successful summary generation', () => {
    it('generates and stores summary for a session with transcript', async () => {
      const transcriptItems = [
        { sessionId: { S: 'session-1' }, messageId: { S: '01H001' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
        { sessionId: { S: 'session-1' }, messageId: { S: '01H002' }, role: { S: 'reviewer' }, content: { S: 'Thanks.' } },
      ]

      sendSpy
        .mockResolvedValueOnce({ Items: transcriptItems }) // Query transcripts
        .mockResolvedValueOnce({}) // UpdateItem session

      bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse(VALID_SUMMARY))

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      // sendSpy calls: Query(0), UpdateItem(1)
      expect(sendSpy).toHaveBeenCalledTimes(2)
      const updateCall = sendSpy.mock.calls[1][0]
      expect(updateCall.input.UpdateExpression).toContain('summary')

      const summaryValue = updateCall.input.ExpressionAttributeValues[':summary'].S
      const parsed = JSON.parse(summaryValue)
      expect(parsed.sections).toEqual(VALID_SUMMARY.sections)
      expect(parsed.themes).toEqual(VALID_SUMMARY.themes)
    })

    it('handles malformed Bedrock JSON gracefully', async () => {
      sendSpy
        .mockResolvedValueOnce({ Items: [{ sessionId: { S: 'session-1' }, messageId: { S: '01H001' }, role: { S: 'agent' }, content: { S: 'Hello' } }] })
        .mockResolvedValueOnce({})

      bedrockSendSpy.mockResolvedValueOnce({
        body: Buffer.from(JSON.stringify({
          content: [{ text: 'Not valid JSON at all' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        })),
      })

      // Should not throw
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

    it('returns early when transcript is empty', async () => {
      sendSpy.mockResolvedValueOnce({ Items: [] })

      await handler({ sessionId: 'session-1', tenantId: 'tenant-1' })

      // Should not call Bedrock or UpdateItem
      expect(bedrockSendSpy).not.toHaveBeenCalled()
      const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      expect(updateCalls).toHaveLength(0)
    })

    it('handles DynamoDB failure gracefully (no throw)', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      await expect(handler({ sessionId: 'session-1', tenantId: 'tenant-1' })).resolves.toBeUndefined()
    })
  })
})
