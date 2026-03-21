// ur/gd pulse — Save Pulse Check Decisions Lambda
// PUT /api/manage/items/{itemId}/pulse-check/decisions
// Validates themeIds, updates decisions map — partial saves allowed

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['PULSE_CHECKS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

const VALID_ACTIONS = ['Accept', 'Adjust', 'Revise', 'Dismiss']

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { decisions } = body

  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions)) {
    return errorResponse(400, 'decisions must be an object keyed by themeId', {}, origin)
  }

  const decisionEntries = Object.entries(decisions)
  if (decisionEntries.length === 0) {
    return errorResponse(400, 'decisions must not be empty', {}, origin)
  }

  // Validate all action values
  for (const [themeId, decision] of decisionEntries) {
    if (!decision || typeof decision !== 'object') {
      return errorResponse(400, `Invalid decision for themeId: ${themeId}`, {}, origin)
    }
    if (!VALID_ACTIONS.includes(decision.action)) {
      return errorResponse(400, `Invalid action '${decision.action}' for themeId: ${themeId}. Must be one of: ${VALID_ACTIONS.join(', ')}`, {}, origin)
    }
  }

  try {
    // 1. Get pulse check to validate revisionIds exist
    const pcResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      ProjectionExpression: 'proposedRevisions',
    }))

    if (!pcResult.Item) {
      return errorResponse(404, 'Pulse check not found', {}, origin)
    }

    // Extract valid revisionIds from proposedRevisions
    const validRevisionIds = new Set(
      (pcResult.Item.proposedRevisions?.L || []).map(r => r.M?.revisionId?.S).filter(Boolean)
    )

    // Validate all submitted revisionIds exist
    const invalidRevisionIds = decisionEntries
      .map(([revisionId]) => revisionId)
      .filter(revisionId => !validRevisionIds.has(revisionId))

    if (invalidRevisionIds.length > 0) {
      log('warn', 'SavePCDecisions: invalid revisionIds', { requestId, tenantId, itemId, invalidRevisionIds })
      return errorResponse(400, `Invalid revisionId(s): ${invalidRevisionIds.join(', ')}`, {}, origin)
    }

    // 2. Build update expression for partial save — only update submitted decisions
    const now = new Date().toISOString()
    const updateParts = []
    const expressionNames = {}
    const expressionValues = {}

    expressionNames['#decisions'] = 'decisions'
    expressionValues[':emptyMap'] = { M: {} }

    decisionEntries.forEach(([themeId, decision], idx) => {
      const nameKey = `#d${idx}`
      const valueKey = `:d${idx}`
      expressionNames[nameKey] = themeId
      expressionValues[valueKey] = {
        M: {
          action: { S: decision.action },
          tenantNote: { S: decision.tenantNote || '' },
          decidedAt: { S: now },
        },
      }
      updateParts.push(`#decisions.${nameKey} = ${valueKey}`)
    })

    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression: `SET #decisions = if_not_exists(#decisions, :emptyMap), ${updateParts.join(', ')}`,
      ExpressionAttributeNames: expressionNames,
      ExpressionAttributeValues: expressionValues,
    }))

    log('info', 'SavePCDecisions: decisions saved', {
      requestId, tenantId, itemId, decisionsCount: decisionEntries.length,
    })

    return createResponse(200, { data: { decisionsCount: decisionEntries.length } }, {}, origin)
  } catch (err) {
    log('error', 'SavePCDecisions: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to save decisions', {}, origin)
  }
}
