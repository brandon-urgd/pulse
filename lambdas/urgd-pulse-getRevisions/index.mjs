// ur/gd pulse — Get Revisions Lambda
// GET /api/manage/items/{itemId}/revisions
//
// Lists S3 objects under pulse/{tenantId}/items/{itemId}/revisions/
// Returns revisions sorted by creation date descending

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['DATA_BUCKET', 'CORS_ALLOWED_ORIGINS'])

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    const prefix = `pulse/${tenantId}/items/${itemId}/revisions/`
    const revisions = []
    let continuationToken

    // Paginate through all objects under the revisions prefix
    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.DATA_BUCKET,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }))

      for (const obj of result.Contents ?? []) {
        // Key format: pulse/{tenantId}/items/{itemId}/revisions/{revisionId}/document.md
        const keyParts = obj.Key.split('/')
        // revisionId is the 6th segment (index 5)
        const revisionId = keyParts[5]
        if (!revisionId || !obj.Key.endsWith('/document.md')) continue

        revisions.push({
          revisionId,
          itemId,
          s3Key: obj.Key,
          createdAt: obj.LastModified?.toISOString() ?? new Date(0).toISOString(),
          sizeBytes: obj.Size ?? 0,
        })
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (continuationToken)

    // Sort by creation date descending (newest first)
    revisions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    // Add revision number (1 = oldest, N = newest) for display
    const total = revisions.length
    const revisionsWithNumber = revisions.map((r, i) => ({
      ...r,
      revisionNumber: total - i,
    }))

    log('info', 'GetRevisions: listed revisions', { requestId, tenantId, itemId, count: revisions.length })

    return createResponse(200, { data: revisionsWithNumber }, {}, origin)
  } catch (err) {
    log('error', 'GetRevisions: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to list revisions', {}, origin)
  }
}
