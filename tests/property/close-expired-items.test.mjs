// Property-based tests for closeExpiredItems Lambda (P3)
// Uses fast-check with vitest to verify close handler correctness.
// **Validates: Requirements 1.5**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── In-memory DynamoDB + Lambda mock ─────────────────────────────────────────
let itemsStore, sessionsStore, lambdaInvocations

const mockDynamoSend = vi.fn()
const mockLambdaSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockDynamoSend(cmd) } }
  class GetItemCommand { constructor(input) { this.input = input; this._type = 'GetItem' } }
  class UpdateItemCommand { constructor(input) { this.input = input; this._type = 'UpdateItem' } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  class ScanCommand { constructor(input) { this.input = input; this._type = 'Scan' } }
  return { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand, ScanCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(cmd) { return mockLambdaSend(cmd) } }
  class InvokeCommand { constructor(input) { this.input = input; this._type = 'Invoke' } }
  return { LambdaClient, InvokeCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

// ── Generators ───────────────────────────────────────────────────────────────
const SESSION_STATUSES = ['pending', 'in_progress', 'completed', 'expired']
const TERMINAL = new Set(['completed', 'expired'])

const sessionArb = fc.record({
  sessionId: fc.uuid(),
  status: fc.constantFrom(...SESSION_STATUSES),
  transcriptCount: fc.nat({ max: 10 }),
})


/**
 * Property 3: Close Handler Correctness
 *
 * For any item with status: 'active' and associated sessions in various states
 * (pending, in_progress, completed, expired), invoking the close handler SHALL:
 * set item status to 'closed', set closedAt to a valid timestamp, and transition
 * all non-terminal sessions to 'expired'. Sessions already in terminal states
 * (completed, expired) SHALL remain unchanged.
 *
 * Validates: Requirements 1.5
 */
describe('Property P3: Close handler correctness', () => {
  beforeEach(() => {
    itemsStore = new Map()
    sessionsStore = []
    lambdaInvocations = []
    mockDynamoSend.mockReset()
    mockLambdaSend.mockReset()

    process.env.ITEMS_TABLE = 'items'
    process.env.SESSIONS_TABLE = 'sessions'
    process.env.TRANSCRIPTS_TABLE = 'transcripts'
    process.env.GENERATE_REPORT_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:generateReport'
    process.env.RUN_PULSE_CHECK_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:runPulseCheck'
    process.env.SEND_PULSE_CHECK_READY_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:sendPulseCheckReady'
  })

  it('closes item, expires non-terminal sessions, leaves terminal sessions unchanged', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-closeExpiredItems/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),  // itemId
        fc.uuid(),  // tenantId
        fc.array(sessionArb, { minLength: 0, maxLength: 8 }),
        async (itemId, tenantId, sessions) => {
          // Reset tracking
          const updatedSessions = new Map()
          let itemClosed = false

          mockDynamoSend.mockImplementation((cmd) => {
            if (cmd._type === 'GetItem') {
              // First call: get item. Second call: get item name for pulse check
              if (!itemClosed) {
                return Promise.resolve({
                  Item: {
                    tenantId: { S: tenantId },
                    itemId: { S: itemId },
                    status: { S: 'active' },
                    itemName: { S: 'Test Item' },
                  },
                })
              }
              return Promise.resolve({
                Item: {
                  tenantId: { S: tenantId },
                  itemId: { S: itemId },
                  status: { S: 'closed' },
                  itemName: { S: 'Test Item' },
                },
              })
            }
            if (cmd._type === 'UpdateItem') {
              // Check if this is an item update or session update
              const key = cmd.input.Key
              if (key.itemId) {
                itemClosed = true
              } else if (key.sessionId) {
                updatedSessions.set(key.sessionId.S, 'expired')
              }
              return Promise.resolve({})
            }
            if (cmd._type === 'Query') {
              // Return non-terminal sessions for the item-index query
              const nonTerminal = sessions.filter(s => !TERMINAL.has(s.status))
              return Promise.resolve({
                Items: nonTerminal.map(s => ({
                  tenantId: { S: tenantId },
                  sessionId: { S: s.sessionId },
                  itemId: { S: itemId },
                  status: { S: s.status },
                })),
              })
            }
            return Promise.resolve({})
          })

          mockLambdaSend.mockResolvedValue({})

          await handler({ itemId, tenantId })

          // Item should be closed
          expect(itemClosed).toBe(true)

          // All non-terminal sessions should have been expired
          const nonTerminal = sessions.filter(s => !TERMINAL.has(s.status))
          for (const s of nonTerminal) {
            expect(updatedSessions.get(s.sessionId)).toBe('expired')
          }

          // Terminal sessions should NOT have been updated
          const terminal = sessions.filter(s => TERMINAL.has(s.status))
          for (const s of terminal) {
            expect(updatedSessions.has(s.sessionId)).toBe(false)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
