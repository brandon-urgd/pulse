// ur/gd pulse — Get Document URL Lambda
// GET /api/manage/items/{itemId}/document-url
// Returns a presigned URL for the item's document (admin use)

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['ITEMS_TABLE', 'DATA_BUCKET', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  md: 'text/markdown',
  txt: 'text/plain',
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const { itemId } = event.pathParameters || {}

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  try {
    // 1. Get item record, verify tenantId matches
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      return errorResponse(404, 'Item not found', {}, origin)
    }

    const item = itemResult.Item

    // Verify tenantId matches (belt-and-suspenders)
    if (item.tenantId?.S !== tenantId) {
      return errorResponse(403, 'Forbidden', {}, origin)
    }

    // 2. Check documentStatus is ready
    if (item.documentStatus?.S !== 'ready') {
      return errorResponse(404, 'No document available', {}, origin)
    }

    const documentKey = item.documentKey?.S
    if (!documentKey) {
      return errorResponse(404, 'No document available', {}, origin)
    }

    const filename = documentKey.split('/').pop() || 'document'
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream'

    // 3. Generate presigned GET URL (15-min TTL)
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: documentKey }),
      { expiresIn: 900 }
    )

    const responseData = {
      url: presignedUrl,
      contentType,
      filename,
    }

    // 4. For .docx: url = extracted.md presigned URL, originalUrl = original binary
    if (ext === 'docx') {
      const extractedKey = documentKey.replace(/\/[^/]+$/, '/extracted.md')
      try {
        const extractedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: process.env.DATA_BUCKET, Key: extractedKey }),
          { expiresIn: 900 }
        )
        responseData.url = extractedUrl
        responseData.originalUrl = presignedUrl
      } catch {
        // extracted.md may not exist, return original only
      }
    }

    log('info', 'GetDocumentUrl: success', { requestId, tenantId, itemId })

    return createResponse(200, { data: responseData }, {}, origin)
  } catch (err) {
    log('error', 'GetDocumentUrl: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to get document URL', {}, origin)
  }
}
