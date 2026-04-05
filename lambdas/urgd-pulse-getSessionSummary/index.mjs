// ur/gd pulse — Get Session Summary Lambda
// GET /api/session/{sessionId}/summary
// Returns the AI-generated session summary after completion

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const httpMethod = event?.httpMethod ?? event?.requestContext?.httpMethod ?? 'GET'

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  // PATCH — save summary feedback
  if (httpMethod === 'PATCH') {
    try {
      let body
      try { body = JSON.parse(event.body || '{}') } catch { return errorResponse(400, 'Invalid body', {}, origin) }

      const fb = body.summaryFeedback
      if (!fb || (fb.rating !== 'up' && fb.rating !== 'down')) {
        return errorResponse(400, 'summaryFeedback.rating must be up or down', {}, origin)
      }

      const fbMap = {
        rating: { S: fb.rating },
        timestamp: { S: fb.timestamp || new Date().toISOString() },
      }
      if (fb.reason && typeof fb.reason === 'string') {
        fbMap.reason = { S: fb.reason }
      }

      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.SESSIONS_TABLE,
        Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
        UpdateExpression: 'SET summaryFeedback = :fb',
        ExpressionAttributeValues: { ':fb': { M: fbMap } },
      }))

      log('info', 'GetSessionSummary: summaryFeedback saved', { requestId, sessionId, tenantId, rating: fb.rating })
      return createResponse(200, { data: { feedbackSaved: true } }, {}, origin)
    } catch (err) {
      log('error', 'GetSessionSummary: feedback save failed', { requestId, sessionId, tenantId, errorName: err.name })
      return errorResponse(500, 'Failed to save feedback', {}, origin)
    }
  }

  // GET — return summary

  try {
    // 1. Get session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // 2. Check status is completed
    if (session.status?.S !== 'completed') {
      return errorResponse(409, 'Session is not completed', {}, origin)
    }

    // 3. Check summary is generated
    const summaryRaw = session.summary?.S
    if (!summaryRaw) {
      return errorResponse(409, 'Summary not ready', {}, origin)
    }

    let summary
    try {
      summary = JSON.parse(summaryRaw)
    } catch {
      return errorResponse(409, 'Summary not ready', {}, origin)
    }

    const tenantName = session.tenantName?.S || ''

    // Include existing summaryFeedback if present
    let summaryFeedback = undefined
    if (session.summaryFeedback?.M) {
      summaryFeedback = {
        rating: session.summaryFeedback.M.rating?.S,
        reason: session.summaryFeedback.M.reason?.S,
      }
    }

    log('info', 'GetSessionSummary: success', { requestId, sessionId, tenantId })

    return createResponse(200, {
      data: {
        summary,
        tenantName,
        summaryFeedback,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GetSessionSummary: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to get session summary', {}, origin)
  }
}
