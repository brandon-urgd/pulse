// Feature: pulse, Property 30: Signal Type Separation Property
// For any generated report, every feedback item is classified as exactly one of
// Conviction, Tension, or Uncertainty. No item is unclassified. No item belongs
// to multiple signal types. The energy field is always one of engaged, neutral, or resistant.
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

const VALID_VERDICTS = ['Worth developing further', 'Not there yet', 'Unclear / needs clarity']
const VALID_ENERGIES = ['engaged', 'neutral', 'resistant']
const VALID_SHAPES = ['tactical', 'emotional', 'philosophical', 'mixed']

function makeBedrockResponse(overrides = {}) {
  const base = {
    verdict: 'Worth developing further',
    conviction: ['The pricing model is solid', 'Team structure makes sense'],
    tension: ['Timeline feels aggressive'],
    uncertainty: ['Not sure about the market size'],
    energy: 'engaged',
    conversationShape: 'tactical',
    themes: ['pricing', 'timeline', 'market'],
  }
  return {
    body: Buffer.from(JSON.stringify({
      content: [{ text: JSON.stringify({ ...base, ...overrides }) }],
      usage: { input_tokens: 500, output_tokens: 200 },
    })),
  }
}

function makeTranscriptItems(sessionId) {
  return [
    { sessionId: { S: sessionId }, messageId: { S: '01H001' }, role: { S: 'agent' }, content: { S: 'Welcome!' } },
    { sessionId: { S: sessionId }, messageId: { S: '01H002' }, role: { S: 'reviewer' }, content: { S: 'Looks good.' } },
  ]
}

describe('Property 30: Signal Type Separation Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    bedrockSendSpy.mockReset()
    cwSendSpy.mockReset()
    cwSendSpy.mockResolvedValue({})
  })

  it('energy field is always one of engaged, neutral, or resistant', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.constantFrom(...VALID_ENERGIES),
        async (sessionId, tenantId, energy) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy
            .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
            .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) })
            .mockResolvedValueOnce({})
          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ energy }))

          await handler({ sessionId, tenantId })

          const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
          expect(putCall).toBeDefined()
          const storedEnergy = putCall[0].input.Item.energy.S
          expect(VALID_ENERGIES).toContain(storedEnergy)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('invalid energy from Bedrock is normalized to neutral', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => !VALID_ENERGIES.includes(s)),
        async (sessionId, tenantId, invalidEnergy) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy
            .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
            .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) })
            .mockResolvedValueOnce({})
          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ energy: invalidEnergy }))

          await handler({ sessionId, tenantId })

          const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
          expect(putCall).toBeDefined()
          const storedEnergy = putCall[0].input.Item.energy.S
          // Invalid energy must be normalized to a valid value
          expect(VALID_ENERGIES).toContain(storedEnergy)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('conviction, tension, and uncertainty are stored as separate arrays — no item in multiple types', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        // Generate three disjoint arrays by using unique strings per array
        fc.tuple(
          fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.startsWith('c')), { minLength: 0, maxLength: 5 }),
          fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.startsWith('t')), { minLength: 0, maxLength: 5 }),
          fc.array(fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.startsWith('u')), { minLength: 0, maxLength: 5 }),
        ),
        async (sessionId, tenantId, [conviction, tension, uncertainty]) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy
            .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
            .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) })
            .mockResolvedValueOnce({})
          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ conviction, tension, uncertainty }))

          await handler({ sessionId, tenantId })

          const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
          expect(putCall).toBeDefined()

          const item = putCall[0].input.Item
          const storedConviction = (item.conviction.L || []).map(c => c.S)
          const storedTension = (item.tension.L || []).map(t => t.S)
          const storedUncertainty = (item.uncertainty.L || []).map(u => u.S)

          // Verify the three arrays are stored separately
          expect(Array.isArray(storedConviction)).toBe(true)
          expect(Array.isArray(storedTension)).toBe(true)
          expect(Array.isArray(storedUncertainty)).toBe(true)

          // No item should appear in multiple signal types
          const convictionSet = new Set(storedConviction)
          const tensionSet = new Set(storedTension)
          const uncertaintySet = new Set(storedUncertainty)

          for (const c of convictionSet) {
            expect(tensionSet.has(c)).toBe(false)
            expect(uncertaintySet.has(c)).toBe(false)
          }
          for (const t of tensionSet) {
            expect(uncertaintySet.has(t)).toBe(false)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('verdict is always one of the three valid values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.constantFrom(...VALID_VERDICTS),
        async (sessionId, tenantId, verdict) => {
          sendSpy.mockReset()
          bedrockSendSpy.mockReset()

          sendSpy
            .mockResolvedValueOnce({ Item: { itemId: { S: 'item-1' }, isSelfReview: { BOOL: false } } })
            .mockResolvedValueOnce({ Items: makeTranscriptItems(sessionId) })
            .mockResolvedValueOnce({})
          bedrockSendSpy.mockResolvedValueOnce(makeBedrockResponse({ verdict }))

          await handler({ sessionId, tenantId })

          const putCall = sendSpy.mock.calls.find(c => c[0]?.constructor?.name === 'PutItemCommand')
          expect(putCall).toBeDefined()
          const storedVerdict = putCall[0].input.Item.verdict.S
          expect(VALID_VERDICTS).toContain(storedVerdict)
        }
      ),
      { numRuns: 100 }
    )
  })
})
