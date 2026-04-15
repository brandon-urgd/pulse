// ur/gd pulse — Create Item Lambda
// POST /api/manage/items → validates input, checks feature flag, creates item in DynamoDB

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'
import { checkAndIncrement } from './shared/counters.mjs'
import { upsertCloseSchedule } from './shared/scheduleClose.mjs'
import { buildTemplateGreeting } from './shared/greetingTemplates.mjs'
import { randomUUID } from 'crypto'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'TENANTS_TABLE', 'DATA_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

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

  const { itemName, description, closeDate, content, feedbackSections, sectionDepthPreferences, itemType: requestedItemType } = body

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

  // Normalize closeDate to UTC ISO 8601 (Slice 3 — R3.2)
  // e.g. "2026-04-15T23:59:00-07:00" → "2026-04-16T06:59:00.000Z"
  const closeDateUTC = new Date(closeDate).toISOString()

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

    // Fetch SYSTEM record for circuit breakers
    let systemItem = null
    try {
      const systemResult = await dynamo.send(new GetItemCommand({
        TableName: process.env.TENANTS_TABLE,
        Key: { tenantId: { S: 'SYSTEM' } },
      }))
      systemItem = systemResult.Item ?? null
    } catch (err) {
      log('warn', 'CreateItem: failed to fetch SYSTEM record', { requestId, errorName: err.name })
    }

    // Unmarshal tenant record for resolveFeature
    const tenantRecord = {
      tier: tenantResult.Item.tier?.S ?? 'free',
      features: unmarshalFeatures(tenantResult.Item.features?.M),
      serviceFlags: unmarshalFeatures(tenantResult.Item.serviceFlags?.M),
      usageCounters: unmarshalFeatures(tenantResult.Item.usageCounters?.M),
      orgId: tenantResult.Item.orgId?.S ?? null,
    }
    const systemRecord = systemItem ? {
      serviceFlags: unmarshalFeatures(systemItem.serviceFlags?.M),
    } : null

    const maxItemsResult = resolveFeature(tenantRecord, 'maxActiveItems', systemRecord)
    if (!maxItemsResult.allowed) {
      return errorResponse(
        maxItemsResult.reason === 'maintenance' ? 503 : 403,
        maxItemsResult.reason === 'maintenance' ? 'Feature under maintenance' : "You've reached your item limit.",
        {}, origin
      )
    }
    const maxActiveItems = maxItemsResult.limit

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

    // Monthly counter enforcement — monthlyItemsCreated
    const counterResult = await checkAndIncrement({
      tenantId,
      counterName: 'monthlyItemsCreated',
      tenantRecord,
      systemRecord,
      orgId: tenantRecord.orgId ?? null,
    })
    if (!counterResult.allowed) {
      log('warn', 'CreateItem: monthly item limit reached', { requestId, tenantId, reason: counterResult.reason })
      return errorResponse(403, 'Monthly item limit reached', {
        reason: counterResult.reason,
        counter: counterResult.counter,
        resetDate: counterResult.resetDate,
      }, origin)
    }

    // Generate item
    const itemId = randomUUID()
    const now = new Date().toISOString()
    let documentStatus = null
    let documentKey = null

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
      documentKey = s3Key
      log('info', 'CreateItem: stored content in S3', { requestId, tenantId, itemId })
    }

    // Build DynamoDB item
    const dynamoItem = {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
      itemName: { S: itemName.trim() },
      description: { S: description.trim() },
      closeDate: { S: closeDateUTC },
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

    if (documentKey) {
      dynamoItem.documentKey = { S: documentKey }
    }

    // Store feedbackSections if provided (5.4)
    if (Array.isArray(feedbackSections) && feedbackSections.length > 0) {
      dynamoItem.feedbackSections = { L: feedbackSections.map(s => ({ S: String(s) })) }
    }

    // Store sectionDepthPreferences if provided (5.4)
    if (sectionDepthPreferences && typeof sectionDepthPreferences === 'object') {
      const m = {}
      for (const [key, val] of Object.entries(sectionDepthPreferences)) {
        m[key] = { S: String(val) }
      }
      dynamoItem.sectionDepthPreferences = { M: m }
    }

    // Set itemType based on request or default to document (5.4)
    const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
    const resolvedItemType = requestedItemType && IMAGE_MIME_TYPES.has(requestedItemType) ? 'image' : 'document'
    dynamoItem.itemType = { S: resolvedItemType }

    // For image items: set totalSections to 1 and recommendedTimeLimitMinutes to 7 (5.4)
    if (resolvedItemType === 'image') {
      dynamoItem.totalSections = { N: '1' }
      dynamoItem.recommendedTimeLimitMinutes = { N: '7' }
    }

    // Store templateGreeting for markdown/text items (two-phase-session-start — R3.1, R3.2)
    if (documentStatus === 'ready') {
      const greetingName = itemName.trim() || 'your document'
      const greeting = buildTemplateGreeting('document', greetingName)
      dynamoItem.templateGreeting = { S: greeting }
    }

    await dynamo.send(new PutItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Item: dynamoItem,
    }))

    // Schedule auto-close if closeDate is set (Slice 3 — R1.1)
    if (closeDateUTC) {
      try {
        await upsertCloseSchedule(itemId, tenantId, closeDateUTC)
        log('info', 'CreateItem: close schedule created', { requestId, tenantId, itemId })
      } catch (err) {
        log('warn', 'CreateItem: failed to create close schedule (non-fatal)', { requestId, tenantId, itemId, errorName: err.name })
      }
    }

    // Invoke analyzeDocument async if document content was stored (5.4)
    if (documentStatus === 'ready' && resolvedItemType !== 'image' && process.env.ANALYZE_DOCUMENT_FUNCTION_ARN) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.ANALYZE_DOCUMENT_FUNCTION_ARN,
          InvocationType: 'Event',
          Payload: JSON.stringify({ itemId, tenantId }),
        }))
        log('info', 'CreateItem: analyzeDocument invoked async', { requestId, tenantId, itemId })
      } catch (err) {
        log('warn', 'CreateItem: failed to invoke analyzeDocument', { requestId, tenantId, itemId, errorName: err.name })
      }
    }

    log('info', 'CreateItem: item created', { requestId, tenantId, itemId })

    return createResponse(201, {
      data: {
        tenantId,
        itemId,
        itemName: itemName.trim(),
        description: description.trim(),
        closeDate: closeDateUTC,
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
