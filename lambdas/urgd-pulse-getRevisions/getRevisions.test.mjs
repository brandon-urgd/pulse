// Unit tests for urgd-pulse-getRevisions (DynamoDB-backed)
// Requirements: 3.3, 3.4, 3.5

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('REVISIONS_TABLE', 'urgd-pulse-revisions-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const getSignedUrlSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class QueryCommand { constructor(input) { this.input = input; this.name = 'QueryCommand' } }
  return { DynamoDBClient, QueryCommand }
})

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => getSignedUrlSpy(...args),
}))

const { handler } = await import('./index.mjs')

function makeEvent(overrides = {}) {
  return {
    headers: { origin: 'https://pulse.urgdstudios.com' },
    requestContext: {
      requestId: 'req-test',
      authorizer: { tenantId: 'tenant-123' },
    },
    pathParameters: { itemId: 'item-456' },
    ...overrides,
  }
}

function makeDynamoRevision(revisionId, status, createdAt, extra = {}) {
  const item = {
    tenantId: { S: 'tenant-123' },
    revisionId: { S: revisionId },
    itemId: { S: 'item-456' },
    status: { S: status },
    createdAt: { S: createdAt },
  }
  if (extra.completedAt) item.completedAt = { S: extra.completedAt }
  if (extra.decisionsApplied !== undefined) item.decisionsApplied = { N: String(extra.decisionsApplied) }
  return item
}

describe('getRevisions handler (DynamoDB-backed)', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    getSignedUrlSpy.mockReset()
    getSignedUrlSpy.mockResolvedValue('https://presigned-url.example.com')
  })

  it('returns 401 when tenantId is missing', async () => {
    const event = makeEvent({ requestContext: { requestId: 'req', authorizer: {} } })
    const result = await handler(event)
    expect(result.statusCode).toBe(401)
  })

  it('returns 400 when itemId is missing', async () => {
    const event = makeEvent({ pathParameters: {} })
    const result = await handler(event)
    expect(result.statusCode).toBe(400)
  })

  it('returns empty array when no revisions exist', async () => {
    dynamoSendSpy.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined })
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data.revisions).toEqual([])
  })

  it('returns revisions sorted newest first with correct revisionNumbers', async () => {
    dynamoSendSpy.mockResolvedValueOnce({
      Items: [
        makeDynamoRevision('rev-1', 'complete', '2024-01-01T10:00:00.000Z', { completedAt: '2024-01-01T10:05:00.000Z', decisionsApplied: 3 }),
        makeDynamoRevision('rev-2', 'complete', '2024-01-02T10:00:00.000Z', { completedAt: '2024-01-02T10:05:00.000Z', decisionsApplied: 5 }),
        makeDynamoRevision('rev-3', 'generating', '2024-01-03T10:00:00.000Z'),
      ],
      LastEvaluatedKey: undefined,
    })

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)

    const body = JSON.parse(result.body)
    const revisions = body.data.revisions
    expect(revisions).toHaveLength(3)

    // Newest first in response
    expect(revisions[0].revisionId).toBe('rev-3')
    expect(revisions[0].revisionNumber).toBe(3)
    expect(revisions[1].revisionId).toBe('rev-2')
    expect(revisions[1].revisionNumber).toBe(2)
    expect(revisions[2].revisionId).toBe('rev-1')
    expect(revisions[2].revisionNumber).toBe(1)
  })

  it('includes pre-signed URLs only for complete revisions', async () => {
    dynamoSendSpy.mockResolvedValueOnce({
      Items: [
        makeDynamoRevision('rev-1', 'complete', '2024-01-01T10:00:00.000Z', { completedAt: '2024-01-01T10:05:00.000Z' }),
        makeDynamoRevision('rev-2', 'generating', '2024-01-02T10:00:00.000Z'),
        makeDynamoRevision('rev-3', 'failed', '2024-01-03T10:00:00.000Z'),
      ],
      LastEvaluatedKey: undefined,
    })

    const result = await handler(makeEvent())
    const body = JSON.parse(result.body)
    const revisions = body.data.revisions

    // rev-3 (failed) — no URLs
    expect(revisions[0].documentUrl).toBeUndefined()
    expect(revisions[0].originalUrl).toBeUndefined()

    // rev-2 (generating) — no URLs
    expect(revisions[1].documentUrl).toBeUndefined()
    expect(revisions[1].originalUrl).toBeUndefined()

    // rev-1 (complete) — has URLs
    expect(revisions[2].documentUrl).toBeDefined()
    expect(revisions[2].originalUrl).toBeDefined()
  })

  it('includes completedAt and decisionsApplied when present', async () => {
    dynamoSendSpy.mockResolvedValueOnce({
      Items: [
        makeDynamoRevision('rev-1', 'complete', '2024-01-01T10:00:00.000Z', {
          completedAt: '2024-01-01T10:05:00.000Z',
          decisionsApplied: 7,
        }),
      ],
      LastEvaluatedKey: undefined,
    })

    const result = await handler(makeEvent())
    const body = JSON.parse(result.body)
    const rev = body.data.revisions[0]

    expect(rev.completedAt).toBe('2024-01-01T10:05:00.000Z')
    expect(rev.decisionsApplied).toBe(7)
  })

  it('paginates through multiple DynamoDB pages', async () => {
    dynamoSendSpy
      .mockResolvedValueOnce({
        Items: [makeDynamoRevision('rev-1', 'generating', '2024-01-01T10:00:00.000Z')],
        LastEvaluatedKey: { tenantId: { S: 'tenant-123' }, revisionId: { S: 'rev-1' } },
      })
      .mockResolvedValueOnce({
        Items: [makeDynamoRevision('rev-2', 'generating', '2024-01-02T10:00:00.000Z')],
        LastEvaluatedKey: undefined,
      })

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data.revisions).toHaveLength(2)
  })

  it('returns 500 on unexpected DynamoDB error', async () => {
    dynamoSendSpy.mockRejectedValueOnce(new Error('DynamoDB error'))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(500)
  })
})
