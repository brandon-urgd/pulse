// Property-based tests for getSessionState dynamic totalSections
// Property P16

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler } = await import('../../lambdas/urgd-pulse-getSessionState/index.mjs')

function makeEvent(sessionId, tenantId) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-prop-test',
      authorizer: { sessionId, tenantId },
    },
  }
}

function makeFrozenSnapshot(feedbackSectionIds) {
  return {
    M: {
      feedbackSections: {
        L: feedbackSectionIds.map(id => ({ S: id })),
      },
      sectionMap: { M: {} },
      sectionDepthPreferences: { M: {} },
    },
  }
}

function makeSession(overrides = {}) {
  return {
    tenantId: { S: 'tenant-test' },
    sessionId: { S: 'session-test' },
    status: { S: 'not_started' },
    itemId: { S: 'item-test' },
    currentSection: { N: '1' },
    timeLimitMinutes: { N: '30' },
    closingState: { S: 'exploring' },
    ...overrides,
  }
}

/**
 * Property P16: Dynamic totalSections from frozen snapshot
 *
 * With frozenSnapshot → totalSections equals feedbackSections.length
 * Without frozenSnapshot → fallback to parseInt(session.totalSections?.N || '5', 10)
 *
 * Validates: Requirements 10.1
 */
describe('Property P16: Dynamic totalSections from frozen snapshot', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlSpy.mockReset()
  })

  it('with frozenSnapshot → totalSections equals feedbackSections.length', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.nat({ max: 9 }).map(n => `s${n + 1}`),
          { minLength: 1, maxLength: 10 },
        ),
        async (feedbackSectionIds) => {
          dynamoSendSpy.mockReset()

          const session = makeSession({
            frozenSnapshot: makeFrozenSnapshot(feedbackSectionIds),
          })

          // Session lookup
          dynamoSendSpy.mockResolvedValueOnce({ Item: session })
          // Transcripts query
          dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
          // Item lookup
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: 'tenant-test' },
              itemId: { S: 'item-test' },
              itemType: { S: 'document' },
            },
          })

          const result = await handler(makeEvent('session-test', 'tenant-test'))

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data.totalSections).toBe(feedbackSectionIds.length)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('without frozenSnapshot → fallback to session.totalSections or 5', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        async (totalSectionsN) => {
          dynamoSendSpy.mockReset()

          const session = makeSession({
            totalSections: { N: String(totalSectionsN) },
            // No frozenSnapshot
          })

          dynamoSendSpy.mockResolvedValueOnce({ Item: session })
          dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: 'tenant-test' },
              itemId: { S: 'item-test' },
              itemType: { S: 'document' },
            },
          })

          const result = await handler(makeEvent('session-test', 'tenant-test'))

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          expect(body.data.totalSections).toBe(totalSectionsN)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('without frozenSnapshot and no totalSections → defaults to 5', async () => {
    dynamoSendSpy.mockReset()

    const session = makeSession({
      // No frozenSnapshot, no totalSections
    })
    delete session.totalSections

    dynamoSendSpy.mockResolvedValueOnce({ Item: session })
    dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
    dynamoSendSpy.mockResolvedValueOnce({
      Item: {
        tenantId: { S: 'tenant-test' },
        itemId: { S: 'item-test' },
        itemType: { S: 'document' },
      },
    })

    const result = await handler(makeEvent('session-test', 'tenant-test'))

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data.totalSections).toBe(5)
  })

  it('frozenSnapshot with N sections always overrides session.totalSections', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.nat({ max: 9 }).map(n => `s${n + 1}`),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 1, max: 20 }),
        async (feedbackSectionIds, sessionTotalSections) => {
          dynamoSendSpy.mockReset()

          const session = makeSession({
            frozenSnapshot: makeFrozenSnapshot(feedbackSectionIds),
            totalSections: { N: String(sessionTotalSections) },
          })

          dynamoSendSpy.mockResolvedValueOnce({ Item: session })
          dynamoSendSpy.mockResolvedValueOnce({ Items: [] })
          dynamoSendSpy.mockResolvedValueOnce({
            Item: {
              tenantId: { S: 'tenant-test' },
              itemId: { S: 'item-test' },
              itemType: { S: 'document' },
            },
          })

          const result = await handler(makeEvent('session-test', 'tenant-test'))

          expect(result.statusCode).toBe(200)
          const body = JSON.parse(result.body)
          // frozenSnapshot.feedbackSections.length wins over session.totalSections
          expect(body.data.totalSections).toBe(feedbackSectionIds.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})
