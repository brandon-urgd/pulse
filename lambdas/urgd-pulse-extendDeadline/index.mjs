// ur/gd pulse — Extend Deadline Lambda
// PUT /api/manage/items/{itemId}/deadline → extends item closeDate and updates active sessions

import { DynamoDBClient, GetItemCommand, UpdateItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { upsertCloseSchedule } from './shared/scheduleClose.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

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

function isValidISODate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return false
  const d = new Date(dateStr)
  return !isNaN(d.getTime())
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'ExtendDeadline: missing tenantId in authorizer context', { requestId })
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

  const { closeDate } = body

  if (!isValidISODate(closeDate)) {
    return errorResponse(400, 'closeDate must be a valid ISO date string', {}, origin)
  }

  const newCloseDate = new Date(closeDate)
  const now = new Date()

  if (newCloseDate.getTime() <= now.getTime()) {
    return errorResponse(400, 'Close date must be in the future', {}, origin)
  }

  // Normalize closeDate to UTC ISO 8601 (Slice 3 — R3.4)
  const closeDateUTC = newCloseDate.toISOString()

  try {
    const existing = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
    }))

    if (!existing.Item) {
      log('warn', 'ExtendDeadline: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const currentItem = unmarshal(existing.Item)

    // Validate the new date differs from the current closeDate
    if (currentItem.closeDate) {
      const currentCloseDate = new Date(currentItem.closeDate)
      if (newCloseDate.getTime() === currentCloseDate.getTime()) {
        return errorResponse(400, 'New close date is the same as the current close date', {}, origin)
      }
    }

    const nowIso = now.toISOString()

    const updateResult = await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
      UpdateExpression: 'SET #closeDate = :closeDate, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#closeDate': 'closeDate',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':closeDate': { S: closeDateUTC },
        ':updatedAt': { S: nowIso },
      },
      ReturnValues: 'ALL_NEW',
    }))

    const updatedItem = unmarshal(updateResult.Attributes)

    // Query all sessions for this item via item-index GSI
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :iid',
      ExpressionAttributeValues: { ':iid': { S: itemId } },
    }))

    const sessions = sessionsResult.Items ?? []
    const SKIP_STATUSES = new Set(['completed', 'expired'])

    const updatePromises = sessions
      .filter(s => !SKIP_STATUSES.has(s.status?.S ?? ''))
      .map(s => {
        const sessionId = s.sessionId?.S
        if (!sessionId) return null
        return dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: {
            tenantId: { S: tenantId },
            sessionId: { S: sessionId },
          },
          UpdateExpression: 'SET #expiresAt = :expiresAt',
          ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
          ExpressionAttributeValues: { ':expiresAt': { S: closeDateUTC } },
        }))
      })
      .filter(Boolean)

    await Promise.all(updatePromises)

    // Update the EventBridge close schedule with the new deadline (Slice 3 — R1.3)
    try {
      await upsertCloseSchedule(itemId, tenantId, closeDateUTC)
      log('info', 'ExtendDeadline: close schedule updated', { requestId, tenantId, itemId })
    } catch (err) {
      log('warn', 'ExtendDeadline: failed to update close schedule (non-fatal)', { requestId, tenantId, itemId, errorName: err.name })
    }

    log('info', 'ExtendDeadline: deadline extended', {
      requestId,
      tenantId,
      itemId,
      sessionsUpdated: updatePromises.length,
    })

    return createResponse(200, { data: updatedItem }, {}, origin)
  } catch (err) {
    log('error', 'ExtendDeadline: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to extend deadline', {}, origin)
  }
}
