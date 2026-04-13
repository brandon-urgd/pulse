// ur/gd pulse — Extract Text Lambda
// Reads PDF or DOCX from data bucket, extracts text, stores as extracted.md

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'DATA_BUCKET_NAME'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

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

      // Check maxDocumentPages feature flag
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

          const pagesResult = resolveFeature(tenantRecord, 'maxDocumentPages', systemRecord)
          if (!pagesResult.allowed) {
            log('warn', 'ExtractText: maxDocumentPages feature blocked', { tenantId, itemId, reason: pagesResult.reason })
            await updateDocumentStatus(tenantId, itemId, 'extraction_failed')
            return
          }
          if (pagesResult.limit && pdfData.numpages > pagesResult.limit) {
            log('warn', 'ExtractText: document exceeds page limit', { tenantId, itemId, pages: pdfData.numpages, limit: pagesResult.limit })
            await updateDocumentStatus(tenantId, itemId, 'extraction_failed')
            return
          }
        } catch (err) {
          log('warn', 'ExtractText: failed to check maxDocumentPages, proceeding', { tenantId, itemId, errorName: err.name })
        }
      }

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
    // ~130 wpm reading pace for review content
    // Snap to bracket midpoints: 12 (10–15 min), 17 (15–20 min), 25 (20–30 min), 37 (30–45 min)
    const wordCount = extractedText.trim().split(/\s+/).filter(Boolean).length
    const rawMinutes = Math.round(wordCount / 130)
    const BRACKETS = [12, 17, 25, 37]
    const recommendedTimeLimitMinutes = BRACKETS.reduce((best, b) =>
      Math.abs(b - rawMinutes) < Math.abs(best - rawMinutes) ? b : best
    , BRACKETS[0])

    // Update documentStatus to "ready", store extractedKey and recommendation
    await updateDocumentStatus(tenantId, itemId, 'ready', {
      extractedKey: { S: extractedKey },
      recommendedTimeLimitMinutes: { N: String(recommendedTimeLimitMinutes) },
      itemType: { S: 'document' },
    })

    log('info', 'ExtractText: extraction complete', { tenantId, itemId, extractedKey, recommendedTimeLimitMinutes })

    // Invoke analyzeDocument async to generate section map
    if (process.env.ANALYZE_DOCUMENT_FUNCTION_ARN) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.ANALYZE_DOCUMENT_FUNCTION_ARN,
          InvocationType: 'Event',
          Payload: JSON.stringify({ itemId, tenantId }),
        }))
        log('info', 'ExtractText: analyzeDocument invoked async', { tenantId, itemId })
      } catch (invokeErr) {
        log('warn', 'ExtractText: failed to invoke analyzeDocument', { tenantId, itemId, errorName: invokeErr.name })
      }
    }

    // Invoke renderPages async for PDF and DOCX files
    if (process.env.RENDER_PAGES_FUNCTION_ARN && (ext === '.pdf' || ext === '.docx')) {
      try {
        // Resolve maxDocumentPages limit for the tenant
        let maxDocumentPages = 20 // conservative default
        if (process.env.TENANTS_TABLE) {
          try {
            const [tenantFetch, systemFetch] = await Promise.all([
              dynamo.send(new GetItemCommand({
                TableName: process.env.TENANTS_TABLE,
                Key: { tenantId: { S: tenantId } },
              })),
              dynamo.send(new GetItemCommand({
                TableName: process.env.TENANTS_TABLE,
                Key: { tenantId: { S: 'SYSTEM' } },
              })),
            ])
            const tr = tenantFetch.Item ? {
              tier: tenantFetch.Item.tier?.S ?? 'free',
              features: unmarshalFeatures(tenantFetch.Item.features?.M),
              serviceFlags: unmarshalFeatures(tenantFetch.Item.serviceFlags?.M),
            } : { tier: 'free', features: {}, serviceFlags: {} }
            const sr = systemFetch.Item ? { serviceFlags: unmarshalFeatures(systemFetch.Item.serviceFlags?.M) } : null
            const pagesRes = resolveFeature(tr, 'maxDocumentPages', sr)
            if (pagesRes.limit) maxDocumentPages = pagesRes.limit
          } catch (flagErr) {
            log('warn', 'ExtractText: failed to resolve maxDocumentPages for renderPages, using default', { tenantId, itemId, errorName: flagErr.name })
          }
        }

        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.RENDER_PAGES_FUNCTION_ARN,
          InvocationType: 'Event',
          Payload: JSON.stringify({ tenantId, itemId, key, bucket, maxDocumentPages }),
        }))
        log('info', 'ExtractText: renderPages invoked async', { tenantId, itemId, maxDocumentPages })
      } catch (invokeErr) {
        log('warn', 'ExtractText: failed to invoke renderPages', { tenantId, itemId, errorName: invokeErr.name })
      }
    }
  } catch (err) {
    log('error', 'ExtractText: extraction failed', { tenantId, itemId, errorName: err.name })

    try {
      await updateDocumentStatus(tenantId, itemId, 'extraction_failed')
    } catch (updateErr) {
      log('error', 'ExtractText: failed to update status to extraction_failed', { tenantId, itemId, errorName: updateErr.name })
    }
  }
}
