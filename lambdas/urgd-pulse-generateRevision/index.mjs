// ur/gd pulse — Generate Revision Lambda
// POST /api/manage/items/{itemId}/revise
//
// Checks itemRevisionLoop feature flag, validates pulse check exists,
// loads original document from S3, sends to Bedrock with decisions,
// stores revised document at a unique revisionId path.
// Original document is NEVER modified — revision is stored at a separate path.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { randomUUID } from 'crypto'

requireEnv([
  'PULSE_CHECKS_TABLE', 'ITEMS_TABLE', 'TENANTS_TABLE',
  'DATA_BUCKET', 'BEDROCK_MODEL_ID', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })

// X-Ray annotations — gracefully no-ops outside Lambda environment
async function addXRayAnnotations(annotations) {
  try {
    if (!process.env._X_AMZN_TRACE_ID) return
    const xray = await import('aws-xray-sdk-core')
    const segment = xray.getSegment()
    if (segment) {
      for (const [key, value] of Object.entries(annotations)) {
        segment.addAnnotation(key, String(value))
      }
    }
  } catch {
    // X-Ray SDK not available (local/test) — safe to ignore
  }
}

async function putMetrics(metrics) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Revision',
      MetricData: metrics,
    }))
  } catch (err) {
    log('warn', 'GenerateRevision: failed to publish CloudWatch metrics', { errorName: err.name })
  }
}

async function getS3Text(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const chunks = []
    for await (const chunk of res.Body) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf-8')
  } catch {
    return null
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // 1. Check itemRevisionLoop feature flag
    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.TENANTS_TABLE,
      Key: { tenantId: { S: tenantId } },
      ProjectionExpression: 'features',
    }))

    const features = tenantResult.Item?.features?.M ?? {}
    const revisionEnabled = features.itemRevisionLoop?.BOOL !== false

    if (!revisionEnabled) {
      log('info', 'GenerateRevision: itemRevisionLoop flag is off', { requestId, tenantId, itemId })
      return errorResponse(403, 'Item revision is not enabled for your account', {}, origin)
    }

    // 2. Get pulse check — must exist and be complete
    const pulseCheckResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!pulseCheckResult.Item || pulseCheckResult.Item.status?.S !== 'complete') {
      log('info', 'GenerateRevision: no completed pulse check', { requestId, tenantId, itemId })
      return errorResponse(409, 'Pulse check must be completed before revising.', {}, origin)
    }

    const pulseCheck = pulseCheckResult.Item

    // 3. Get item record for name
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      ProjectionExpression: 'itemName',
    }))

    const itemName = itemResult.Item?.itemName?.S ?? 'Untitled Item'

    // 4. Load original document from S3 — extracted.md if exists, else document.md
    // IMPORTANT: We only READ the original — never write to it
    const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
    const documentKey = `pulse/${tenantId}/items/${itemId}/document.md`

    const originalContent = await getS3Text(process.env.DATA_BUCKET, extractedKey)
      || await getS3Text(process.env.DATA_BUCKET, documentKey)

    if (!originalContent) {
      log('warn', 'GenerateRevision: no document found in S3', { requestId, tenantId, itemId })
      return errorResponse(404, 'No document found for this item', {}, origin)
    }

    // 5. Extract decisions from pulse check
    const decisionsMap = pulseCheck.decisions?.M ?? {}
    const feedbackPoints = pulseCheck.feedbackPoints?.L ?? []

    const acceptedOrRevised = feedbackPoints
      .filter(fp => {
        const fpId = fp.M?.feedbackPointId?.S
        const decision = fpId ? decisionsMap[fpId]?.M : null
        return decision && (decision.action?.S === 'accept' || decision.action?.S === 'revise')
      })
      .map(fp => {
        const fpId = fp.M?.feedbackPointId?.S
        const decision = decisionsMap[fpId]?.M
        return {
          feedbackPointId: fpId,
          text: fp.M?.text?.S ?? '',
          section: fp.M?.section?.S ?? '',
          action: decision?.action?.S ?? 'accept',
          tenantNote: decision?.tenantNote?.S ?? '',
        }
      })

    if (acceptedOrRevised.length === 0) {
      log('info', 'GenerateRevision: no accepted/revised decisions', { requestId, tenantId, itemId })
      return errorResponse(409, 'No accepted or revised decisions found. Accept or revise at least one feedback point before generating a revision.', {}, origin)
    }

    // 6. Build Bedrock prompt
    const decisionsText = acceptedOrRevised.map((d, i) => {
      const noteText = d.tenantNote ? `\n   Tenant note: "${d.tenantNote}"` : ''
      return `${i + 1}. [${d.action.toUpperCase()}] ${d.text}${noteText}`
    }).join('\n')

    const prompt = `You are a professional document editor. Your task is to revise the following document based on the feedback decisions provided.

CRITICAL RULES:
- Only incorporate the ACCEPTED and REVISED feedback points listed below
- For ACCEPT decisions: incorporate the feedback as-is into the document
- For REVISE decisions: incorporate the feedback with any tenant notes as guidance
- Preserve the document's original structure, voice, and formatting
- Do not add new sections or content not implied by the feedback
- Do not remove sections unless explicitly indicated by the feedback
- Return ONLY the revised document text — no preamble, no explanation, no metadata

Original Document:
---
${originalContent}
---

Feedback Decisions to Incorporate:
${decisionsText}

Revised Document:`

    // 7. Invoke Bedrock
    const bedrockStart = Date.now()
    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    }))

    const bedrockLatency = Date.now() - bedrockStart
    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const revisedContent = responseBody.content?.[0]?.text ?? ''
    const tokensIn = responseBody.usage?.input_tokens ?? 0
    const tokensOut = responseBody.usage?.output_tokens ?? 0

    // Annotate X-Ray trace
    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: tokensIn,
      bedrockTokensOut: tokensOut,
    })

    // 8. Store revised document at unique path — original document is NEVER touched
    const revisionId = randomUUID()
    const revisionKey = `pulse/${tenantId}/items/${itemId}/revisions/${revisionId}/document.md`
    const createdAt = new Date().toISOString()

    await s3.send(new PutObjectCommand({
      Bucket: process.env.DATA_BUCKET,
      Key: revisionKey,
      Body: revisedContent,
      ContentType: 'text/markdown',
      Metadata: {
        'tenant-id': tenantId,
        'item-id': itemId,
        'revision-id': revisionId,
        'created-at': createdAt,
      },
    }))

    // 9. Update item status to "revised"
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression: 'SET #status = :revised, updatedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':revised': { S: 'revised' },
        ':now': { S: createdAt },
      },
    }))

    // 10. Publish CloudWatch metrics
    await putMetrics([
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
    ])

    log('info', 'GenerateRevision: revision stored', {
      requestId, tenantId, itemId, revisionId,
      bedrockLatency, tokensIn, tokensOut,
      modelId: process.env.BEDROCK_MODEL_ID,
    })

    return createResponse(200, {
      data: {
        revisionId,
        itemId,
        itemName,
        revisionKey,
        createdAt,
        decisionsApplied: acceptedOrRevised.length,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'GenerateRevision: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])

    if (err.name === 'AccessDeniedException' || err.name === 'ThrottlingException' || err.name === 'ServiceUnavailableException') {
      return errorResponse(503, 'AI service temporarily unavailable', {}, origin)
    }
    return errorResponse(500, 'Failed to generate revision', {}, origin)
  }
}
