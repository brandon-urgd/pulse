// Feature: pulse, Property 23: Decisions Persistence Property
// For any set of M valid decisions submitted to savePCDecisions, the stored decisions count equals M.
// For any subset of themes (partial save), only the submitted decisions are updated —
// unsubmitted decisions are unchanged.
// Validates: Requirements 7.7

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

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

function makePulseCheckWithThemes(themeIds) {
  return {
    Item: {
      tenantId: { S: 'tenant-1' },
      itemId: { S: 'item-1' },
      proposedRevisions: {
        L: themeIds.map(id => ({
          M: {
            revisionId: { S: id },
          },
        })),
      },
    },
  }
}

const VALID_ACTIONS = ['Accept', 'Revise', 'Override']

describe('Property 23: Decisions Persistence Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  it('for any M valid decisions, the stored decisionsCount equals M', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.array(
          fc.record({
            themeId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
            action: fc.constantFrom(...VALID_ACTIONS),
          }),
          { minLength: 1, maxLength: 10 }
        ),
        async (tenantId, itemId, decisionList) => {
          // Deduplicate themeIds
          const seen = new Set()
          const uniqueDecisions = decisionList.filter(d => {
            if (seen.has(d.themeId)) return false
            seen.add(d.themeId)
            return true
          })

          if (uniqueDecisions.length === 0) return

          const themeIds = uniqueDecisions.map(d => d.themeId)
          const decisions = Object.fromEntries(
            uniqueDecisions.map(d => [d.themeId, { action: d.action }])
          )

          sendSpy.mockReset()
          sendSpy
            .mockResolvedValueOnce(makePulseCheckWithThemes(themeIds)) // GetItem
            .mockResolvedValueOnce({}) // UpdateItem (ensure map)
            .mockResolvedValueOnce({}) // UpdateItem (write decisions)

          const result = await handler(makeEvent(tenantId, itemId, decisions))
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          expect(body.data.decisionsCount).toBe(uniqueDecisions.length)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('partial save: only submitted themeIds appear in the UpdateExpression', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.integer({ min: 3, max: 8 }),
        fc.integer({ min: 1, max: 2 }),
        async (tenantId, itemId, totalThemes, submitCount) => {
          const allThemeIds = Array.from({ length: totalThemes }, (_, i) => `theme-${i}`)
          const submittedThemeIds = allThemeIds.slice(0, submitCount)
          const unsubmittedThemeIds = allThemeIds.slice(submitCount)

          const decisions = Object.fromEntries(
            submittedThemeIds.map(id => [id, { action: 'Accept' }])
          )

          sendSpy.mockReset()
          sendSpy
            .mockResolvedValueOnce(makePulseCheckWithThemes(allThemeIds)) // GetItem
            .mockResolvedValueOnce({}) // UpdateItem (ensure map)
            .mockResolvedValueOnce({}) // UpdateItem (write decisions)

          const result = await handler(makeEvent(tenantId, itemId, decisions))
          expect(result.statusCode).toBe(200)

          // Verify UpdateItem was called — the second UpdateItem is the nested write
          const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
          // updateCalls[0] = ensure map, updateCalls[1] = write decisions
          expect(updateCalls.length).toBeGreaterThanOrEqual(2)
          const writeCall = updateCalls[1]

          const updateExpr = writeCall[0].input.UpdateExpression
          const exprNames = writeCall[0].input.ExpressionAttributeNames

          // Submitted themeIds should appear in expression names
          for (const themeId of submittedThemeIds) {
            const nameEntry = Object.entries(exprNames).find(([, v]) => v === themeId)
            expect(nameEntry).toBeDefined()
          }

          // Unsubmitted themeIds should NOT appear in expression names
          for (const themeId of unsubmittedThemeIds) {
            const nameEntry = Object.entries(exprNames).find(([, v]) => v === themeId)
            expect(nameEntry).toBeUndefined()
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('invalid themeId returns 400 and no DynamoDB write occurs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/.test(s)),
        fc.constantFrom(...VALID_ACTIONS),
        async (tenantId, itemId, invalidThemeId, action) => {
          sendSpy.mockReset()
          // Pulse check has no themes matching the submitted themeId
          sendSpy.mockResolvedValueOnce(makePulseCheckWithThemes(['other-theme-1', 'other-theme-2']))

          const decisions = { [invalidThemeId]: { action } }
          const result = await handler(makeEvent(tenantId, itemId, decisions))

          expect(result.statusCode).toBe(400)

          // No UpdateItem should be called
          const updateCalls = sendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
          expect(updateCalls).toHaveLength(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
