// ur/gd pulse — Get Upload URL Lambda
// POST /api/manage/items/{itemId}/upload-url → validates file type/size, returns presigned PUT URL

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'QUARANTINE_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx'])
const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * Extract file extension (lowercase, including dot) from filename.
 */
function getExtension(filename) {
  if (!filename || typeof filename !== 'string') return ''
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1) return ''
  return filename.slice(lastDot).toLowerCase()
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'GetUploadUrl: missing tenantId in authorizer context', { requestId })
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

  const { fileName, fileSize } = body

  if (!fileName || typeof fileName !== 'string') {
    return errorResponse(400, 'fileName is required', {}, origin)
  }

  // Validate file type
  const ext = getExtension(fileName)
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return errorResponse(400, 'Unsupported file type', {}, origin)
  }

  // Validate file size
  if (fileSize !== undefined && fileSize !== null) {
    const size = Number(fileSize)
    if (!Number.isFinite(size) || size > MAX_FILE_SIZE) {
      return errorResponse(400, 'File too large', {}, origin)
    }
  }

  try {
    const key = `pulse/${tenantId}/items/${itemId}/${fileName}`

    // Generate presigned PUT URL
    const command = new PutObjectCommand({
      Bucket: process.env.QUARANTINE_BUCKET_NAME,
      Key: key,
      Metadata: {
        'app-name': 'pulse',
        'tenant-id': tenantId,
        'item-id': itemId,
      },
    })

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 })

    // Update item documentStatus to "scanning"
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
      },
      UpdateExpression: 'SET documentStatus = :status, documentKey = :key, updatedAt = :now',
      ExpressionAttributeValues: {
        ':status': { S: 'scanning' },
        ':key': { S: key },
        ':now': { S: new Date().toISOString() },
      },
    }))

    log('info', 'GetUploadUrl: presigned URL generated', { requestId, tenantId, itemId, ext })

    return createResponse(200, { data: { uploadUrl, key } }, {}, origin)
  } catch (err) {
    log('error', 'GetUploadUrl: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to generate upload URL', {}, origin)
  }
}
