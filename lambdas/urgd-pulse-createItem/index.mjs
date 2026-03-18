// ur/gd pulse — Create Item Lambda
// POST /api/manage/items → validates input, checks feature flag, creates item in DynamoDB

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'TENANTS_TABLE', 'DATA_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

const DEFAULT_MAX_ACTIVE_ITEMS_FREE = 1
const DEFAULT_MAX_ACTIVE_ITEMS_PAID = 25

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

  if (!tenantId) {
    log('warn', 'CreateItem: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { itemName, description, closeDate, content } = body

  // Validate itemName
  if (!itemName || typeof itemName !== 'string' || itemName.trim().length < 1 || itemName.trim().length > 200) {
    return errorResponse(400, 'itemName must be between 1 and 200 characters', {}, origin)
  }

  // Validate description
  if (!description || typeof description !== 'string' || description.trim().length < 1 || description.trim().length > 2000) {
    return errorResponse(400, 'description must be between 1 and 2000 characters', {}, origin)
  }

  // Validate closeDate
  if (!isValidFutureDate(closeDate)) {
    return errorResponse(400, 'closeDate must be a valid future date', {}, origin)
  }

  try {
    // Fetch tenant record to get feature flags
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
    }))

    if (!tenantResult.Item) {
      log('warn', 'CreateItem: tenant not found', { requestId, tenantId })
      return errorResponse(404, 'Tenant not found', {}, origin)
    }

    // Determine maxActiveItems from tenant features
    const tier = tenantResult.Item.tier?.S ?? 'free'
    const featuresMap = tenantResult.Item.features?.M ?? {}
    let maxActiveItems
    if (featuresMap.maxActiveItems?.N !== undefined) {
      maxActiveItems = Number(featuresMap.maxActiveItems.N)
    } else {
      maxActiveItems = tier === 'paid' ? DEFAULT_MAX_ACTIVE_ITEMS_PAID : DEFAULT_MAX_ACTIVE_ITEMS_FREE
    }

    // Count existing active/draft items for this tenant
    const existingItems = await dynamo.send(new QueryCommand({
      TableName: process.env.ITEMS_TABLE,
      KeyConditionExpression: 'tenantId = :tid',
      FilterExpression: '#st IN (:draft, :active)',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':tid': { S: tenantId },
        ':draft': { S: 'draft' },
        ':active': { S: 'active' },
      },
      Select: 'COUNT',
    }))

    const activeCount = existingItems.Count ?? 0
    if (activeCount >= maxActiveItems) {
      log('warn', 'CreateItem: maxActiveItems limit reached', { requestId, tenantId, activeCount, maxActiveItems })
      return errorResponse(403, "You've reached your item limit.", {}, origin)
    }

    // Generate item
    const itemId = randomUUID()
    const now = new Date().toISOString()
    let documentStatus = null

    // Store content in S3 if provided
    if (content && typeof content === 'string' && content.length > 0) {
      const s3Key = `pulse/${tenantId}/items/${itemId}/document.md`
      await s3.send(new PutObjectCommand({
        Bucket: process.env.DATA_BUCKET_NAME,
        Key: s3Key,
        Body: content,
        ContentType: 'text/markdown',
      }))
      documentStatus = 'ready'
      log('info', 'CreateItem: stored content in S3', { requestId, tenantId, itemId })
    }

    // Build DynamoDB item
    const dynamoItem = {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
      itemName: { S: itemName.trim() },
      description: { S: description.trim() },
      closeDate: { S: closeDate },
      status: { S: 'draft' },
      createdAt: { S: now },
      updatedAt: { S: now },
    }

    if (documentStatus !== null) {
      dynamoItem.documentStatus = { S: documentStatus }
    } else {
      dynamoItem.documentStatus = { NULL: true }
    }

    if (content && typeof content === 'string' && content.length > 0) {
      dynamoItem.content = { S: content }
    }

    await dynamo.send(new PutItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Item: dynamoItem,
    }))

    log('info', 'CreateItem: item created', { requestId, tenantId, itemId })

    return createResponse(201, {
      data: {
        tenantId,
        itemId,
        itemName: itemName.trim(),
        description: description.trim(),
        closeDate,
        status: 'draft',
        documentStatus,
        createdAt: now,
        updatedAt: now,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'CreateItem: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to create item', {}, origin)
  }
}
