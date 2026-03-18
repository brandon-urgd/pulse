// ur/gd pulse — Shield Callback Lambda
// Triggered by EventBridge on S3 object tag change (GuardDuty scan result)

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectTaggingCommand } from '@aws-sdk/client-s3'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { log, requireEnv } from './shared/utils.mjs'

// Fail-fast env var validation
requireEnv(['ITEMS_TABLE', 'QUARANTINE_BUCKET_NAME', 'DATA_BUCKET_NAME', 'EXTRACT_TEXT_FUNCTION_NAME', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

const TEXT_EXTENSIONS = new Set(['.md', '.txt'])
const EXTRACT_EXTENSIONS = new Set(['.pdf', '.docx'])

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
 * Extract tenantId and itemId from S3 key path: pulse/{tenantId}/items/{itemId}/...
 */
function extractIdsFromKey(key) {
  // Expected format: pulse/{tenantId}/items/{itemId}/{filename}
  const parts = key.split('/')
  if (parts.length < 5 || parts[0] !== 'pulse' || parts[2] !== 'items') {
    return { tenantId: null, itemId: null }
  }
  return { tenantId: parts[1], itemId: parts[3] }
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
  const bucketName = event?.detail?.bucket?.name
  const objectKey = event?.detail?.object?.key

  if (!bucketName || !objectKey) {
    log('error', 'ShieldCallback: missing bucket or key in event', { bucketName, objectKey })
    return
  }

  // Fetch tags from S3 — the EventBridge "Object Tags Added" event does NOT include
  // tag values in the payload. We must call GetObjectTagging to read the scan result.
  let scanResult = ''
  try {
    const tagsResp = await s3.send(new GetObjectTaggingCommand({
      Bucket: bucketName,
      Key: objectKey,
    }))
    const tags = Object.fromEntries(tagsResp.TagSet.map(t => [t.Key, t.Value]))
    scanResult = tags['GuardDutyMalwareScanStatus'] ?? ''
  } catch (err) {
    log('error', 'ShieldCallback: failed to fetch object tags', { bucketName, objectKey, errorName: err.name })
    throw err
  }

  const { tenantId, itemId } = extractIdsFromKey(objectKey)

  if (!tenantId || !itemId) {
    log('error', 'ShieldCallback: could not extract tenantId/itemId from key', { key: objectKey })
    return
  }

  log('info', 'ShieldCallback: processing scan result', { tenantId, itemId, scanResult, key: objectKey })

  if (scanResult === 'NO_THREATS_FOUND') {
    try {
      // Move file from quarantine to data bucket (copy + delete)
      await s3.send(new CopyObjectCommand({
        CopySource: `${process.env.QUARANTINE_BUCKET_NAME}/${objectKey}`,
        Bucket: process.env.DATA_BUCKET_NAME,
        Key: objectKey,
      }))

      await s3.send(new DeleteObjectCommand({
        Bucket: process.env.QUARANTINE_BUCKET_NAME,
        Key: objectKey,
      }))

      log('info', 'ShieldCallback: file moved to data bucket', { tenantId, itemId, key: objectKey })

      const ext = getExtension(objectKey)

      if (TEXT_EXTENSIONS.has(ext)) {
        // .md or .txt — mark as ready
        await updateDocumentStatus(tenantId, itemId, 'ready')
        log('info', 'ShieldCallback: documentStatus set to ready', { tenantId, itemId })
      } else if (EXTRACT_EXTENSIONS.has(ext)) {
        // .pdf or .docx — mark as extracting, invoke extractText async
        await updateDocumentStatus(tenantId, itemId, 'extracting')
        log('info', 'ShieldCallback: documentStatus set to extracting', { tenantId, itemId })

        const payload = JSON.stringify({
          tenantId,
          itemId,
          key: objectKey,
          bucket: process.env.DATA_BUCKET_NAME,
        })

        await lambda.send(new InvokeCommand({
          FunctionName: process.env.EXTRACT_TEXT_FUNCTION_NAME,
          InvocationType: 'Event', // async invocation
          Payload: Buffer.from(payload),
        }))

        log('info', 'ShieldCallback: extractText invoked async', { tenantId, itemId })
      } else {
        // Unknown extension — still mark as ready
        await updateDocumentStatus(tenantId, itemId, 'ready')
        log('warn', 'ShieldCallback: unknown extension, marking ready', { tenantId, itemId, ext })
      }
    } catch (err) {
      log('error', 'ShieldCallback: error processing clean file', { tenantId, itemId, errorName: err.name })
      throw err
    }
  } else if (scanResult === 'THREATS_FOUND') {
    try {
      // Delete file from quarantine
      await s3.send(new DeleteObjectCommand({
        Bucket: process.env.QUARANTINE_BUCKET_NAME,
        Key: objectKey,
      }))

      // Update documentStatus to rejected
      await updateDocumentStatus(tenantId, itemId, 'rejected')

      // Log security event — no PII, only tenantId, itemId, key
      log('warn', 'ShieldCallback: THREATS_FOUND — file rejected', { tenantId, itemId, key: objectKey })
    } catch (err) {
      log('error', 'ShieldCallback: error processing threat', { tenantId, itemId, errorName: err.name })
      throw err
    }
  } else {
    log('warn', 'ShieldCallback: unknown scan result', { tenantId, itemId, scanResult, key: objectKey })
  }
}
