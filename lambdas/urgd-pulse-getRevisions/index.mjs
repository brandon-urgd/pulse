// ur/gd pulse — Get Revisions Lambda
// GET /api/manage/items/{itemId}/revisions
//
// Queries the Revisions DynamoDB table via itemId-index GSI.
// Returns revision records with status field. For 'complete' revisions,
// generates pre-signed S3 URLs for original and revised documents.

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['REVISIONS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // Query Revisions table via itemId-index GSI, sorted by createdAt ascending
    const items = []
    let lastEvaluatedKey

    do {
      const result = await dynamo.send(new QueryCommand({
        TableName: process.env.REVISIONS_TABLE,
        IndexName: 'itemId-index',
        KeyConditionExpression: 'itemId = :itemId',
        FilterExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: {
          ':itemId': { S: itemId },
          ':tenantId': { S: tenantId },
        },
        ScanIndexForward: true, // ascending by createdAt (oldest first)
        ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
      }))

      for (const item of result.Items ?? []) {
        items.push(item)
      }

      lastEvaluatedKey = result.LastEvaluatedKey
    } while (lastEvaluatedKey)

    // Build response — assign revisionNumber in ascending order (oldest = 1)
    const revisions = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const status = item.status?.S ?? 'generating'
      const revisionId = item.revisionId?.S
      const createdAt = item.createdAt?.S
      const completedAt = item.completedAt?.S
      const decisionsApplied = item.decisionsApplied?.N ? Number(item.decisionsApplied.N) : undefined

      const revision = {
        revisionId,
        status,
        revisionNumber: i + 1, // oldest = 1
        createdAt,
        ...(completedAt ? { completedAt } : {}),
        ...(decisionsApplied !== undefined ? { decisionsApplied } : {}),
      }

      // For complete revisions, generate pre-signed S3 URLs
      if (status === 'complete') {
        const revisedKey = `pulse/${tenantId}/items/${itemId}/revisions/${revisionId}/document.md`
        const originalKey = `pulse/${tenantId}/items/${itemId}/extracted.md`

        const [documentUrl, originalUrl] = await Promise.all([
          getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: revisedKey }), { expiresIn: 900 }),
          getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: originalKey }), { expiresIn: 900 }),
        ])

        revision.documentUrl = documentUrl
        revision.originalUrl = originalUrl
      }

      revisions.push(revision)
    }

    // Return newest first for display (reverse the ascending order)
    revisions.reverse()

    log('info', 'GetRevisions: listed revisions', { requestId, tenantId, itemId, count: revisions.length })

    return createResponse(200, { data: { revisions } }, {}, origin)
  } catch (err) {
    log('error', 'GetRevisions: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to list revisions', {}, origin)
  }
}
