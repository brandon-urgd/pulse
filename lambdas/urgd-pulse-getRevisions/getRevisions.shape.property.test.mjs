// Feature: async-revision-generation, Property 5: GetRevisions returns correct shape with conditional URL inclusion
//
// For any set of revision records with mixed statuses (generating, complete, failed),
// the getRevisions Lambda SHALL return all revisions with revisionId, status, revisionNumber,
// and createdAt; SHALL assign revisionNumber in ascending order (oldest = 1);
// SHALL include documentUrl and originalUrl only for revisions with status 'complete';
// and SHALL omit document URLs for revisions with status 'generating' or 'failed'.
//
// **Validates: Requirements 3.3, 3.4, 3.5**
// numRuns: 100

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  return { DynamoDBClient, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler } = await import('./index.mjs')

// ─── Generators ───────────────────────────────────────────────────────────────

const statusArb = fc.constantFrom('generating', 'complete', 'failed')

const revisionRecordArb = fc.record({
  revisionId: fc.uuid(),
  status: statusArb,
  createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map(d => d.toISOString()),
  decisionsApplied: fc.integer({ min: 1, max: 50 }),
})

// Generate 1–10 revision records with unique createdAt timestamps
const revisionSetArb = fc.array(revisionRecordArb, { minLength: 1, maxLength: 10 })
  .map(records => {
    // Ensure unique createdAt by adding index offset
    return records.map((r, i) => ({
      ...r,
      createdAt: new Date(new Date(r.createdAt).getTime() + i * 1000).toISOString(),
    }))
  })

function makeDynamoItem(tenantId, itemId, record) {
  const item = {
    tenantId: { S: tenantId },
    revisionId: { S: record.revisionId },
    itemId: { S: itemId },
    status: { S: record.status },
    createdAt: { S: record.createdAt },
    decisionsApplied: { N: String(record.decisionsApplied) },
  }
  if (record.status === 'complete') {
    item.completedAt = { S: new Date(new Date(record.createdAt).getTime() + 60000).toISOString() }
  }
  return item
}

describe('Property 5: GetRevisions returns correct shape with conditional URL inclusion', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    getSignedUrlSpy.mockReset()
  })

  it('response shape, ordering, and conditional URL inclusion hold for any revision set', async () => {
    await fc.assert(
      fc.asyncProperty(
        revisionSetArb,
        fc.uuid(), // tenantId
        fc.uuid(), // itemId
        async (records, tenantId, itemId) => {
          dynamoSendSpy.mockReset()
          getSignedUrlSpy.mockReset()

          // Sort records by createdAt ascending (as GSI would return with ScanIndexForward: true)
          const sorted = [...records].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

          // Mock DynamoDB to return sorted items
          dynamoSendSpy.mockResolvedValueOnce({
            Items: sorted.map(r => makeDynamoItem(tenantId, itemId, r)),
            LastEvaluatedKey: undefined,
          })

          // Mock pre-signed URL generation
          getSignedUrlSpy.mockResolvedValue('https://presigned.example.com/doc')

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req', authorizer: { tenantId } },
            pathParameters: { itemId },
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          const revisions = body.data.revisions

          // INVARIANT 1: All records are returned
          expect(revisions).toHaveLength(records.length)

          // INVARIANT 2: Response is newest first (descending by createdAt)
          for (let i = 1; i < revisions.length; i++) {
            expect(new Date(revisions[i - 1].createdAt).getTime())
              .toBeGreaterThanOrEqual(new Date(revisions[i].createdAt).getTime())
          }

          // INVARIANT 3: revisionNumber is assigned ascending (oldest = 1)
          // Since response is newest first, the last item should have revisionNumber 1
          for (const rev of revisions) {
            expect(rev.revisionNumber).toBeGreaterThanOrEqual(1)
            expect(rev.revisionNumber).toBeLessThanOrEqual(records.length)
          }
          // The newest revision should have the highest number
          expect(revisions[0].revisionNumber).toBe(records.length)
          expect(revisions[revisions.length - 1].revisionNumber).toBe(1)

          // INVARIANT 4: Every revision has required fields
          for (const rev of revisions) {
            expect(rev.revisionId).toBeDefined()
            expect(typeof rev.revisionId).toBe('string')
            expect(rev.status).toBeDefined()
            expect(['generating', 'complete', 'failed']).toContain(rev.status)
            expect(rev.revisionNumber).toBeDefined()
            expect(typeof rev.revisionNumber).toBe('number')
            expect(rev.createdAt).toBeDefined()
            expect(typeof rev.createdAt).toBe('string')
          }

          // INVARIANT 5: Only 'complete' revisions have document URLs
          for (const rev of revisions) {
            if (rev.status === 'complete') {
              expect(rev.documentUrl).toBeDefined()
              expect(typeof rev.documentUrl).toBe('string')
              expect(rev.originalUrl).toBeDefined()
              expect(typeof rev.originalUrl).toBe('string')
            } else {
              expect(rev.documentUrl).toBeUndefined()
              expect(rev.originalUrl).toBeUndefined()
            }
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
