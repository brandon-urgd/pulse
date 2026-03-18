// Property test for urgd-pulse-deleteItem
// Property 15: Cascading Delete Completeness Property
// Validates: Requirements 4.13

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('REPORTS_TABLE', 'urgd-pulse-reports-dev')
vi.stubEnv('PULSE_CHECKS_TABLE', 'urgd-pulse-pulsechecks-dev')
vi.stubEnv('DATA_BUCKET_NAME', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const sendSpy = vi.fn()
const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient {
    send(...args) { return sendSpy(...args) }
  }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class DeleteItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, DeleteItemCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    send(...args) { return s3SendSpy(...args) }
  }
  class ListObjectsV2Command { constructor(input) { this.input = input } }
  class DeleteObjectsCommand { constructor(input) { this.input = input } }
  return { S3Client, ListObjectsV2Command, DeleteObjectsCommand }
})

const { handler } = await import('./index.mjs')

function makeItemRecord(tenantId, itemId) {
  return {
    tenantId: { S: tenantId },
    itemId: { S: itemId },
    itemName: { S: 'Test Item' },
    status: { S: 'draft' },
    createdAt: { S: new Date().toISOString() },
    updatedAt: { S: new Date().toISOString() },
  }
}

function makeSessionRecord(tenantId, sessionId, itemId) {
  return {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    itemId: { S: itemId },
  }
}

function makeTranscriptRecord(sessionId, messageId) {
  return {
    sessionId: { S: sessionId },
    messageId: { S: messageId },
  }
}

function makeReportRecord(tenantId, sessionId, itemId) {
  return {
    tenantId: { S: tenantId },
    sessionId: { S: sessionId },
    itemId: { S: itemId },
  }
}

function makeS3Object(key) {
  return { Key: key }
}

function makeEvent(tenantId, itemId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { tenantId },
    },
    pathParameters: { itemId },
  }
}

/**
 * Set up mocks for a delete scenario with N sessions, M transcripts per session,
 * R reports, and K S3 objects.
 */
function setupDeleteMocks(tenantId, itemId, sessionCount, transcriptsPerSession, reportCount, s3ObjectCount) {
  const sessions = Array.from({ length: sessionCount }, (_, i) =>
    makeSessionRecord(tenantId, `session-${i}`, itemId)
  )

  const reports = Array.from({ length: reportCount }, (_, i) =>
    makeReportRecord(tenantId, `session-report-${i}`, itemId)
  )

  const s3Objects = Array.from({ length: s3ObjectCount }, (_, i) =>
    makeS3Object(`pulse/${tenantId}/items/${itemId}/file-${i}.md`)
  )

  // Track all delete calls
  const deletedItems = {
    transcripts: [],
    sessions: [],
    reports: [],
    pulseCheck: false,
    item: false,
  }

  let callIndex = 0

  sendSpy.mockImplementation((command) => {
    const name = command?.constructor?.name

    if (name === 'GetItemCommand') {
      return Promise.resolve({ Item: makeItemRecord(tenantId, itemId) })
    }

    if (name === 'QueryCommand') {
      const input = command.input
      if (input.TableName === process.env.SESSIONS_TABLE) {
        return Promise.resolve({ Items: sessions })
      }
      if (input.TableName === process.env.TRANSCRIPTS_TABLE) {
        const sid = input.ExpressionAttributeValues[':sid']?.S
        const transcripts = Array.from({ length: transcriptsPerSession }, (_, i) =>
          makeTranscriptRecord(sid, `msg-${i}`)
        )
        return Promise.resolve({ Items: transcripts })
      }
      if (input.TableName === process.env.REPORTS_TABLE) {
        return Promise.resolve({ Items: reports })
      }
      return Promise.resolve({ Items: [] })
    }

    if (name === 'DeleteItemCommand') {
      const input = command.input
      if (input.TableName === process.env.TRANSCRIPTS_TABLE) {
        deletedItems.transcripts.push(input.Key)
      } else if (input.TableName === process.env.SESSIONS_TABLE) {
        deletedItems.sessions.push(input.Key)
      } else if (input.TableName === process.env.REPORTS_TABLE) {
        deletedItems.reports.push(input.Key)
      } else if (input.TableName === process.env.PULSE_CHECKS_TABLE) {
        deletedItems.pulseCheck = true
      } else if (input.TableName === process.env.ITEMS_TABLE) {
        deletedItems.item = true
      }
      return Promise.resolve({})
    }

    return Promise.resolve({})
  })

  s3SendSpy.mockImplementation((command) => {
    const name = command?.constructor?.name
    if (name === 'ListObjectsV2Command') {
      return Promise.resolve({ Contents: s3Objects, IsTruncated: false })
    }
    if (name === 'DeleteObjectsCommand') {
      return Promise.resolve({})
    }
    return Promise.resolve({})
  })

  return deletedItems
}

describe('Property 15: Cascading Delete Completeness Property', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    s3SendSpy.mockReset()
  })

  it('for any item deletion, all sessions and their transcripts are deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),   // session count
        fc.integer({ min: 0, max: 3 }),   // transcripts per session
        async (sessionCount, transcriptsPerSession) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()

          const tenantId = 'tenant-test'
          const itemId = 'item-test'

          const deletedItems = setupDeleteMocks(tenantId, itemId, sessionCount, transcriptsPerSession, 0, 0)

          const event = makeEvent(tenantId, itemId)
          const result = await handler(event)

          expect(result.statusCode).toBe(200)

          // All sessions must be deleted
          expect(deletedItems.sessions).toHaveLength(sessionCount)

          // All transcripts must be deleted
          expect(deletedItems.transcripts).toHaveLength(sessionCount * transcriptsPerSession)

          // Item itself must be deleted
          expect(deletedItems.item).toBe(true)

          // Pulse check delete must be attempted
          expect(deletedItems.pulseCheck).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any item deletion, all reports are deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),  // report count
        async (reportCount) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()

          const tenantId = 'tenant-test'
          const itemId = 'item-test'

          const deletedItems = setupDeleteMocks(tenantId, itemId, 0, 0, reportCount, 0)

          const event = makeEvent(tenantId, itemId)
          const result = await handler(event)

          expect(result.statusCode).toBe(200)
          expect(deletedItems.reports).toHaveLength(reportCount)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('for any item deletion, S3 objects under the item prefix are deleted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),  // S3 object count
        async (s3ObjectCount) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()

          const tenantId = 'tenant-test'
          const itemId = 'item-test'

          setupDeleteMocks(tenantId, itemId, 0, 0, 0, s3ObjectCount)

          const deleteObjectsCalls = []
          const originalS3Send = s3SendSpy.getMockImplementation()
          s3SendSpy.mockImplementation((command) => {
            if (command?.constructor?.name === 'DeleteObjectsCommand') {
              deleteObjectsCalls.push(command.input)
            }
            return originalS3Send(command)
          })

          const event = makeEvent(tenantId, itemId)
          const result = await handler(event)

          expect(result.statusCode).toBe(200)

          if (s3ObjectCount > 0) {
            // DeleteObjects must have been called
            expect(deleteObjectsCalls.length).toBeGreaterThan(0)
            // Total objects deleted must equal s3ObjectCount
            const totalDeleted = deleteObjectsCalls.reduce(
              (sum, call) => sum + (call.Delete?.Objects?.length ?? 0),
              0
            )
            expect(totalDeleted).toBe(s3ObjectCount)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('returns 200 with message "Item deleted" after successful cascading delete', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        async (sessionCount, reportCount) => {
          sendSpy.mockReset()
          s3SendSpy.mockReset()

          setupDeleteMocks('tenant-test', 'item-test', sessionCount, 0, reportCount, 0)

          const event = makeEvent('tenant-test', 'item-test')
          const result = await handler(event)

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.message).toBe('Item deleted')
        }
      ),
      { numRuns: 100 }
    )
  })
})
