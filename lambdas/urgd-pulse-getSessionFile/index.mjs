// ur/gd pulse — Get Session File Lambda
// GET /api/session/{sessionId}/files/{fileId}
// Returns a presigned URL for the session's associated document

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { createHash } from 'crypto'

requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

function hashKey(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  txt: 'text/plain',
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const { fileId } = event.pathParameters || {}

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!fileId) {
    return errorResponse(400, 'fileId is required', {}, origin)
  }

  try {
    // 1. Get session record to find itemId and tenantId
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const itemId = sessionResult.Item.itemId?.S
    if (!itemId) {
      return errorResponse(404, 'No document associated with this session', {}, origin)
    }

    // 2. Get item record to find documentKey
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const documentKey = itemResult.Item.documentKey?.S
    if (!documentKey) {
      return errorResponse(404, 'No document available', {}, origin)
    }

    // 3. Verify fileId matches hash(documentKey)
    if (hashKey(documentKey) !== fileId) {
      return errorResponse(404, 'File not found', {}, origin)
    }

    const filename = documentKey.split('/').pop() || 'document'
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream'

    // 4. Generate presigned GET URL (15-min TTL)
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: documentKey }),
      { expiresIn: 900 }
    )

    const responseData = {
      url: presignedUrl,
      contentType,
      filename,
      fileId,
    }

    // 5. For .docx: also generate presigned URL for extracted.md
    if (ext === 'docx') {
      const extractedKey = documentKey.replace(/\/[^/]+$/, '/extracted.md')
      try {
        const extractedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: extractedKey }),
          { expiresIn: 900 }
        )
        // For docx: url = extracted.md, originalUrl = original binary
        responseData.url = extractedUrl
        responseData.originalUrl = presignedUrl
      } catch {
        // extracted.md may not exist yet, return original only
      }
    }

    log('info', 'GetSessionFile: success', { requestId, sessionId, tenantId, fileId })

    return createResponse(200, { data: responseData }, {}, origin)
  } catch (err) {
    log('error', 'GetSessionFile: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    return errorResponse(500, 'Failed to get session file', {}, origin)
  }
}
