// ur/gd pulse — Get Item Lambda
// GET /api/manage/items/{itemId} → returns single item for tenant

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
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

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'GetItem: missing tenantId in authorizer context', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'Missing itemId', {}, origin)
  }

  log('info', 'GetItem: fetching item', { requestId, tenantId, itemId })

  try {
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!result.Item) {
      log('warn', 'GetItem: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const item = unmarshal(result.Item)

    // Verify item belongs to this tenant (belt-and-suspenders)
    if (item.tenantId !== tenantId) {
      log('warn', 'GetItem: tenant mismatch', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    return createResponse(200, { data: item }, {}, origin)
  } catch (err) {
    log('error', 'GetItem: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve item', {}, origin)
  }
}
