// Unit tests for closeExpiredItems Lambda
// Tests: item not found, already closed, mixed session states, downstream Lambda invocation
// **Validates: Requirements 1.5, 1.7**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
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

beforeEach(() => {
  mockDynamoSend.mockReset()
  mockLambdaSend.mockReset()
  process.env.ITEMS_TABLE = 'items'
  process.env.SESSIONS_TABLE = 'sessions'
  process.env.TRANSCRIPTS_TABLE = 'transcripts'
  process.env.GENERATE_REPORT_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:generateReport'
  process.env.RUN_PULSE_CHECK_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:runPulseCheck'
  process.env.SEND_PULSE_CHECK_READY_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:sendPulseCheckReady'
})

describe('closeExpiredItems unit tests', () => {
  it('handles item not found gracefully', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-closeExpiredItems/index.mjs')

    mockDynamoSend.mockResolvedValue({ Item: null })

    const result = await handler({ itemId: 'missing-item', tenantId: 'tenant-1' })
    expect(result).toEqual({ mode: 'targeted', itemId: 'missing-item' })
    // Should not throw, should not call UpdateItem
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('handles already closed item gracefully', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-closeExpiredItems/index.mjs')

    mockDynamoSend.mockResolvedValue({
      Item: {
        tenantId: { S: 'tenant-1' },
        itemId: { S: 'item-1' },
        status: { S: 'closed' },
      },
    })

    const result = await handler({ itemId: 'item-1', tenantId: 'tenant-1' })
    expect(result).toEqual({ mode: 'targeted', itemId: 'item-1' })
    // Only GetItem, no UpdateItem
    expect(mockDynamoSend).toHaveBeenCalledTimes(1)
  })

  it('closes item and expires mixed session states correctly', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-closeExpiredItems/index.mjs')

    let callCount = 0
    const updatedSessionIds = []

    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetItem') {
        callCount++
        // First GetItem: item lookup, subsequent: item name for pulse check
        return Promise.resolve({
          Item: {
            tenantId: { S: 'tenant-1' },
            itemId: { S: 'item-1' },
            status: { S: callCount === 1 ? 'active' : 'closed' },
            itemName: { S: 'My Item' },
          },
        })
      }
      if (cmd._type === 'UpdateItem') {
        if (cmd.input.Key.sessionId) {
          updatedSessionIds.push(cmd.input.Key.sessionId.S)
        }
        return Promise.resolve({})
      }
      if (cmd._type === 'Query') {
        if (cmd.input.TableName === process.env.SESSIONS_TABLE) {
          return Promise.resolve({
            Items: [
              { tenantId: { S: 'tenant-1' }, sessionId: { S: 'sess-pending' }, itemId: { S: 'item-1' }, status: { S: 'pending' } },
              { tenantId: { S: 'tenant-1' }, sessionId: { S: 'sess-inprog' }, itemId: { S: 'item-1' }, status: { S: 'in_progress' } },
            ],
          })
        }
        // Transcript count query
        return Promise.resolve({ Count: 5 })
      }
      return Promise.resolve({})
    })

    mockLambdaSend.mockResolvedValue({})

    await handler({ itemId: 'item-1', tenantId: 'tenant-1' })

    // Both non-terminal sessions should be expired
    expect(updatedSessionIds).toContain('sess-pending')
    expect(updatedSessionIds).toContain('sess-inprog')
  })

  it('invokes generateReport for in-progress sessions with sufficient transcript', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-closeExpiredItems/index.mjs')

    let getItemCalls = 0
    mockDynamoSend.mockImplementation((cmd) => {
      if (cmd._type === 'GetItem') {
        getItemCalls++
        return Promise.resolve({
          Item: {
            tenantId: { S: 'tenant-1' },
            itemId: { S: 'item-1' },
            status: { S: getItemCalls === 1 ? 'active' : 'closed' },
            itemName: { S: 'My Item' },
          },
        })
      }
      if (cmd._type === 'UpdateItem') return Promise.resolve({})
      if (cmd._type === 'Query') {
        if (cmd.input.TableName === process.env.SESSIONS_TABLE) {
          // Check if this is the completed sessions count query (uses Select: COUNT and filters for completed)
          if (cmd.input.Select === 'COUNT') {
            return Promise.resolve({ Count: 0 })
          }
          return Promise.resolve({
            Items: [
              { tenantId: { S: 'tenant-1' }, sessionId: { S: 'sess-inprog' }, itemId: { S: 'item-1' }, status: { S: 'in_progress' } },
            ],
          })
        }
        // Transcript count = 5 (above MIN_TRANSCRIPT_COUNT of 3)
        return Promise.resolve({ Count: 5 })
      }
      return Promise.resolve({})
    })

    mockLambdaSend.mockResolvedValue({})

    await handler({ itemId: 'item-1', tenantId: 'tenant-1' })

    // Should invoke generateReport for the in-progress session with sufficient transcript
    const invokedFunctions = mockLambdaSend.mock.calls.map(c => c[0].input.FunctionName)
    expect(invokedFunctions).toContain(process.env.GENERATE_REPORT_FUNCTION_ARN)
    // runPulseCheck and sendPulseCheckReady are only invoked when there are completed sessions
    // Since this test only has in_progress sessions (no completed), they should NOT be invoked
  })
})
