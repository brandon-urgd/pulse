// Unit tests for urgd-pulse-getRevisions
// Requirements: 8.4

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

const s3SendSpy = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class ListObjectsV2Command { constructor(input) { this.input = input } }
  return { S3Client, ListObjectsV2Command }
})

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

function makeS3Object(revisionId, lastModified) {
  return {
    Key: `pulse/tenant-123/items/item-456/revisions/${revisionId}/document.md`,
    LastModified: new Date(lastModified),
    Size: 1024,
  }
}

describe('getRevisions handler', () => {
  beforeEach(() => {
    s3SendSpy.mockReset()
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
    s3SendSpy.mockResolvedValueOnce({ Contents: [], IsTruncated: false })
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data).toEqual([])
  })

  it('returns revisions sorted by creation date descending', async () => {
    const rev1 = 'rev-uuid-1'
    const rev2 = 'rev-uuid-2'
    const rev3 = 'rev-uuid-3'

    s3SendSpy.mockResolvedValueOnce({
      Contents: [
        makeS3Object(rev1, '2024-01-01T10:00:00.000Z'),
        makeS3Object(rev3, '2024-01-03T10:00:00.000Z'),
        makeS3Object(rev2, '2024-01-02T10:00:00.000Z'),
      ],
      IsTruncated: false,
    })

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)

    const body = JSON.parse(result.body)
    expect(body.data).toHaveLength(3)
    // Sorted descending — newest first
    expect(body.data[0].revisionId).toBe(rev3)
    expect(body.data[1].revisionId).toBe(rev2)
    expect(body.data[2].revisionId).toBe(rev1)
  })

  it('assigns revision numbers with newest = highest number', async () => {
    const rev1 = 'rev-uuid-1'
    const rev2 = 'rev-uuid-2'

    s3SendSpy.mockResolvedValueOnce({
      Contents: [
        makeS3Object(rev1, '2024-01-01T10:00:00.000Z'),
        makeS3Object(rev2, '2024-01-02T10:00:00.000Z'),
      ],
      IsTruncated: false,
    })

    const result = await handler(makeEvent())
    const body = JSON.parse(result.body)

    // Sorted descending: rev2 first (newer), rev1 second (older)
    expect(body.data[0].revisionId).toBe(rev2)
    expect(body.data[0].revisionNumber).toBe(2)
    expect(body.data[1].revisionId).toBe(rev1)
    expect(body.data[1].revisionNumber).toBe(1)
  })

  it('paginates through multiple S3 pages', async () => {
    const rev1 = 'rev-uuid-1'
    const rev2 = 'rev-uuid-2'

    s3SendSpy
      .mockResolvedValueOnce({
        Contents: [makeS3Object(rev1, '2024-01-01T10:00:00.000Z')],
        IsTruncated: true,
        NextContinuationToken: 'token-1',
      })
      .mockResolvedValueOnce({
        Contents: [makeS3Object(rev2, '2024-01-02T10:00:00.000Z')],
        IsTruncated: false,
      })

    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.data).toHaveLength(2)
  })

  it('ignores S3 objects that are not document.md files', async () => {
    s3SendSpy.mockResolvedValueOnce({
      Contents: [
        makeS3Object('rev-uuid-1', '2024-01-01T10:00:00.000Z'),
        {
          Key: 'pulse/tenant-123/items/item-456/revisions/rev-uuid-2/metadata.json',
          LastModified: new Date('2024-01-02T10:00:00.000Z'),
          Size: 100,
        },
      ],
      IsTruncated: false,
    })

    const result = await handler(makeEvent())
    const body = JSON.parse(result.body)
    // Only the document.md file should be included
    expect(body.data).toHaveLength(1)
    expect(body.data[0].revisionId).toBe('rev-uuid-1')
  })

  it('returns 500 on unexpected S3 error', async () => {
    s3SendSpy.mockRejectedValueOnce(new Error('S3 error'))
    const result = await handler(makeEvent())
    expect(result.statusCode).toBe(500)
  })
})
