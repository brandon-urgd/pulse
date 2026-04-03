// Unit tests for purgeTranscripts Lambda
// Tests: no eligible records, session with no transcripts, partial BatchWriteItem failure
// **Validates: Requirements 2.2, 2.3, 2.4, 2.5**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(cmd) { return mockSend(cmd) } }
  class ScanCommand { constructor(input) { this.input = input; this._type = 'Scan' } }
  class QueryCommand { constructor(input) { this.input = input; this._type = 'Query' } }
  class BatchWriteItemCommand { constructor(input) { this.input = input; this._type = 'BatchWrite' } }
  return { DynamoDBClient, ScanCommand, QueryCommand, BatchWriteItemCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

beforeEach(() => {
  mockSend.mockReset()
  process.env.PULSE_CHECKS_TABLE = 'pulseChecks'
  process.env.SESSIONS_TABLE = 'sessions'
  process.env.TRANSCRIPTS_TABLE = 'transcripts'
})

describe('purgeTranscripts unit tests', () => {
  it('handles no eligible records gracefully', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-purgeTranscripts/index.mjs')

    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'Scan') return Promise.resolve({ Items: [] })
      return Promise.resolve({})
    })

    const result = await handler({ source: 'test' })
    expect(result.totalPulseChecksScanned).toBe(0)
    expect(result.totalTranscriptsDeleted).toBe(0)
  })

  it('handles session with no transcripts', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-purgeTranscripts/index.mjs')

    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'Scan') {
        return Promise.resolve({
          Items: [{ tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } }],
        })
      }
      if (cmd._type === 'Query') {
        if (cmd.input.TableName === process.env.SESSIONS_TABLE) {
          return Promise.resolve({
            Items: [{ sessionId: { S: 'sess-1' } }],
          })
        }
        // No transcripts for this session
        return Promise.resolve({ Items: [] })
      }
      return Promise.resolve({})
    })

    const result = await handler({ source: 'test' })
    expect(result.totalPulseChecksScanned).toBe(1)
    expect(result.totalTranscriptsDeleted).toBe(0)
  })

  it('handles partial BatchWriteItem failure with retries', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-purgeTranscripts/index.mjs')

    let batchCallCount = 0
    mockSend.mockImplementation((cmd) => {
      if (cmd._type === 'Scan') {
        return Promise.resolve({
          Items: [{ tenantId: { S: 'tenant-1' }, itemId: { S: 'item-1' } }],
        })
      }
      if (cmd._type === 'Query') {
        if (cmd.input.TableName === process.env.SESSIONS_TABLE) {
          return Promise.resolve({
            Items: [{ sessionId: { S: 'sess-1' } }],
          })
        }
        // Return 2 transcript records
        return Promise.resolve({
          Items: [
            { sessionId: { S: 'sess-1' }, messageId: { S: 'msg-1' } },
            { sessionId: { S: 'sess-1' }, messageId: { S: 'msg-2' } },
          ],
        })
      }
      if (cmd._type === 'BatchWrite') {
        batchCallCount++
        if (batchCallCount === 1) {
          // First call: return one unprocessed item
          return Promise.resolve({
            UnprocessedItems: {
              [process.env.TRANSCRIPTS_TABLE]: [
                { DeleteRequest: { Key: { sessionId: { S: 'sess-1' }, messageId: { S: 'msg-2' } } } },
              ],
            },
          })
        }
        // Retry succeeds
        return Promise.resolve({ UnprocessedItems: {} })
      }
      return Promise.resolve({})
    })

    const result = await handler({ source: 'test' })
    // Should have retried and eventually deleted both
    expect(result.totalTranscriptsDeleted).toBe(2)
    expect(batchCallCount).toBeGreaterThan(1)
  })
})
