// ur/gd pulse — Get Public Session QR Lambda
// GET /api/manage/items/{itemId}/sessions/{sessionId}/qr
// Returns a fresh presigned S3 URL for the public session QR code PNG

import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['SESSIONS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId
  const sessionId = event?.pathParameters?.sessionId

  if (!tenantId) {
    log('warn', 'GetPublicSessionQr: missing tenantId', { requestId })
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId || !sessionId) {
    return errorResponse(400, 'itemId and sessionId are required', {}, origin)
  }

  try {
    // Look up session via sessionId-index GSI
    const result = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'sessionId-index',
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      Limit: 1,
    }))

    const sessionRecord = result.Items?.[0]

    if (!sessionRecord) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    // Verify ownership and that it's a public session belonging to this tenant/item
    if (sessionRecord.tenantId?.S !== tenantId || sessionRecord.itemId?.S !== itemId) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    if (sessionRecord.isPublic?.BOOL !== true) {
      return errorResponse(400, 'Session is not a public session', {}, origin)
    }

    // Reconstruct the S3 key — same pattern as createPublicSession
    const qrKey = `pulse/${tenantId}/items/${itemId}/qr/public-${sessionId}.png`

    const qrCodeUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: qrKey }),
      { expiresIn: 3600 }
    )

    log('info', 'GetPublicSessionQr: presigned URL generated', { requestId, tenantId, itemId, sessionId })

    return createResponse(200, {
      qrCodeUrl,
      pulseCode: sessionRecord.pulseCode?.S ?? '',
      sessionLink: `${process.env.APP_URL}/s/${sessionId}?public=1`,
      sessionName: sessionRecord.sessionName?.S ?? null,
    }, {}, origin)
  } catch (err) {
    log('error', 'GetPublicSessionQr: unexpected error', { requestId, tenantId, itemId, sessionId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve QR code', {}, origin)
  }
}
