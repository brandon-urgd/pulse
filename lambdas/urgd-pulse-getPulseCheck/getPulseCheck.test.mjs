// Unit tests for urgd-pulse-getPulseCheck
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulseChecks-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(tenantId, itemId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId } },
    pathParameters: { itemId },
  }
}

const PULSE_CHECK_ITEM = {
  tenantId: { S: 'tenant-1' },
  itemId: { S: 'item-1' },
  verdict: { S: 'Worth developing further' },
  themes: {
    L: [{
      M: {
        themeId: { S: 'pricing' },
        label: { S: 'Pricing' },
        reviewerSignals: {
          L: [{
            M: {
              sessionId: { S: 'session-1' },
              signalType: { S: 'conviction' },
              quote: { S: 'Pricing is solid' },
            },
          }],
        },
      },
    }],
  },
  sharedConviction: { L: [{ S: 'Pricing is solid' }] },
  repeatedTension: { L: [] },
  openQuestions: { L: [{ S: 'What is the market size?' }] },
  reviewerVerdicts: {
    L: [{
      M: {
        sessionId: { S: 'session-1' },
        verdict: { S: 'Worth developing further' },
        energy: { S: 'engaged' },
        isSelfReview: { BOOL: false },
      },
    }],
  },
  decisions: {
    M: {
      pricing: {
        M: {
          action: { S: 'Accept' },
          tenantNote: { S: '' },
          decidedAt: { S: '2024-01-01T00:00:00.000Z' },
        },
      },
    },
  },
  sessionCount: { N: '1' },
  generatedAt: { S: '2024-01-01T00:00:00.000Z' },
  status: { S: 'complete' },
}

describe('urgd-pulse-getPulseCheck', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('successful retrieval', () => {
    it('returns pulse check with all required fields', async () => {
      sendSpy.mockResolvedValueOnce({ Item: PULSE_CHECK_ITEM })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(200)

      const body = JSON.parse(result.body)
      const pc = body.data

      expect(pc.verdict).toBe('Worth developing further')
      expect(pc.themes).toHaveLength(1)
      expect(pc.themes[0].themeId).toBe('pricing')
      expect(pc.themes[0].reviewerSignals).toHaveLength(1)
      expect(pc.sharedConviction).toEqual(['Pricing is solid'])
      expect(pc.repeatedTension).toEqual([])
      expect(pc.openQuestions).toEqual(['What is the market size?'])
      expect(pc.reviewerVerdicts).toHaveLength(1)
      expect(pc.sessionCount).toBe(1)
      expect(pc.status).toBe('complete')
    })

    it('returns decisions map when decisions exist', async () => {
      sendSpy.mockResolvedValueOnce({ Item: PULSE_CHECK_ITEM })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      const body = JSON.parse(result.body)

      expect(body.data.decisions).toBeDefined()
      expect(body.data.decisions.pricing.action).toBe('Accept')
    })

    it('returns empty decisions when no decisions saved', async () => {
      const itemWithoutDecisions = { ...PULSE_CHECK_ITEM }
      delete itemWithoutDecisions.decisions
      sendSpy.mockResolvedValueOnce({ Item: itemWithoutDecisions })

      const result = await handler(makeEvent('tenant-1', 'item-1'))
      const body = JSON.parse(result.body)
      expect(body.data.decisions).toEqual({})
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

    it('returns 404 when pulse check not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: null })
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(404)
    })

    it('returns 500 on DynamoDB error', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
      const result = await handler(makeEvent('tenant-1', 'item-1'))
      expect(result.statusCode).toBe(500)
    })
  })
})
