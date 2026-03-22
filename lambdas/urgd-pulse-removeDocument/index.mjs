// ur/gd pulse — Remove Document Lambda
// DELETE /api/manage/items/{itemId}/document
// Removes the uploaded document from a draft item (best-effort S3 deletes + DynamoDB update)

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['ITEMS_TABLE', 'DATA_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const { itemId } = event.pathParameters || {}

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  try {
    // 1. Fetch item and verify ownership
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const item = itemResult.Item

    if (item.tenantId?.S !== tenantId) {
      return errorResponse(403, 'Forbidden', {}, origin)
    }

    if (item.status?.S !== 'draft') {
      return errorResponse(409, 'Document can only be removed from draft items', {}, origin)
    }

    // 2. Best-effort S3 deletes (ignore 404s)
    const keysToDelete = []
    if (item.documentKey?.S) keysToDelete.push(item.documentKey.S)
    if (item.extractedKey?.S) keysToDelete.push(item.extractedKey.S)

    await Promise.allSettled(
      keysToDelete.map((key) =>
        s3.send(new DeleteObjectCommand({ Bucket: process.env.DATA_BUCKET_NAME, Key: key }))
      )
    )

    // 3. Update DynamoDB — clear document fields
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression:
        'SET #documentStatus = :none, #updatedAt = :now REMOVE #documentKey, #extractedKey, #recommendedTimeLimitMinutes',
      ExpressionAttributeNames: {
        '#documentStatus': 'documentStatus',
        '#updatedAt': 'updatedAt',
        '#documentKey': 'documentKey',
        '#extractedKey': 'extractedKey',
        '#recommendedTimeLimitMinutes': 'recommendedTimeLimitMinutes',
      },
      ExpressionAttributeValues: {
        ':none': { S: 'none' },
        ':now': { S: new Date().toISOString() },
      },
    }))

    log('info', 'RemoveDocument: document removed', { requestId, tenantId, itemId })

    return createResponse(200, { data: { message: 'Document removed' } }, {}, origin)
  } catch (err) {
    log('error', 'RemoveDocument: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to remove document', {}, origin)
  }
}
