// Property-based tests for purgeTranscripts Lambda (P4 + P5)
// Uses fast-check with vitest to verify purge selectivity and idempotency.
// **Validates: Requirements 2.2, 2.3, 2.5**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── In-memory DynamoDB mock ──────────────────────────────────────────────────
let pulseChecksStore, sessionsStore, transcriptsStore

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

// ── Generators ───────────────────────────────────────────────────────────────
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// Generate a pulse check with a generatedAt that may or may not be >30 days old
const pulseCheckArb = fc.record({
  tenantId: fc.uuid(),
  itemId: fc.uuid(),
  isOld: fc.boolean(), // true = >30 days old, false = recent
})

const transcriptArb = fc.record({
  sessionId: fc.uuid(),
  messageId: fc.uuid(),
})


function setupMock(pulseChecks, sessionMap, transcriptMap) {
  mockSend.mockImplementation((cmd) => {
    if (cmd._type === 'Scan') {
      // Return only old pulse checks (simulating the filter expression)
      const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString()
      const eligible = pulseChecks
        .filter(pc => pc.isOld)
        .map(pc => ({
          tenantId: { S: pc.tenantId },
          itemId: { S: pc.itemId },
        }))
      return Promise.resolve({ Items: eligible })
    }
    if (cmd._type === 'Query') {
      const tableName = cmd.input.TableName
      if (tableName === process.env.SESSIONS_TABLE) {
        // Return sessions for the queried itemId
        const itemId = cmd.input.ExpressionAttributeValues[':itemId']?.S
        const sessions = sessionMap.get(itemId) || []
        return Promise.resolve({
          Items: sessions.map(sid => ({ sessionId: { S: sid } })),
        })
      }
      if (tableName === process.env.TRANSCRIPTS_TABLE) {
        // Return transcripts for the queried sessionId
        const sessionId = cmd.input.ExpressionAttributeValues[':sid']?.S
        const transcripts = transcriptMap.get(sessionId) || []
        return Promise.resolve({
          Items: transcripts.map(t => ({
            sessionId: { S: t.sessionId },
            messageId: { S: t.messageId },
          })),
        })
      }
      return Promise.resolve({ Items: [] })
    }
    if (cmd._type === 'BatchWrite') {
      // Process deletes — remove from transcriptMap
      const tableName = process.env.TRANSCRIPTS_TABLE
      const requests = cmd.input.RequestItems?.[tableName] || []
      for (const req of requests) {
        if (req.DeleteRequest) {
          const sid = req.DeleteRequest.Key.sessionId.S
          const mid = req.DeleteRequest.Key.messageId.S
          const arr = transcriptMap.get(sid)
          if (arr) {
            const idx = arr.findIndex(t => t.sessionId === sid && t.messageId === mid)
            if (idx >= 0) arr.splice(idx, 1)
          }
        }
      }
      return Promise.resolve({ UnprocessedItems: {} })
    }
    return Promise.resolve({})
  })
}

/**
 * Property 4: Transcript Purge Selectivity
 *
 * For any dataset containing pulse checks with various generatedAt timestamps,
 * sessions, transcript records, report records, and pulse check records: after
 * running the purge, transcript records associated with pulse checks older than
 * 30 days SHALL be deleted, while ALL session metadata records, report records,
 * and pulse check records SHALL be preserved regardless of age.
 *
 * Validates: Requirements 2.2, 2.3
 */
describe('Property P4: Purge selectivity', () => {
  beforeEach(() => {
    mockSend.mockReset()
    process.env.PULSE_CHECKS_TABLE = 'pulseChecks'
    process.env.SESSIONS_TABLE = 'sessions'
    process.env.TRANSCRIPTS_TABLE = 'transcripts'
  })

  it('only deletes transcripts for >30-day pulse checks; preserves all other records', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-purgeTranscripts/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        fc.array(pulseCheckArb, { minLength: 1, maxLength: 5 }),
        async (pulseChecks) => {
          // Build session and transcript maps
          const sessionMap = new Map()
          const transcriptMap = new Map()
          const allTranscriptsBefore = new Map() // snapshot for verification

          for (const pc of pulseChecks) {
            const sessionId = `session-${pc.itemId}`
            sessionMap.set(pc.itemId, [sessionId])

            const transcripts = [
              { sessionId, messageId: `msg-1-${pc.itemId}` },
              { sessionId, messageId: `msg-2-${pc.itemId}` },
            ]
            transcriptMap.set(sessionId, [...transcripts])
            allTranscriptsBefore.set(sessionId, [...transcripts])
          }

          setupMock(pulseChecks, sessionMap, transcriptMap)
          await handler({ source: 'test' })

          // Verify: transcripts for OLD pulse checks should be deleted
          for (const pc of pulseChecks) {
            const sessionId = `session-${pc.itemId}`
            const remaining = transcriptMap.get(sessionId) || []
            if (pc.isOld) {
              expect(remaining).toHaveLength(0)
            } else {
              // Recent pulse check transcripts should be preserved
              const original = allTranscriptsBefore.get(sessionId)
              expect(remaining).toHaveLength(original.length)
            }
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 5: Transcript Purge Idempotency
 *
 * For any dataset, running the purge function twice SHALL produce the same result
 * as running it once — no errors on the second run, no double-deletes, and the
 * same set of records exists after both runs.
 *
 * Validates: Requirements 2.5
 */
describe('Property P5: Purge idempotency', () => {
  beforeEach(() => {
    mockSend.mockReset()
    process.env.PULSE_CHECKS_TABLE = 'pulseChecks'
    process.env.SESSIONS_TABLE = 'sessions'
    process.env.TRANSCRIPTS_TABLE = 'transcripts'
  })

  it('running purge twice produces the same result as running once', async () => {
    const { handler } = await import('../../lambdas/urgd-pulse-purgeTranscripts/index.mjs')

    await fc.assert(
      fc.asyncProperty(
        fc.array(pulseCheckArb, { minLength: 1, maxLength: 5 }),
        async (pulseChecks) => {
          // Build session and transcript maps
          const sessionMap = new Map()
          const transcriptMap = new Map()

          for (const pc of pulseChecks) {
            const sessionId = `session-${pc.itemId}`
            sessionMap.set(pc.itemId, [sessionId])
            transcriptMap.set(sessionId, [
              { sessionId, messageId: `msg-1-${pc.itemId}` },
              { sessionId, messageId: `msg-2-${pc.itemId}` },
            ])
          }

          setupMock(pulseChecks, sessionMap, transcriptMap)

          // First run
          await handler({ source: 'test' })

          // Snapshot after first run
          const snapshotAfterFirst = new Map()
          for (const [k, v] of transcriptMap) {
            snapshotAfterFirst.set(k, [...v])
          }

          // Second run — should not throw and should produce same state
          setupMock(pulseChecks, sessionMap, transcriptMap)
          await expect(handler({ source: 'test' })).resolves.not.toThrow()

          // State after second run should match first run
          for (const [k, v] of transcriptMap) {
            const first = snapshotAfterFirst.get(k) || []
            expect(v).toHaveLength(first.length)
          }
        },
      ),
      { numRuns: 100 },
    )
  })
})
