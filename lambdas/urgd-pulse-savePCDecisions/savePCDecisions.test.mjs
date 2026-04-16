// Unit tests for urgd-pulse-savePCDecisions
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulseChecks-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent(tenantId, itemId, decisions) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: { requestId: 'req-test', authorizer: { tenantId } },
    pathParameters: { itemId },
    body: JSON.stringify({ decisions }),
  }
}

const PULSE_CHECK_WITH_THEMES = {
  Item: {
    tenantId: { S: 'tenant-1' },
    itemId: { S: 'item-1' },
    proposedRevisions: {
      L: [
        { M: { revisionId: { S: 'pricing' } } },
        { M: { revisionId: { S: 'timeline' } } },
        { M: { revisionId: { S: 'market' } } },
      ],
    },
  },
}

describe('urgd-pulse-savePCDecisions', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  describe('valid decisions', () => {
    it('accepts valid themeIds and returns decisionsCount', async () => {
      sendSpy
        .mockResolvedValueOnce(PULSE_CHECK_WITH_THEMES) // GetItem
        .mockResolvedValueOnce({}) // UpdateItem (ensure map)
        .mockResolvedValueOnce({}) // UpdateItem (write decisions)

      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Accept' },
        timeline: { action: 'Revise' },
      }))

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.decisionsCount).toBe(2)
    })

    it('accepts all three valid action values: Accept, Revise, Override', async () => {
      sendSpy
        .mockResolvedValueOnce(PULSE_CHECK_WITH_THEMES)
        .mockResolvedValueOnce({}) // ensure map
        .mockResolvedValueOnce({}) // write decisions

      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Accept' },
        timeline: { action: 'Revise' },
        market: { action: 'Override' },
      }))

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.decisionsCount).toBe(3)
    })

    it('partial save: only submitted themeIds are updated', async () => {
      sendSpy
        .mockResolvedValueOnce(PULSE_CHECK_WITH_THEMES)
        .mockResolvedValueOnce({}) // ensure map
        .mockResolvedValueOnce({}) // write decisions

      // Only submit 1 of 3 themes
      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Accept' },
      }))

      expect(result.statusCode).toBe(200)
      const body = JSON.parse(result.body)
      expect(body.data.decisionsCount).toBe(1)

      // Verify the second UpdateItem was called with only the submitted themeId
      // The second UpdateItem is the nested write (index 2 in sendSpy calls)
      const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      // updateCalls[0] = ensure map, updateCalls[1] = write decisions
      const writeCall = updateCalls[1]
      const exprNames = writeCall[0].input.ExpressionAttributeNames
      const themeValues = Object.values(exprNames).filter(v => v !== 'decisions')
      expect(themeValues).toContain('pricing')
      expect(themeValues).not.toContain('timeline')
      expect(themeValues).not.toContain('market')
    })

    it('stores tenantNote when provided', async () => {
      sendSpy
        .mockResolvedValueOnce(PULSE_CHECK_WITH_THEMES)
        .mockResolvedValueOnce({}) // ensure map
        .mockResolvedValueOnce({}) // write decisions

      await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Revise', tenantNote: 'Will adjust pricing in Q2' },
      }))

      // The second UpdateItem is the nested write
      const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      const writeCall = updateCalls[1]
      const exprValues = writeCall[0].input.ExpressionAttributeValues
      const decisionValue = Object.values(exprValues).find(v => v.M?.action)
      expect(decisionValue.M.tenantNote.S).toBe('Will adjust pricing in Q2')
    })
  })

  describe('invalid themeId returns 400', () => {
    it('returns 400 for themeId not in pulse check', async () => {
      sendSpy.mockResolvedValueOnce(PULSE_CHECK_WITH_THEMES)

      const result = await handler(makeEvent('tenant-1', 'item-1', {
        'nonexistent-theme': { action: 'Accept' },
      }))

      expect(result.statusCode).toBe(400)
      const body = JSON.parse(result.body)
      expect(body.message).toContain('nonexistent-theme')
    })

    it('returns 400 for invalid action value', async () => {
      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'InvalidAction' },
      }))

      expect(result.statusCode).toBe(400)
    })
    it('returns 400 for empty decisions object', async () => {
      const result = await handler(makeEvent('tenant-1', 'item-1', {}))
      expect(result.statusCode).toBe(400)
    })
  })

  describe('error cases', () => {
    it('returns 401 when tenantId is missing', async () => {
      const result = await handler({
        headers: {},
        requestContext: { authorizer: {} },
        pathParameters: { itemId: 'item-1' },
        body: JSON.stringify({ decisions: { pricing: { action: 'Accept' } } }),
      })
      expect(result.statusCode).toBe(401)
    })

    it('returns 404 when pulse check not found', async () => {
      sendSpy.mockResolvedValueOnce({ Item: null })

      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Accept' },
      }))

      expect(result.statusCode).toBe(404)
    })

    it('returns 400 for invalid request body', async () => {
      const result = await handler({
        headers: { origin: 'https://pulse.urgdstudios.com' },
        requestContext: { authorizer: { tenantId: 'tenant-1' } },
        pathParameters: { itemId: 'item-1' },
        body: 'not json',
      })
      expect(result.statusCode).toBe(400)
    })

    it('returns 500 on DynamoDB error', async () => {
      sendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))

      const result = await handler(makeEvent('tenant-1', 'item-1', {
        pricing: { action: 'Accept' },
      }))

      expect(result.statusCode).toBe(500)
    })
  })
})
