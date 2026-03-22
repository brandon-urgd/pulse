// ur/gd pulse — Extract Text Lambda
// Reads PDF or DOCX from data bucket, extracts text, stores as extracted.md

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'DATA_BUCKET_NAME'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Extract file extension (lowercase, including dot) from S3 key.
 */
function getExtension(key) {
  if (!key || typeof key !== 'string') return ''
  const lastDot = key.lastIndexOf('.')
  if (lastDot === -1) return ''
  return key.slice(lastDot).toLowerCase()
}

/**
 * Stream S3 object body to a Buffer.
 */
async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * Update item documentStatus in DynamoDB.
 */
async function updateDocumentStatus(tenantId, itemId, status, extraAttrs = {}) {
  let updateExpr = 'SET documentStatus = :status, updatedAt = :now'
  const exprValues = {
    ':status': { S: status },
    ':now': { S: new Date().toISOString() },
  }

  for (const [attr, value] of Object.entries(extraAttrs)) {
    updateExpr += `, ${attr} = :${attr}`
    exprValues[`:${attr}`] = value
  }

  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.ITEMS_TABLE,
    Key: {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
    },
    UpdateExpression: updateExpr,
    ExpressionAttributeValues: exprValues,
  }))
}

export const handler = async (event) => {
  const { tenantId, itemId, key, bucket } = event

  if (!tenantId || !itemId || !key || !bucket) {
    log('error', 'ExtractText: missing required event fields', { tenantId, itemId, key, bucket })
    return
  }

  log('info', 'ExtractText: starting extraction', { tenantId, itemId, key })

  const ext = getExtension(key)

  try {
    // Fetch file from S3
    const getResult = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }))

    const fileBuffer = await streamToBuffer(getResult.Body)

    let extractedText = ''

    if (ext === '.pdf') {
      // Dynamically import pdf-parse to avoid issues with module loading
      const pdfParse = (await import('pdf-parse')).default
      const pdfData = await pdfParse(fileBuffer)
      extractedText = pdfData.text
    } else if (ext === '.docx') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ buffer: fileBuffer })
      extractedText = result.value
    } else {
      log('warn', 'ExtractText: unsupported extension', { tenantId, itemId, ext })
      await updateDocumentStatus(tenantId, itemId, 'extraction_failed')
      return
    }

    // Store extracted text at pulse/{tenantId}/items/{itemId}/extracted.md
    const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
    await s3.send(new PutObjectCommand({
      Bucket: process.env.DATA_BUCKET_NAME,
      Key: extractedKey,
      Body: extractedText,
      ContentType: 'text/markdown',
    }))

    // Estimate recommended session time from word count
    // ~130 wpm reading pace for review content; short ≥5 min, long ≤60 min
    const wordCount = extractedText.trim().split(/\s+/).filter(Boolean).length
    const rawMinutes = Math.round(wordCount / 130)
    const recommendedTimeLimitMinutes = Math.min(60, Math.max(5, rawMinutes))

    // Update documentStatus to "ready", store extractedKey and recommendation
    await updateDocumentStatus(tenantId, itemId, 'ready', {
      extractedKey: { S: extractedKey },
      recommendedTimeLimitMinutes: { N: String(recommendedTimeLimitMinutes) },
    })

    log('info', 'ExtractText: extraction complete', { tenantId, itemId, extractedKey, recommendedTimeLimitMinutes })
  } catch (err) {
    log('error', 'ExtractText: extraction failed', { tenantId, itemId, errorName: err.name })

    try {
      await updateDocumentStatus(tenantId, itemId, 'extraction_failed')
    } catch (updateErr) {
      log('error', 'ExtractText: failed to update status to extraction_failed', { tenantId, itemId, errorName: updateErr.name })
    }
  }
}
