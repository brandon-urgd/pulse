// ur/gd pulse — Get Session Summary Lambda
// GET /api/session/{sessionId}/summary
// Returns the AI-generated session summary after completion

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

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

    log('info', 'GetSessionSummary: success', { requestId, sessionId, tenantId })

    return createResponse(200, {
      data: {
        summary,
        tenantName,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GetSessionSummary: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to get session summary', {}, origin)
  }
}
