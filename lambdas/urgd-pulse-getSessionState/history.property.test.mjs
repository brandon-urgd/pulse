// Property test for urgd-pulse-getSessionState
// Feature: pulse, Property 20: Conversation History Completeness Property
// Validates: Requirements 5.x (session state retrieval)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return sendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(() => Promise.resolve('https://signed-url.example.com/doc')),
}))

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

function makeSession() {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: 'in_progress' },
    currentSection: { N: '2' },
    totalSections: { N: '5' },
    timeLimitMinutes: { N: '30' },
    itemId: { S: 'item-test' },
  }
}

function makeTranscriptItems(n) {
  // n message pairs = n reviewer + n agent messages = 2n total
  const items = []
  for (let i = 0; i < n; i++) {
    // ULID-like sort keys (lexicographically ordered)
    const reviewerUlid = `01HTEST${String(i * 2).padStart(18, '0')}`
    const agentUlid = `01HTEST${String(i * 2 + 1).padStart(18, '0')}`
    items.push({
      sessionId: { S: 'session-test' },
      messageId: { S: reviewerUlid },
      role: { S: 'reviewer' },
      content: { S: `Reviewer message ${i + 1}` },
      timestamp: { S: new Date().toISOString() },
    })
    items.push({
      sessionId: { S: 'session-test' },
      messageId: { S: agentUlid },
      role: { S: 'agent' },
      content: { S: `Agent response ${i + 1}` },
      timestamp: { S: new Date().toISOString() },
    })
  }
  return items
}

describe('Property 20: Conversation History Completeness Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
  })

  it('for any session with N message pairs, getSessionState returns all N×2 messages in ULID order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        async (n) => {
          sendSpy.mockReset()

          const transcriptItems = makeTranscriptItems(n)

          // GetItem for session
          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          // Query for transcripts
          sendSpy.mockResolvedValueOnce({ Items: transcriptItems })
          // GetItem for item (no documentKey)
          sendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-test' }, itemId: { S: 'item-test' }, documentStatus: { S: 'none' } } })

          const result = await handler(makeEvent())
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          expect(body.data.messages).toHaveLength(n * 2)

          // Verify order is preserved (ULID ascending = insertion order)
          for (let i = 0; i < n; i++) {
            expect(body.data.messages[i * 2].role).toBe('reviewer')
            expect(body.data.messages[i * 2].content).toBe(`Reviewer message ${i + 1}`)
            expect(body.data.messages[i * 2 + 1].role).toBe('agent')
            expect(body.data.messages[i * 2 + 1].content).toBe(`Agent response ${i + 1}`)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('messages array is always present even for empty sessions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(0),
        async () => {
          sendSpy.mockReset()
          sendSpy.mockResolvedValueOnce({ Item: makeSession() })
          sendSpy.mockResolvedValueOnce({ Items: [] })
          sendSpy.mockResolvedValueOnce({ Item: { tenantId: { S: 'tenant-test' }, itemId: { S: 'item-test' } } })

          const result = await handler(makeEvent())
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          expect(Array.isArray(body.data.messages)).toBe(true)
          expect(body.data.messages).toHaveLength(0)
        }
      ),
      { numRuns: 100 }
    )
  })
})
