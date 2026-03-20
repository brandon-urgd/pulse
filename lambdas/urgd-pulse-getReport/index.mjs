// ur/gd pulse — Get Report Lambda
// GET /api/manage/items/{itemId}/sessions/{sessionId}/report
// Returns structured feedback report for a completed session

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['REPORTS_TABLE', 'SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const sessionId = event?.pathParameters?.sessionId

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!sessionId) {
    return errorResponse(400, 'sessionId is required', {}, origin)
  }

  try {
    // 1. Get session to verify it's completed
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const status = sessionResult.Item.status?.S
    if (status !== 'completed') {
      log('info', 'GetReport: session not completed', { requestId, sessionId, tenantId, status })
      return errorResponse(409, 'Report not available — session is not completed', {}, origin)
    }

    // 2. Get report
    const reportResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.REPORTS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!reportResult.Item) {
      return errorResponse(404, 'Report not found — it may still be generating', {}, origin)
    }

    const item = reportResult.Item
    const report = {
      sessionId: item.sessionId?.S,
      itemId: item.itemId?.S,
      verdict: item.verdict?.S,
      conviction: (item.conviction?.L || []).map(c => c.S),
      tension: (item.tension?.L || []).map(t => t.S),
      uncertainty: (item.uncertainty?.L || []).map(u => u.S),
      energy: item.energy?.S,
      conversationShape: item.conversationShape?.S,
      themes: (item.themes?.L || []).map(t => t.S),
      isSelfReview: item.isSelfReview?.BOOL === true,
      generatedAt: item.generatedAt?.S,
    }

    log('info', 'GetReport: success', { requestId, sessionId, tenantId })
    return createResponse(200, { data: report }, {}, origin)
  } catch (err) {
    log('error', 'GetReport: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve report', {}, origin)
  }
}
