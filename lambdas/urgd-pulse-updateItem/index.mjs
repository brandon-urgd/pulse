// ur/gd pulse — Update Item Lambda
// PUT /api/manage/items/{itemId} → updates draft item fields

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'DATA_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Unmarshal a DynamoDB item into a plain JS object (handles S/N/BOOL/M/L/NULL)
 */
function unmarshal(item) {
  if (!item) return null
  const result = {}
  for (const [key, val] of Object.entries(item)) {
    if ('S' in val) result[key] = val.S
    else if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('M' in val) result[key] = unmarshal(val.M)
    else if ('L' in val) result[key] = val.L.map(v => unmarshal({ _: v })._)
    else if ('NULL' in val) result[key] = null
  }
  return result
}

/**
 * Validate that a date string is a valid ISO date in the future.
 */
function isValidFutureDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return false
  return d.getTime() > Date.now()
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'UpdateItem: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'Missing itemId', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { itemName, description, closeDate, content } = body

  // Validate optional fields if provided
  if (itemName !== undefined) {
    if (typeof itemName !== 'string' || itemName.trim().length < 1 || itemName.trim().length > 200) {
      return errorResponse(400, 'itemName must be between 1 and 200 characters', {}, origin)
    }
  }

  if (description !== undefined) {
    if (typeof description !== 'string' || description.trim().length < 1 || description.trim().length > 2000) {
      return errorResponse(400, 'description must be between 1 and 2000 characters', {}, origin)
    }
  }

  if (closeDate !== undefined) {
    if (!isValidFutureDate(closeDate)) {
      return errorResponse(400, 'closeDate must be a valid future date', {}, origin)
    }
  }

  try {
    // Fetch existing item
    const existing = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!existing.Item) {
      log('warn', 'UpdateItem: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const currentItem = unmarshal(existing.Item)

    // Only draft items can be edited
    if (currentItem.status !== 'draft') {
      log('warn', 'UpdateItem: item is locked', { requestId, tenantId, itemId, status: currentItem.status })
      return errorResponse(409, 'Item is locked and cannot be edited', {}, origin)
    }

    const now = new Date().toISOString()

    // Build update expression
    const updateParts = ['#updatedAt = :updatedAt']
    const expressionNames = { '#updatedAt': 'updatedAt' }
    const expressionValues = { ':updatedAt': { S: now } }

    if (itemName !== undefined) {
      updateParts.push('#itemName = :itemName')
      expressionNames['#itemName'] = 'itemName'
      expressionValues[':itemName'] = { S: itemName.trim() }
    }

    if (description !== undefined) {
      updateParts.push('#description = :description')
      expressionNames['#description'] = 'description'
      expressionValues[':description'] = { S: description.trim() }
    }

    if (closeDate !== undefined) {
      updateParts.push('#closeDate = :closeDate')
      expressionNames['#closeDate'] = 'closeDate'
      expressionValues[':closeDate'] = { S: closeDate }
    }

    // Handle content update — store in S3
    if (content !== undefined && typeof content === 'string' && content.length > 0) {
      const s3Key = `pulse/${tenantId}/items/${itemId}/document.md`
      await s3.send(new PutObjectCommand({
        Bucket: process.env.DATA_BUCKET_NAME,
        Key: s3Key,
        Body: content,
        ContentType: 'text/markdown',
      }))
      updateParts.push('#documentStatus = :documentStatus')
      expressionNames['#documentStatus'] = 'documentStatus'
      expressionValues[':documentStatus'] = { S: 'ready' }
      log('info', 'UpdateItem: stored content in S3', { requestId, tenantId, itemId })
    }

    const updateResult = await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
    }))

    const updatedItem = unmarshal(updateResult.Attributes)

    log('info', 'UpdateItem: item updated', { requestId, tenantId, itemId })

    return createResponse(200, { data: updatedItem }, {}, origin)
  } catch (err) {
    log('error', 'UpdateItem: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to update item', {}, origin)
  }
}
