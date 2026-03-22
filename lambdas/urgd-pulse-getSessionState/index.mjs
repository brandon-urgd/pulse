// ur/gd pulse — Get Session State Lambda
// GET /api/session/{sessionId}/state
// Returns current session state including transcript history

import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { createHash } from 'crypto'

requireEnv(['SESSIONS_TABLE', 'TRANSCRIPTS_TABLE', 'ITEMS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

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
    const itemId = session.itemId?.S
    const currentSection = parseInt(session.currentSection?.N || '1', 10)
    const totalSections = parseInt(session.totalSections?.N || '5', 10)
    const status = session.status?.S || 'not_started'
    const timeLimitMinutes = parseInt(session.timeLimitMinutes?.N || '30', 10)
    const closingState = session.closingState?.S || 'exploring'

    // 2. Query all transcripts ordered by ULID ascending
    const transcriptResult = await dynamo.send(new QueryCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      ScanIndexForward: true,
    }))

    let messages = (transcriptResult.Items || []).map(item => ({
      role: item.role?.S || 'agent',
      content: item.content?.S || '',
      timestamp: item.timestamp?.S || '',
    }))

    // Defensive: strip unpaired trailing reviewer message (orphan from failed Bedrock call)
    if (messages.length > 0 && messages[messages.length - 1].role === 'reviewer') {
      log('warn', 'GetSessionState: stripping orphaned reviewer message', { requestId, sessionId, tenantId })
      messages = messages.slice(0, -1)
    }

    // 3. Get item record to build files array
    let files = []
    if (itemId && tenantId) {
      try {
        const itemResult = await dynamo.send(new GetItemCommand({
          TableName: process.env.ITEMS_TABLE,
          Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        }))

        if (itemResult.Item) {
          const item = itemResult.Item
          const documentKey = item.documentKey?.S
          const documentStatus = item.documentStatus?.S

          // 4. Build files array
          if (documentKey && documentStatus !== 'none' && documentStatus) {
            const filename = documentKey.split('/').pop() || 'document'
            const ext = filename.split('.').pop()?.toLowerCase() || ''
            const contentTypeMap = {
              pdf: 'application/pdf',
              docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              md: 'text/markdown',
              txt: 'text/plain',
            }
            files = [{
              fileId: hashKey(documentKey),
              filename,
              contentType: contentTypeMap[ext] || 'application/octet-stream',
            }]
          }
        }
      } catch (itemErr) {
        log('warn', 'GetSessionState: failed to load item', { requestId, sessionId, tenantId, errorName: itemErr.name })
      }
    }

    log('info', 'GetSessionState: success', { requestId, sessionId, tenantId })

    return createResponse(200, {
      data: {
        currentSection,
        totalSections,
        messages,
        status,
        timeLimitMinutes,
        files,
        closingState,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GetSessionState: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to get session state', {}, origin)
  }
}
