// ur/gd pulse — Get Items Lambda
// GET /api/manage/items → returns all items for tenant sorted by updatedAt descending

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

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
 * Normalize a raw unmarshalled item to guarantee all expected fields are present.
 * Prevents undefined field access on the frontend.
 */
function normalizeItem(raw) {
  if (!raw) return null
  return {
    tenantId: raw.tenantId ?? '',
    itemId: raw.itemId ?? '',
    itemName: raw.itemName ?? '',
    description: raw.description ?? '',
    closeDate: raw.closeDate ?? '',
    status: raw.status ?? 'draft',
    documentStatus: raw.documentStatus ?? 'none',
    sessionCount: typeof raw.sessionCount === 'number' ? raw.sessionCount : 0,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    ...(raw.content !== undefined ? { content: raw.content } : {}),
    ...(raw.documentKey !== undefined ? { documentKey: raw.documentKey } : {}),
    ...(raw.extractedKey !== undefined ? { extractedKey: raw.extractedKey } : {}),
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!tenantId) {
    log('warn', 'GetItems: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  log('info', 'GetItems: querying items', { requestId, tenantId })

  try {
    const result = await dynamo.send(new QueryCommand({
      TableName: process.env.ITEMS_TABLE,
      KeyConditionExpression: 'tenantId = :tid',
      ExpressionAttributeValues: {
        ':tid': { S: tenantId },
      },
    }))

    const items = (result.Items ?? []).map(i => normalizeItem(unmarshal(i)))

    // Sort by updatedAt descending
    items.sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
      return bTime - aTime
    })

    return createResponse(200, { data: items }, {}, origin)
  } catch (err) {
    log('error', 'GetItems: unexpected error', { requestId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve items', {}, origin)
  }
}
