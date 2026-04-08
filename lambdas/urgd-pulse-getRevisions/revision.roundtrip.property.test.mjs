// Feature: async-revision-generation, Property 4: Revision record round-trip preserves all attributes
//
// For any valid revision record containing tenantId, revisionId, itemId, status,
// createdAt, completedAt, and decisionsApplied, writing the record to the Revisions
// table and reading it back SHALL produce an equivalent record with all attributes preserved.
//
// **Validates: Requirements 3.1**
// numRuns: 100
//
// This test validates the marshalling/unmarshalling round-trip by simulating
// DynamoDB PutItem → Query and verifying attribute preservation through the
// getRevisions handler's response transformation.

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
  tenantId: fc.uuid(),
  revisionId: fc.uuid(),
  itemId: fc.uuid(),
  status: statusArb,
  createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map(d => d.toISOString()),
  decisionsApplied: fc.integer({ min: 0, max: 100 }),
}).chain(record =>
  record.status === 'complete'
    ? fc.constant({
        ...record,
        completedAt: new Date(new Date(record.createdAt).getTime() + 60000).toISOString(),
      })
    : fc.constant(record)
)

/**
 * Simulate DynamoDB marshalling: convert a plain record to DynamoDB attribute map.
 * This mirrors what PutItemCommand would store.
 */
function marshalRecord(record) {
  const item = {
    tenantId: { S: record.tenantId },
    revisionId: { S: record.revisionId },
    itemId: { S: record.itemId },
    status: { S: record.status },
    createdAt: { S: record.createdAt },
    decisionsApplied: { N: String(record.decisionsApplied) },
  }
  if (record.completedAt) {
    item.completedAt = { S: record.completedAt }
  }
  return item
}

describe('Property 4: Revision record round-trip preserves all attributes', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    getSignedUrlSpy.mockReset()
    getSignedUrlSpy.mockResolvedValue('https://presigned.example.com/doc')
  })

  it('all attributes are preserved through marshal → query → response transformation', async () => {
    await fc.assert(
      fc.asyncProperty(
        revisionRecordArb,
        async (record) => {
          dynamoSendSpy.mockReset()
          getSignedUrlSpy.mockReset()
          getSignedUrlSpy.mockResolvedValue('https://presigned.example.com/doc')

          // Simulate DynamoDB round-trip: marshal the record as DynamoDB would store it
          const marshalledItem = marshalRecord(record)

          // Mock DynamoDB Query to return the marshalled item
          dynamoSendSpy.mockResolvedValueOnce({
            Items: [marshalledItem],
            LastEvaluatedKey: undefined,
          })

          const event = {
            headers: { origin: 'https://pulse.urgdstudios.com' },
            requestContext: { requestId: 'req', authorizer: { tenantId: record.tenantId } },
            pathParameters: { itemId: record.itemId },
          }

          const result = await handler(event)
          expect(result.statusCode).toBe(200)

          const body = JSON.parse(result.body)
          const revisions = body.data.revisions
          expect(revisions).toHaveLength(1)

          const rev = revisions[0]

          // INVARIANT: Core attributes preserved
          expect(rev.revisionId).toBe(record.revisionId)
          expect(rev.status).toBe(record.status)
          expect(rev.createdAt).toBe(record.createdAt)
          expect(rev.revisionNumber).toBe(1) // single record → number 1

          // INVARIANT: decisionsApplied preserved as number
          expect(rev.decisionsApplied).toBe(record.decisionsApplied)

          // INVARIANT: completedAt preserved when present
          if (record.completedAt) {
            expect(rev.completedAt).toBe(record.completedAt)
          } else {
            expect(rev.completedAt).toBeUndefined()
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
