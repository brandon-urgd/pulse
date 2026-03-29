// ur/gd pulse — Get Upload URL Lambda
// POST /api/manage/items/{itemId}/upload-url → validates file type/size, returns presigned PUT URL

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'QUARANTINE_BUCKET_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

function unmarshalFeatures(m) {
  if (!m) return {}
  const result = {}
  for (const [key, val] of Object.entries(m)) {
    if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('S' in val) result[key] = val.S
    else if ('M' in val) result[key] = unmarshalFeatures(val.M)
  }
  return result
}

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx'])
const MAX_FILE_SIZE_DEFAULT = 10 * 1024 * 1024 // 10MB fallback

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
    if (!Number.isFinite(size) || size > MAX_FILE_SIZE_DEFAULT) {
      return errorResponse(400, 'File too large', {}, origin)
    }
  }

  try {
    // Fetch tenant + SYSTEM records for maxUploadSizeMb check
    let maxUploadBytes = MAX_FILE_SIZE_DEFAULT
    if (process.env.TENANTS_TABLE) {
      try {
        const [tenantResult, systemResult] = await Promise.all([
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: tenantId } },
          })),
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: 'SYSTEM' } },
          })),
        ])
        const tenantRecord = tenantResult.Item ? {
          tier: tenantResult.Item.tier?.S ?? 'free',
          features: unmarshalFeatures(tenantResult.Item.features?.M),
          serviceFlags: unmarshalFeatures(tenantResult.Item.serviceFlags?.M),
        } : { tier: 'free', features: {}, serviceFlags: {} }
        const systemRecord = systemResult.Item ? {
          serviceFlags: unmarshalFeatures(systemResult.Item.serviceFlags?.M),
        } : null

        const uploadResult = resolveFeature(tenantRecord, 'maxUploadSizeMb', systemRecord)
        if (!uploadResult.allowed) {
          return errorResponse(
            uploadResult.reason === 'maintenance' ? 503 : 403,
            uploadResult.reason === 'maintenance' ? 'Feature under maintenance' : 'Feature not available on your plan',
            {}, origin
          )
        }
        if (uploadResult.limit) {
          maxUploadBytes = uploadResult.limit * 1024 * 1024
        }
      } catch (err) {
        log('warn', 'GetUploadUrl: failed to check maxUploadSizeMb, using default', { requestId, tenantId, errorName: err.name })
      }
    }

    // Re-validate file size against tier limit
    if (fileSize !== undefined && fileSize !== null) {
      const size = Number(fileSize)
      if (!Number.isFinite(size) || size > maxUploadBytes) {
        return errorResponse(400, 'File too large', {}, origin)
      }
    }

    // Verify item exists and belongs to this tenant before issuing a presigned URL
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))
    if (!itemResult.Item) {
      log('warn', 'GetUploadUrl: item not found', { requestId, tenantId, itemId })
      return errorResponse(404, 'Item not found', {}, origin)
    }

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
