// Property test for urgd-pulse-deleteSessionTranscript
// Feature: pulse, Property 29: Discard Completeness Property
// Validates: Requirements 5.x (session discard)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class BatchWriteItemCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, BatchWriteItemCommand, UpdateItemCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent() {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { sessionId: 'session-test', tenantId: 'tenant-test' },
    },
  }
}

function makeSession(status) {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: status },
  }
}

function makeTranscriptItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    sessionId: { S: 'session-test' },
    messageId: { S: `01HTEST${String(i).padStart(18, '0')}` },
  }))
}

describe('Property 29: Discard Completeness Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  it('for non-completed sessions: all transcripts deleted, status → discarded', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('not_started', 'in_progress', 'expired', 'discarded'),
        fc.integer({ min: 0, max: 50 }),
        async (status, transcriptCount) => {
          sendSpy.mockReset()

          const transcriptItems = makeTranscriptItems(transcriptCount)

          // GetItem for session
          sendSpy.mockResolvedValueOnce({ Item: makeSession(status) })
          // Query for transcripts
          sendSpy.mockResolvedValueOnce({ Items: transcriptItems })
          // BatchWriteItem calls (25 per batch)
          const batchCount = Math.ceil(transcriptCount / 25)
          for (let i = 0; i < batchCount; i++) {
            sendSpy.mockResolvedValueOnce({})
          }
          // UpdateItem for session status
          sendSpy.mockResolvedValueOnce({})

          const result = await handler(makeEvent())
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          expect(body.data.discarded).toBe(true)

          // Verify UpdateItem was called to set status to 'discarded'
          // sendSpy calls: GetItem(0), Query(1), [BatchWrite calls...], UpdateItem(last)
          const lastCall = sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0]
          const updateExpr = lastCall.input.UpdateExpression
          expect(updateExpr).toContain('discarded')

          // Verify BatchWriteItem was called for all transcripts
          const batchCalls = sendSpy.mock.calls.slice(2, 2 + batchCount)
          const totalDeleted = batchCalls.reduce((sum, call) => {
            const requests = call[0].input.RequestItems?.[process.env.TRANSCRIPTS_TABLE] || []
            return sum + requests.length
          }, 0)
          expect(totalDeleted).toBe(transcriptCount)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for completed sessions: returns 409, no data modified', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant('completed'),
        async (status) => {
          sendSpy.mockReset()

          // GetItem for session
          sendSpy.mockResolvedValueOnce({ Item: makeSession(status) })

          const result = await handler(makeEvent())
          expect(result.statusCode).toBe(409)

          const body = JSON.parse(result.body)
          expect(body.message).toMatch(/completed/i)

          // Verify no write operations were performed (only GetItem was called)
          expect(sendSpy).toHaveBeenCalledTimes(1)
        }
      ),
      { numRuns: 100 }
    )
  })
})
