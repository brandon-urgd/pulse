// ur/gd pulse — Process Revision Lambda (Worker)
// Invoked async by generateRevision (InvocationType: Event).
// Loads original document from S3, builds Bedrock prompt with accepted/revised decisions,
// stores revised document in S3, updates revision record to 'complete', updates item status.
// No API Gateway integration — never called directly by the frontend.
// Follows the processPulseCheck worker pattern.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { log, requireEnv, unmarshalFeatures } from './shared/utils.mjs'
import { resolveDeliveryMode } from './shared/features.mjs'

requireEnv([
  'PULSE_CHECKS_TABLE', 'ITEMS_TABLE', 'REVISIONS_TABLE',
  'DATA_BUCKET', 'BEDROCK_MODEL_ID',
  'TENANTS_TABLE', 'SEND_REVISION_READY_FUNCTION_NAME',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

// --- Revision prompt ---

const ANNOTATED_CHANGE_LIST_PROMPT = `You are a professional document editor. Produce a structured change list based on the feedback decisions provided.

For each change, output a Markdown section in this exact format:

### Change N
- **Location:** Page X, paragraph/section Y (or section heading for text documents)
- **Original:** "exact original text"
- **Replacement:** "proposed replacement text"
- **Rationale:** Brief explanation

RULES:
- Number changes sequentially starting from 1
- Be specific about location — reference page numbers, section headings, or paragraph positions
- Quote the original text exactly so the user can find it
- Only include changes for the ACCEPTED and REVISED feedback points below
- For REVISE decisions, incorporate tenant notes as guidance`

/**
 * Returns the system prompt for revision generation.
 * All document types now use the annotated change list format.
 *
 * @param {string|null|undefined} _documentKey - Unused (kept for API compatibility)
 * @returns {string} The system prompt to use for Bedrock
 */
export function selectPrompt(_documentKey) {
  return ANNOTATED_CHANGE_LIST_PROMPT
}

async function putMetrics(metrics) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Revision',
      MetricData: metrics,
    }))
  } catch (err) {
    log('warn', 'ProcessRevision: failed to publish CloudWatch metrics', { errorName: err.name })
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

async function getS3Bytes(bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const chunks = []
    for await (const chunk of res.Body) chunks.push(chunk)
    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

async function markFailed(tenantId, revisionId) {
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.REVISIONS_TABLE,
      Key: { tenantId: { S: tenantId }, revisionId: { S: revisionId } },
      UpdateExpression: 'SET #status = :failed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':failed': { S: 'failed' } },
    }))
  } catch (err) {
    log('error', 'ProcessRevision: failed to mark revision as failed', { tenantId, revisionId, errorName: err.name })
  }
}

export const handler = async (event) => {
  const { tenantId, itemId, revisionId, startedAt } = event

  if (!tenantId || !itemId || !revisionId) {
    log('error', 'ProcessRevision: missing required fields in event', { event })
    return
  }

  try {
    // 1. Load original document from S3 — extracted.md if exists, else document.md
    const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
    const fallbackKey = `pulse/${tenantId}/items/${itemId}/document.md`

    const originalContent = await getS3Text(process.env.DATA_BUCKET, extractedKey)
      || await getS3Text(process.env.DATA_BUCKET, fallbackKey)

    if (!originalContent) {
      log('error', 'ProcessRevision: no document found in S3', { tenantId, itemId, revisionId })
      await markFailed(tenantId, revisionId)
      await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
      return
    }

    // 1b. Load item record to get documentKey for native document context
    let documentKey = null
    let pageCount = 0
    let itemName = 'your item'
    try {
      const itemResult = await dynamo.send(new GetItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      }))
      if (itemResult.Item) {
        documentKey = itemResult.Item.documentKey?.S || null
        pageCount = itemResult.Item.pageCount?.N ? parseInt(itemResult.Item.pageCount.N, 10) : 0
        itemName = itemResult.Item.itemName?.S || 'your item'
      }
    } catch (err) {
      log('warn', 'ProcessRevision: failed to load item record for document context', { tenantId, itemId, revisionId, errorName: err.name })
    }

    // 2. Load pulse check and extract accepted/revised decisions
    const pulseCheckResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    const pulseCheck = pulseCheckResult.Item
    if (!pulseCheck) {
      log('error', 'ProcessRevision: pulse check not found', { tenantId, itemId, revisionId })
      await markFailed(tenantId, revisionId)
      return
    }

    const decisionsMap = pulseCheck.decisions?.M ?? {}
    const proposedRevisions = pulseCheck.proposedRevisions?.L ?? []

    const acceptedOrRevised = proposedRevisions
      .filter(pr => {
        const prRevisionId = pr.M?.revisionId?.S
        const decision = prRevisionId ? decisionsMap[prRevisionId]?.M : null
        return decision && (decision.action?.S === 'Accept' || decision.action?.S === 'Revise')
      })
      .map(pr => {
        const prRevisionId = pr.M?.revisionId?.S
        const decision = decisionsMap[prRevisionId]?.M
        return {
          revisionId: prRevisionId,
          proposal: pr.M?.proposal?.S ?? '',
          rationale: pr.M?.rationale?.S ?? '',
          revisionType: pr.M?.revisionType?.S ?? '',
          action: decision?.action?.S ?? 'Accept',
          tenantNote: decision?.tenantNote?.S ?? '',
        }
      })

    // 3. Build Bedrock prompt
    const decisionsText = acceptedOrRevised.map((d, i) => {
      const noteText = d.tenantNote ? `\n   Tenant note: "${d.tenantNote}"` : ''
      const typeText = d.revisionType ? ` (${d.revisionType})` : ''
      return `${i + 1}. [${d.action.toUpperCase()}]${typeText} ${d.proposal}${noteText}`
    }).join('\n')

    const systemPrompt = selectPrompt(documentKey)

    const userMessage = `Original Document:
---
${originalContent}
---

Feedback Decisions to Incorporate:
${decisionsText}

Revised Document:`

    // 3b. Build user message content blocks — attach native document for PDF/DOCX
    const userContentBlocks = []

    if (documentKey) {
      const ext = documentKey.split('.').pop()?.toLowerCase()
      const docMediaTypes = {
        pdf: 'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }
      const mediaType = docMediaTypes[ext]

      if (mediaType) {
        let docBytes = null
        try {
          docBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
        } catch (err) {
          log('warn', 'ProcessRevision: failed to read original document from S3 for native context', { tenantId, itemId, revisionId, documentKey, errorName: err?.name })
        }
        if (!docBytes) {
          log('warn', 'ProcessRevision: original document not available from S3, proceeding with extracted text only', { tenantId, itemId, revisionId, documentKey })
        }
        if (docBytes) {
          userContentBlocks.push({
            document: { format: ext, name: 'document', source: { bytes: docBytes } },
          })
        }
      }
    }

    // Attach page images if available (send-once pattern, same as Chat Lambda)
    if (pageCount > 0) {
      for (let p = 1; p <= pageCount; p++) {
        const pageKey = `pulse/${tenantId}/items/${itemId}/pages/page-${String(p).padStart(3, '0')}.png`
        try {
          const pageBytes = await getS3Bytes(process.env.DATA_BUCKET, pageKey)
          if (pageBytes) {
            userContentBlocks.push({ image: { format: 'png', source: { bytes: pageBytes } } })
          }
        } catch {
          log('warn', 'ProcessRevision: failed to read page image, skipping', { tenantId, itemId, revisionId, page: p })
        }
      }
    }

    userContentBlocks.push({ text: userMessage })

    // 4. Invoke Bedrock (Converse API)
    const bedrockStart = Date.now()
    let bedrockResponse
    try {
      bedrockResponse = await bedrock.send(new ConverseCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        system: [{ text: systemPrompt }],
        messages: [{ role: 'user', content: userContentBlocks }],
        inferenceConfig: { maxTokens: 25000 },
      }))
    } catch (bedrockErr) {
      const bedrockLatency = Date.now() - bedrockStart
      log('error', 'ProcessRevision: Bedrock invocation failed', {
        tenantId, itemId, revisionId, errorName: bedrockErr.name, bedrockLatency,
      })
      await markFailed(tenantId, revisionId)
      await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
      return
    }

    const bedrockLatency = Date.now() - bedrockStart
    const revisedContent = bedrockResponse.output?.message?.content?.[0]?.text ?? ''
    const tokensIn = bedrockResponse.usage?.inputTokens ?? 0
    const tokensOut = bedrockResponse.usage?.outputTokens ?? 0

    // 5. Store revised document in S3
    const revisionKey = `pulse/${tenantId}/items/${itemId}/revisions/${revisionId}/document.md`
    const completedAt = new Date().toISOString()

    await s3.send(new PutObjectCommand({
      Bucket: process.env.DATA_BUCKET,
      Key: revisionKey,
      Body: revisedContent,
      ContentType: 'text/markdown',
      Metadata: {
        'tenant-id': tenantId,
        'item-id': itemId,
        'revision-id': revisionId,
        'created-at': startedAt,
      },
    }))

    // 6. Update revision record to 'complete'
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.REVISIONS_TABLE,
      Key: { tenantId: { S: tenantId }, revisionId: { S: revisionId } },
      UpdateExpression: 'SET #status = :complete, completedAt = :completedAt',
      ConditionExpression: '#status = :generating',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':complete': { S: 'complete' },
        ':completedAt': { S: completedAt },
        ':generating': { S: 'generating' },
      },
    }))

    // 7. Update item status to 'revised'
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET #status = :revised, updatedAt = :now',
        ConditionExpression: '#status = :closed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revised': { S: 'revised' },
          ':now': { S: completedAt },
          ':closed': { S: 'closed' },
        },
      }))
    } catch (condErr) {
      if (condErr.name === 'ConditionalCheckFailedException') {
        log('warn', 'ProcessRevision: item status was not closed, skipping status update', { tenantId, itemId, revisionId })
      } else {
        throw condErr
      }
    }

    // 7b. Invoke sendRevisionReady if delivery mode is async
    try {
      const systemResult = await dynamo.send(new GetItemCommand({
        TableName: process.env.TENANTS_TABLE,
        Key: { tenantId: { S: 'SYSTEM' } },
        ProjectionExpression: 'features',
      }))
      const systemFeatures = systemResult.Item?.features?.M
        ? unmarshalFeatures(systemResult.Item.features.M)
        : {}
      const systemRecord = { features: systemFeatures }
      const deliveryMode = resolveDeliveryMode(systemRecord)

      if (deliveryMode === 'async') {
        await lambda.send(new InvokeCommand({
          FunctionName: process.env.SEND_REVISION_READY_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: JSON.stringify({ tenantId, itemId, itemName, revisionId }),
        }))
        log('info', 'ProcessRevision: sendRevisionReady invoked', { tenantId, itemId, revisionId })
      } else {
        log('info', 'ProcessRevision: delivery mode is sync, skipping revision-ready email', { tenantId, itemId, revisionId })
      }
    } catch (emailErr) {
      log('warn', 'ProcessRevision: failed to invoke sendRevisionReady, continuing', { tenantId, itemId, revisionId, errorName: emailErr.name })
    }

    // 8. Publish CloudWatch metrics
    await putMetrics([
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
    ])

    log('info', 'ProcessRevision: revision complete', {
      tenantId, itemId, revisionId, completedAt,
      bedrockLatency, tokensIn, tokensOut,
      modelId: process.env.BEDROCK_MODEL_ID,
    })
  } catch (err) {
    log('error', 'ProcessRevision: unexpected error', {
      tenantId, itemId, revisionId, errorName: err.name, message: err.message,
    })
    await markFailed(tenantId, revisionId)
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
  }
}
