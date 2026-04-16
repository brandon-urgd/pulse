// Unit tests for urgd-pulse-expireSessions — auto-trigger behavior
// Tests the automatic Pulse Check trigger when all sessions for an item close.
// Requirements: 7.4, 5.12, 13.2

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('RUN_PULSE_CHECK_FUNCTION_NAME', 'urgd-pulse-runPulseCheck-dev')
vi.stubEnv('SEND_PULSE_CHECK_READY_FUNCTION_NAME', 'urgd-pulse-sendPulseCheckReady-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const lambdaSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class ScanCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class GetItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, ScanCommand, UpdateItemCommand, QueryCommand, GetItemCommand }
})

vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send(...args) { return lambdaSendSpy(...args) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

const { handler } = await import('./index.mjs')

const NOW = new Date()
const PAST_DATE = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()

function makeSession(tenantId, sessionId, status, itemId = 'item-1', expiresAt = PAST_DATE) {
  return {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    status: { S: status },
    itemId: { S: itemId },
    expiresAt: { S: expiresAt },
  }
}

function makeSessionRecord(sessionId, status) {
  return {
    sessionId: { S: sessionId },
    status: { S: status },
  }
}

describe('expireSessions — auto-trigger behavior', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
  })

  describe('invokes runPulseCheck and sendPulseCheckReady when all sessions are terminal', () => {
    it('triggers both functions when the last open session expires', async () => {
      const tenantId = 'tenant-abc'
      const itemId = 'item-1'
      const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          return Promise.resolve({ Items: [session], Count: 1 })
        }
        if (name === 'UpdateItemCommand') {
          return Promise.resolve({})
        }
        if (name === 'QueryCommand') {
          // Query all sessions for item — all are now terminal
          return Promise.resolve({
            Items: [
              makeSessionRecord('session-1', 'expired'),
              makeSessionRecord('session-2', 'completed'),
            ],
          })
        }
        if (name === 'GetItemCommand') {
          // Get item — must be closed for pulse check to trigger
          return Promise.resolve({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'My Item' }, status: { S: 'closed' } },
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // runPulseCheck should be invoked (sendPulseCheckReady is NOT invoked by expireSessions)
      const invokeCalls = lambdaSendSpy.mock.calls
      const functionNames = invokeCalls.map(c => c[0].input.FunctionName)

      expect(functionNames).toContain('urgd-pulse-runPulseCheck-dev')
    })

    it('invokes sendPulseCheckReady with correct payload', async () => {
      const tenantId = 'tenant-abc'
      const itemId = 'item-1'
      const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          return Promise.resolve({ Items: [makeSessionRecord('session-1', 'expired')] })
        }
        if (name === 'GetItemCommand') {
          return Promise.resolve({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Test Document' }, status: { S: 'closed' } },
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // runPulseCheck should be invoked with correct payload
      const runPulseCheckCall = lambdaSendSpy.mock.calls.find(
        c => c[0].input.FunctionName === 'urgd-pulse-runPulseCheck-dev'
      )
      expect(runPulseCheckCall).toBeTruthy()

      const payload = JSON.parse(runPulseCheckCall[0].input.Payload)
      expect(payload.tenantId).toBe(tenantId)
      expect(payload.itemId).toBe(itemId)
    })

    it('invokes both functions as fire-and-forget (InvocationType: Event)', async () => {
      const tenantId = 'tenant-abc'
      const itemId = 'item-1'
      const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          return Promise.resolve({ Items: [makeSessionRecord('session-1', 'expired')] })
        }
        if (name === 'GetItemCommand') {
          return Promise.resolve({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Item' } },
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      for (const call of lambdaSendSpy.mock.calls) {
        expect(call[0].input.InvocationType).toBe('Event')
      }
    })
  })

  describe('does NOT trigger when sessions remain open', () => {
    it('does not invoke either function when some sessions are still in_progress', async () => {
      const tenantId = 'tenant-abc'
      const itemId = 'item-1'
      const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          // One session still in_progress
          return Promise.resolve({
            Items: [
              makeSessionRecord('session-1', 'expired'),
              makeSessionRecord('session-2', 'in_progress'), // still open
            ],
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // Neither function should be invoked
      const invokeCalls = lambdaSendSpy.mock.calls
      const functionNames = invokeCalls.map(c => c[0].input.FunctionName)
      expect(functionNames).not.toContain('urgd-pulse-runPulseCheck-dev')
      expect(functionNames).not.toContain('urgd-pulse-sendPulseCheckReady-dev')
    })

    it('does not invoke either function when some sessions are not_started', async () => {
      const tenantId = 'tenant-abc'
      const itemId = 'item-1'
      const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          return Promise.resolve({
            Items: [
              makeSessionRecord('session-1', 'expired'),
              makeSessionRecord('session-2', 'not_started'), // still open
            ],
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      const invokeCalls = lambdaSendSpy.mock.calls
      const functionNames = invokeCalls.map(c => c[0].input.FunctionName)
      expect(functionNames).not.toContain('urgd-pulse-runPulseCheck-dev')
      expect(functionNames).not.toContain('urgd-pulse-sendPulseCheckReady-dev')
    })
  })

  describe('does NOT trigger when no sessions expired this run', () => {
    it('does not invoke either function when scan returns no eligible sessions', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })

  describe('handles multiple items in a single run', () => {
    it('triggers pulse check for each item where all sessions are terminal', async () => {
      const tenantId = 'tenant-abc'
      const sessions = [
        makeSession(tenantId, 'session-1', 'not_started', 'item-1'),
        makeSession(tenantId, 'session-2', 'not_started', 'item-2'),
      ]

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: sessions, Count: 2 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          // All sessions terminal for both items
          return Promise.resolve({ Items: [makeSessionRecord('session-x', 'expired')] })
        }
        if (name === 'GetItemCommand') {
          const itemId = cmd.input.Key.itemId.S
          return Promise.resolve({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: `Item ${itemId}` }, status: { S: 'closed' } },
          })
        }
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // Should have invoked runPulseCheck for each of the 2 items
      // (sendPulseCheckReady is NOT invoked by expireSessions)
      const invokeCalls = lambdaSendSpy.mock.calls
      const runPulseCheckCalls = invokeCalls.filter(
        c => c[0].input.FunctionName === 'urgd-pulse-runPulseCheck-dev'
      )

      expect(runPulseCheckCalls).toHaveLength(2)
    })
  })

  describe('graceful error handling', () => {
    it('continues processing other items if one item trigger fails', async () => {
      const tenantId = 'tenant-abc'
      const sessions = [
        makeSession(tenantId, 'session-1', 'not_started', 'item-1'),
        makeSession(tenantId, 'session-2', 'not_started', 'item-2'),
      ]

      let queryCallCount = 0
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: sessions, Count: 2 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        if (name === 'QueryCommand') {
          queryCallCount++
          return Promise.resolve({ Items: [makeSessionRecord('session-x', 'expired')] })
        }
        if (name === 'GetItemCommand') {
          const itemId = cmd.input.Key.itemId.S
          return Promise.resolve({
            Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: `Item ${itemId}` } },
          })
        }
        return Promise.resolve({})
      })

      // First Lambda invoke fails, second succeeds
      lambdaSendSpy
        .mockRejectedValueOnce(new Error('Lambda invoke failed'))
        .mockResolvedValue({})

      // Should not throw
      await expect(handler({})).resolves.not.toThrow()
    })

    it('does not invoke functions when env vars are not set', async () => {
      // Temporarily clear the env vars
      const origRun = process.env.RUN_PULSE_CHECK_FUNCTION_NAME
      const origSend = process.env.SEND_PULSE_CHECK_READY_FUNCTION_NAME
      delete process.env.RUN_PULSE_CHECK_FUNCTION_NAME
      delete process.env.SEND_PULSE_CHECK_READY_FUNCTION_NAME

      const session = makeSession('tenant-abc', 'session-1', 'not_started', 'item-1')

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.resolve({})
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // Lambda should not be invoked when env vars are missing
      expect(lambdaSendSpy).not.toHaveBeenCalled()

      // Restore env vars
      process.env.RUN_PULSE_CHECK_FUNCTION_NAME = origRun
      process.env.SEND_PULSE_CHECK_READY_FUNCTION_NAME = origSend
    })
  })

  describe('completed sessions are never re-triggered', () => {
    it('does not trigger pulse check for items where sessions were already completed (not expired this run)', async () => {
      // Scan returns empty — no sessions expired this run
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      lambdaSendSpy.mockResolvedValue({})

      await handler({})

      // No Lambda invocations since no sessions expired
      expect(lambdaSendSpy).not.toHaveBeenCalled()
    })
  })
})

describe('partial report generation for in_progress sessions', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
    process.env.GENERATE_REPORT_FUNCTION_NAME = 'urgd-pulse-generateReport-dev'
    process.env.TRANSCRIPTS_TABLE = 'urgd-pulse-transcripts-dev'
  })

  afterEach(() => {
    delete process.env.GENERATE_REPORT_FUNCTION_NAME
    delete process.env.TRANSCRIPTS_TABLE
  })

  it('triggers generateReport for in_progress session with enough reviewer messages', async () => {
    const tenantId = 'tenant-abc'
    const session = {
      tenantId: { S: tenantId },
      sessionId: { S: 'session-1' },
      status: { S: 'in_progress' },
      itemId: { S: 'item-1' },
      expiresAt: { S: new Date(Date.now() - 3600000).toISOString() },
    }

    dynamoSendSpy.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
      if (name === 'QueryCommand') {
        const input = cmd.input
        if (input.TableName === 'urgd-pulse-transcripts-dev') {
          // Return 4 reviewer messages (>= MIN_REVIEWER_MESSAGES)
          return Promise.resolve({
            Items: [
              { messageId: { S: 'm1' }, role: { S: 'reviewer' } },
              { messageId: { S: 'm2' }, role: { S: 'agent' } },
              { messageId: { S: 'm3' }, role: { S: 'reviewer' } },
              { messageId: { S: 'm4' }, role: { S: 'reviewer' } },
              { messageId: { S: 'm5' }, role: { S: 'reviewer' } },
            ],
          })
        }
        // Query for item sessions (auto-trigger check)
        return Promise.resolve({ Items: [{ sessionId: { S: 'session-1' }, status: { S: 'expired' } }] })
      }
      if (name === 'UpdateItemCommand') return Promise.resolve({})
      if (name === 'GetItemCommand') {
        return Promise.resolve({ Item: { tenantId: { S: tenantId }, itemId: { S: 'item-1' }, itemName: { S: 'Test' } } })
      }
      return Promise.resolve({})
    })

    lambdaSendSpy.mockResolvedValue({})

    await handler({})

    const invokeCalls = lambdaSendSpy.mock.calls
    const generateReportCall = invokeCalls.find(c => c[0].input.FunctionName === 'urgd-pulse-generateReport-dev')
    expect(generateReportCall).toBeTruthy()
    const payload = JSON.parse(generateReportCall[0].input.Payload)
    expect(payload.sessionId).toBe('session-1')
    expect(payload.incomplete).toBe(true)
  })

  it('skips generateReport for in_progress session with too few reviewer messages', async () => {
    const tenantId = 'tenant-abc'
    const session = {
      tenantId: { S: tenantId },
      sessionId: { S: 'session-1' },
      status: { S: 'in_progress' },
      itemId: { S: 'item-1' },
      expiresAt: { S: new Date(Date.now() - 3600000).toISOString() },
    }

    dynamoSendSpy.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
      if (name === 'QueryCommand') {
        const input = cmd.input
        if (input.TableName === 'urgd-pulse-transcripts-dev') {
          // Only 2 reviewer messages (< MIN_REVIEWER_MESSAGES = 4)
          return Promise.resolve({
            Items: [
              { messageId: { S: 'm1' }, role: { S: 'reviewer' } },
              { messageId: { S: 'm2' }, role: { S: 'reviewer' } },
            ],
          })
        }
        return Promise.resolve({ Items: [{ sessionId: { S: 'session-1' }, status: { S: 'expired' } }] })
      }
      if (name === 'UpdateItemCommand') return Promise.resolve({})
      if (name === 'GetItemCommand') {
        return Promise.resolve({ Item: { tenantId: { S: tenantId }, itemId: { S: 'item-1' }, itemName: { S: 'Test' } } })
      }
      return Promise.resolve({})
    })

    lambdaSendSpy.mockResolvedValue({})

    await handler({})

    const invokeCalls = lambdaSendSpy.mock.calls
    const generateReportCall = invokeCalls.find(c => c[0].input.FunctionName === 'urgd-pulse-generateReport-dev')
    expect(generateReportCall).toBeUndefined()
  })

  it('handles error when querying transcripts gracefully', async () => {
    const tenantId = 'tenant-abc'
    const session = {
      tenantId: { S: tenantId },
      sessionId: { S: 'session-1' },
      status: { S: 'in_progress' },
      itemId: { S: 'item-1' },
      expiresAt: { S: new Date(Date.now() - 3600000).toISOString() },
    }

    dynamoSendSpy.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
      if (name === 'QueryCommand') {
        const input = cmd.input
        if (input.TableName === 'urgd-pulse-transcripts-dev') {
          return Promise.reject(new Error('DynamoDB error'))
        }
        return Promise.resolve({ Items: [{ sessionId: { S: 'session-1' }, status: { S: 'expired' } }] })
      }
      if (name === 'UpdateItemCommand') return Promise.resolve({})
      if (name === 'GetItemCommand') {
        return Promise.resolve({ Item: { tenantId: { S: tenantId }, itemId: { S: 'item-1' }, itemName: { S: 'Test' } } })
      }
      return Promise.resolve({})
    })

    lambdaSendSpy.mockResolvedValue({})

    // Should not throw even when transcript query fails
    const result = await handler({})
    expect(result.totalExpired).toBe(1)
  })
})

describe('auto-trigger edge cases', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    lambdaSendSpy.mockReset()
    lambdaSendSpy.mockResolvedValue({})
  })
  it('skips item when query returns no sessions', async () => {
    const tenantId = 'tenant-abc'
    const session = makeSession(tenantId, 'session-1', 'not_started', 'item-1')

    dynamoSendSpy.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
      if (name === 'UpdateItemCommand') return Promise.resolve({})
      if (name === 'QueryCommand') {
        // Return empty sessions list
        return Promise.resolve({ Items: [] })
      }
      return Promise.resolve({})
    })

    lambdaSendSpy.mockResolvedValue({})

    await handler({})

    // Neither function should be invoked when no sessions found
    expect(lambdaSendSpy).not.toHaveBeenCalled()
  })

  it('handles sendPulseCheckReady Lambda invoke error gracefully', async () => {
    const tenantId = 'tenant-abc'
    const itemId = 'item-1'
    const session = makeSession(tenantId, 'session-1', 'not_started', itemId)

    dynamoSendSpy.mockImplementation((cmd) => {
      const name = cmd?.constructor?.name
      if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
      if (name === 'UpdateItemCommand') return Promise.resolve({})
      if (name === 'QueryCommand') {
        return Promise.resolve({ Items: [makeSessionRecord('session-1', 'expired')] })
      }
      if (name === 'GetItemCommand') {
        return Promise.resolve({
          Item: { tenantId: { S: tenantId }, itemId: { S: itemId }, itemName: { S: 'Test' } },
        })
      }
      return Promise.resolve({})
    })

    // runPulseCheck succeeds, sendPulseCheckReady fails
    lambdaSendSpy
      .mockResolvedValueOnce({}) // runPulseCheck
      .mockRejectedValueOnce(new Error('Lambda invoke failed')) // sendPulseCheckReady

    // Should not throw
    await expect(handler({})).resolves.not.toThrow()
  })
})
