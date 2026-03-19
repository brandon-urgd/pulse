// Unit tests for urgd-pulse-expireSessions
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class ScanCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, ScanCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

const NOW = new Date()
const PAST_DATE = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()   // 1h ago
const FUTURE_DATE = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() // 1h from now

function makeSession(tenantId, sessionId, status, expiresAt = PAST_DATE) {
  return {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    status: { S: status },
    expiresAt: { S: expiresAt },
  }
}

describe('urgd-pulse-expireSessions', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
  })

  describe('marks past-due sessions as expired', () => {
    it('expires a single not_started session with past expiresAt', async () => {
      const session = makeSession('tenant-abc', 'session-1', 'not_started')
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalExpired).toBe(1)
      expect(result.totalSkipped).toBe(0)
      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0].Key.tenantId.S).toBe('tenant-abc')
      expect(updateCalls[0].Key.sessionId.S).toBe('session-1')
      expect(updateCalls[0].ExpressionAttributeValues[':expired'].S).toBe('expired')
    })

    it('expires in_progress sessions with past expiresAt', async () => {
      const session = makeSession('tenant-abc', 'session-2', 'in_progress')
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalExpired).toBe(1)
      expect(updateCalls[0].ExpressionAttributeValues[':expired'].S).toBe('expired')
    })

    it('expires multiple eligible sessions', async () => {
      const sessions = [
        makeSession('tenant-a', 'session-1', 'not_started'),
        makeSession('tenant-b', 'session-2', 'in_progress'),
        makeSession('tenant-c', 'session-3', 'not_started'),
      ]
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: sessions, Count: sessions.length })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalExpired).toBe(3)
      expect(updateCalls).toHaveLength(3)
    })
  })

  describe('does not touch completed sessions', () => {
    it('never updates completed sessions (scan filter excludes them)', async () => {
      // Scan returns empty — completed sessions are excluded by the DynamoDB filter expression
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalExpired).toBe(0)
      expect(dynamoSendSpy).toHaveBeenCalledTimes(1) // only the scan
    })

    it('skips session if UpdateItem conditional check fails (session was completed between scan and update)', async () => {
      const session = makeSession('tenant-abc', 'session-1', 'not_started')

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') {
          const err = new Error('ConditionalCheckFailed')
          err.name = 'ConditionalCheckFailedException'
          return Promise.reject(err)
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalExpired).toBe(0)
      expect(result.totalSkipped).toBe(1)
    })
  })

  describe('conditional expression prevents completed session modification', () => {
    it('UpdateItem uses condition expression to guard against completing sessions', async () => {
      const session = makeSession('tenant-abc', 'session-1', 'not_started')
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      await handler({})

      expect(updateCalls).toHaveLength(1)
      // Verify the conditional expression is present
      expect(updateCalls[0].ConditionExpression).toContain('<>')
      expect(updateCalls[0].ExpressionAttributeValues[':completed'].S).toBe('completed')
    })
  })

  describe('empty scan result', () => {
    it('returns zero counts when no sessions are eligible', async () => {
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [], Count: 0 })
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(result.totalScanned).toBe(0)
      expect(result.totalExpired).toBe(0)
      expect(result.totalSkipped).toBe(0)
    })
  })

  describe('malformed session records', () => {
    it('skips session with missing tenantId', async () => {
      const badSession = { sessionId: { S: 'session-1' }, status: { S: 'not_started' }, expiresAt: { S: PAST_DATE } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [badSession], Count: 1 })
        return Promise.resolve({})
      })

      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(result.totalExpired).toBe(0)
    })

    it('skips session with missing sessionId', async () => {
      const badSession = { tenantId: { S: 'tenant-abc' }, status: { S: 'not_started' }, expiresAt: { S: PAST_DATE } }
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [badSession], Count: 1 })
        return Promise.resolve({})
      })

      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(result.totalExpired).toBe(0)
    })

    it('skips session with status "completed" (belt-and-suspenders guard)', async () => {
      // Simulate a session that somehow passed the scan filter but has status "completed"
      const completedSession = makeSession('tenant-abc', 'session-1', 'completed')
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [completedSession], Count: 1 })
        return Promise.resolve({})
      })

      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(result.totalExpired).toBe(0)
      // UpdateItem should never be called for completed sessions
      const updateCalls = dynamoSendSpy.mock.calls.filter(c => c[0]?.constructor?.name === 'UpdateItemCommand')
      expect(updateCalls).toHaveLength(0)
    })

    it('skips and logs error when UpdateItem throws a non-conditional error', async () => {
      const session = makeSession('tenant-abc', 'session-1', 'not_started')
      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') return Promise.resolve({ Items: [session], Count: 1 })
        if (name === 'UpdateItemCommand') return Promise.reject(new Error('ProvisionedThroughputExceededException'))
        return Promise.resolve({})
      })

      const result = await handler({})
      expect(result.totalSkipped).toBe(1)
      expect(result.totalExpired).toBe(0)
    })
  })

  describe('pagination', () => {
    it('handles paginated scan results (LastEvaluatedKey)', async () => {
      const page1Sessions = [makeSession('tenant-a', 'session-1', 'not_started')]
      const page2Sessions = [makeSession('tenant-b', 'session-2', 'in_progress')]
      let scanCallCount = 0
      const updateCalls = []

      dynamoSendSpy.mockImplementation((cmd) => {
        const name = cmd?.constructor?.name
        if (name === 'ScanCommand') {
          scanCallCount++
          if (scanCallCount === 1) {
            return Promise.resolve({
              Items: page1Sessions,
              Count: 1,
              LastEvaluatedKey: { tenantId: { S: 'tenant-a' }, sessionId: { S: 'session-1' } },
            })
          }
          return Promise.resolve({ Items: page2Sessions, Count: 1 })
        }
        if (name === 'UpdateItemCommand') {
          updateCalls.push(cmd.input)
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })

      const result = await handler({})

      expect(scanCallCount).toBe(2)
      expect(result.totalExpired).toBe(2)
      expect(updateCalls).toHaveLength(2)
    })
  })
})
