// ur/gd pulse — Chat Lambda
// POST /api/session/{sessionId}/chat
// Handles AI-guided feedback conversation via Bedrock
// S2-S2: Streaming via ConverseStream + awslambda.streamifyResponse()

import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'
import { ulid } from 'ulid'

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

requireEnv(['SESSIONS_TABLE', 'TRANSCRIPTS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'BEDROCK_MODEL_ID', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })
const lambda = new LambdaClient({ region: process.env.AWS_REGION || 'us-west-2' })

const SPECIAL_MESSAGES = ['__session_start__', '__session_resume__', '__session_end__']

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

async function putMetrics(metrics) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Chat',
      MetricData: metrics,
    }))
  } catch (err) {
    log('warn', 'Chat: failed to publish CloudWatch metrics', { errorName: err.name })
  }
}

/**
 * Unmarshal a DynamoDB Map attribute into a plain JS object.
 */
function unmarshalMap(m) {
  if (!m?.M) return null
  const result = {}
  for (const [key, val] of Object.entries(m.M)) {
    if ('S' in val) result[key] = val.S
    else if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('M' in val) result[key] = unmarshalMap(val)
    else if ('L' in val) result[key] = val.L.map(v => {
      if ('S' in v) return v.S
      if ('N' in v) return Number(v.N)
      if ('M' in v) return unmarshalMap(v)
      return null
    })
    else if ('NULL' in val) result[key] = null
  }
  return result
}

/**
 * Unmarshal a DynamoDB List attribute into a plain JS array.
 */
function unmarshalList(l) {
  if (!l?.L) return null
  return l.L.map(v => {
    if ('S' in v) return v.S
    if ('N' in v) return Number(v.N)
    if ('M' in v) return unmarshalMap(v)
    return null
  })
}

/**
 * Marshal a sectionCoverage map into DynamoDB Map format.
 */
function marshalSectionCoverage(coverage) {
  const m = {}
  for (const [sectionId, data] of Object.entries(coverage)) {
    m[sectionId] = {
      M: {
        touched: { BOOL: data.touched },
        depth: data.depth ? { S: data.depth } : { NULL: true },
      },
    }
  }
  return { M: m }
}

/**
 * Marshal a coverageMap into DynamoDB Map format.
 */
function marshalCoverageMap(coverageMap) {
  const m = {}
  for (const [sectionId, data] of Object.entries(coverageMap)) {
    m[sectionId] = {
      M: {
        sessionCount: { N: String(data.sessionCount) },
        avgDepth: data.avgDepth ? { S: data.avgDepth } : { NULL: true },
        reviewerIds: { L: (data.reviewerIds || []).map(id => ({ S: id })) },
      },
    }
  }
  return { M: m }
}


/**
 * Depth multipliers for section time allocation.
 * Same values used in useItemForm.ts for the time estimate preview.
 */
const DEPTH_MULTIPLIER = { deep: 1.5, explore: 1.0, skim: 0.5 }

/**
 * Compute per-section time allocations based on wordCount and depth preferences.
 *
 * Algorithm:
 * - When all sections have wordCount: effective weight = wordCount × depthMultiplier
 * - When any section lacks wordCount: depth-only fallback (depthMultiplier alone)
 * - When all weights are 0: equal allocation (timeLimitMinutes / N)
 * - Last section absorbs floating-point remainder so sum === timeLimitMinutes
 */
function computeTimeAllocations(sections, depthPrefs, timeLimitMinutes) {
  const multiplier = (sectionId) =>
    DEPTH_MULTIPLIER[depthPrefs?.[sectionId] ?? 'explore'] ?? 1.0

  const totalWords = sections.reduce((sum, s) => sum + (s.wordCount ?? 0), 0)
  const hasWordCounts = totalWords > 0 && sections.every(s => s.wordCount != null && s.wordCount >= 0)

  const weights = sections.map(s =>
    hasWordCounts
      ? (s.wordCount * multiplier(s.id))
      : multiplier(s.id)
  )

  const totalWeight = weights.reduce((a, b) => a + b, 0)

  if (totalWeight === 0) {
    return sections.map(() => timeLimitMinutes / sections.length)
  }

  const allocations = weights.map(w => (w / totalWeight) * timeLimitMinutes)
  const sum = allocations.reduce((a, b) => a + b, 0)
  allocations[allocations.length - 1] += timeLimitMinutes - sum
  return allocations
}

/**
 * Core chat handler logic — shared between streaming and non-streaming paths.
 * When invoked via streamifyResponse wrapper, responseStream is always present
 * and return values are ignored — all responses must go through responseStream.
 * isStreaming controls whether Bedrock tokens are streamed to the client.
 * hasResponseStream controls whether errors use responseStream or return values.
 */
async function handleChat(event, responseStream) {
  // responseStream is present whenever the handler is wrapped with streamifyResponse,
  // regardless of whether the caller is Function URL or API Gateway.
  // We must always write to it and end() it when present — return values are ignored.
  const hasResponseStream = !!responseStream
  // isStreaming = true only for Function URL calls where we want token-by-token streaming.
  // API Gateway calls through the streaming wrapper still use responseStream for the final response,
  // but collect the full Bedrock response before writing it.
  const isStreaming = hasResponseStream && !!event?.requestContext?.http
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId

  // Auth: API Gateway provides sessionId/tenantId via authorizer context.
  // Function URL has no authorizer — auth info comes from the request body.
  let sessionId, tenantId, isPreview
  if (event?.requestContext?.authorizer?.sessionId) {
    // API Gateway path
    sessionId = event.requestContext.authorizer.sessionId
    tenantId = event.requestContext.authorizer.tenantId
    isPreview = event.requestContext.authorizer.preview === 'true'
  } else {
    // Function URL path — parse auth from body
    let parsedBody
    try { parsedBody = JSON.parse(event.body || '{}') } catch { parsedBody = {} }
    const token = parsedBody.sessionToken || event?.headers?.authorization?.replace('Bearer ', '')
    if (token) {
      // Token format: {tenantId}:{sessionId}
      const parts = token.split(':')
      if (parts.length === 2) {
        tenantId = parts[0]
        sessionId = parts[1]
      }
    }
    // Also accept sessionId from body (for Function URL calls)
    if (!sessionId && parsedBody.sessionId) sessionId = parsedBody.sessionId
    isPreview = false
  }

  if (!sessionId || !tenantId) {
    if (hasResponseStream) {
      responseStream.write(JSON.stringify({ error: true, statusCode: 401, message: 'Unauthorized' }))
      responseStream.end()
      return
    }
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    if (hasResponseStream) {
      responseStream.write(JSON.stringify({ error: true, statusCode: 400, message: 'Invalid request body' }))
      responseStream.end()
      return
    }
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { message, windingDown } = body

  if (!message || typeof message !== 'string') {
    if (hasResponseStream) {
      responseStream.write(JSON.stringify({ error: true, statusCode: 400, message: 'message is required' }))
      responseStream.end()
      return
    }
    return errorResponse(400, 'message is required', {}, origin)
  }

  try {
    // 1. Get session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      if (hasResponseStream) {
        responseStream.write(JSON.stringify({ error: true, statusCode: 404, message: 'Session not found' }))
        responseStream.end()
        return
      }
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // 2. Validate confidentialityAcceptedAt (skip for preview sessions — tenant is previewing their own item)
    const sessionIsPreview = isPreview || session.preview?.BOOL === true
    if (!sessionIsPreview && !session.confidentialityAcceptedAt?.S) {
      log('warn', 'Chat: confidentiality not accepted', { requestId, sessionId, tenantId })
      if (hasResponseStream) {
        responseStream.write(JSON.stringify({ error: true, statusCode: 403, message: 'Confidentiality agreement not accepted' }))
        responseStream.end()
        return
      }
      return errorResponse(403, 'Confidentiality agreement not accepted', {}, origin)
    }

    // 3. Validate status
    const status = session.status?.S
    if (status === 'expired' || status === 'completed') {
      log('info', 'Chat: session not active', { requestId, sessionId, tenantId, status })
      if (hasResponseStream) {
        responseStream.write(JSON.stringify({ error: true, statusCode: 410, message: 'Session is no longer active' }))
        responseStream.end()
        return
      }
      return errorResponse(410, 'Session is no longer active', {}, origin)
    }

    // 4.2: Concurrent request guard — check streamingLock
    const streamingLock = session.streamingLock?.S
    if (streamingLock) {
      const lockAge = Date.now() - new Date(streamingLock).getTime()
      if (lockAge < 60000) {
        log('warn', 'Chat: concurrent request rejected (streamingLock active)', { requestId, sessionId, tenantId, lockAge })
        if (hasResponseStream) {
          responseStream.write(JSON.stringify({ error: true, statusCode: 409, message: 'Please wait for the current response' }))
          responseStream.end()
          return
        }
        return errorResponse(409, 'Please wait for the current response', {}, origin)
      }
    }

    const itemId = session.itemId?.S

    // Read frozenSnapshot from session if available (4.4)
    const frozenSnapshot = unmarshalMap(session.frozenSnapshot)
    let sectionCoverage = unmarshalMap(session.sectionCoverage) || {}

    // Determine totalSections from frozenSnapshot or fallback
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = parseInt(session.totalSections?.N || '5', 10)
    }

    let currentSection = parseInt(session.currentSection?.N || '1', 10)
    const timeLimitMinutes = parseInt(session.timeLimitMinutes?.N || '30', 10)
    const startedAt = session.startedAt?.S
    let closingState = session.closingState?.S || 'exploring'
    let graceMessagesRemaining = parseInt(session.graceMessagesRemaining?.N || '2', 10)

    // 4. Prepare reviewer message
    const reviewerMessageId = ulid()
    const isSpecial = SPECIAL_MESSAGES.includes(message)
    const transcriptContent = isSpecial ? `[${message}]` : message

    // 5. Load full conversation history
    const transcriptResult = await dynamo.send(new QueryCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      ScanIndexForward: true,
    }))

    const history = (transcriptResult.Items || []).map(item => ({
      role: item.role?.S === 'reviewer' ? 'user' : 'assistant',
      content: item.content?.S || '',
    }))

    // 6. Load item metadata and content from DynamoDB + S3
    let itemContent = ''
    let itemName = 'this item'
    let itemDescription = ''
    let itemType = 'document'
    let coverageMap = null
    let documentKey = null

    if (itemId && tenantId) {
      try {
        const itemResult = await dynamo.send(new GetItemCommand({
          TableName: process.env.ITEMS_TABLE,
          Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        }))
        if (itemResult.Item) {
          itemName = itemResult.Item.itemName?.S || 'this item'
          itemDescription = itemResult.Item.description?.S || ''
          itemType = itemResult.Item.itemType?.S || 'document'
          documentKey = itemResult.Item.documentKey?.S || null
          // 4.4: Read coverageMap from item record
          if (itemResult.Item.coverageMap?.M) {
            coverageMap = unmarshalMap(itemResult.Item.coverageMap)
          }
        }
      } catch {
        // Non-fatal
      }

      // Load document content for non-image items
      if (itemType !== 'image') {
        const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
        const docKey = `pulse/${tenantId}/items/${itemId}/document.md`
        itemContent = await getS3Text(process.env.DATA_BUCKET, extractedKey)
          || await getS3Text(process.env.DATA_BUCKET, docKey)
          || ''
      }
    }

    // 4.3: Load image for image items
    let imageBase64 = null
    let imageMediaType = 'image/jpeg'
    if (itemType === 'image' && documentKey) {
      const imageBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
      if (imageBytes) {
        imageBase64 = imageBytes.toString('base64')
        const ext = (documentKey || '').split('.').pop()?.toLowerCase() || 'jpeg'
        const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
        imageMediaType = mediaTypeMap[ext] || 'image/jpeg'
      }
    }

    // 7. Build system prompt (4.5: overhauled)
    // R8: Detect self-review sessions for prompt identity injection
    const isSelfReview = session.isSelfReview?.BOOL === true

    const systemPrompt = buildSystemPrompt({
      itemName, itemDescription, itemContent, itemType,
      totalSections, currentSection, closingState,
      windingDown, message, isSpecial,
      frozenSnapshot, coverageMap, imageBase64, isSelfReview,
      timeLimitMinutes,
    })

    // Build messages for Bedrock
    const bedrockMessages = [...history]
    if (message === '__session_end__') {
      bedrockMessages.push({ role: 'user', content: '[__session_end__]' })
    } else if (!isSpecial) {
      bedrockMessages.push({ role: 'user', content: message })
    } else if (message === '__session_start__' || message === '__session_resume__') {
      bedrockMessages.push({ role: 'user', content: transcriptContent })
    }

    // Coalesce consecutive same-role messages
    const coalescedMessages = []
    for (const msg of bedrockMessages) {
      const prev = coalescedMessages[coalescedMessages.length - 1]
      if (prev && prev.role === msg.role) {
        // Handle both string and array content
        if (typeof prev.content === 'string' && typeof msg.content === 'string') {
          prev.content += '\n\n' + msg.content
        }
      } else {
        coalescedMessages.push({ ...msg })
      }
    }

    // Drop orphaned leading assistant messages
    while (coalescedMessages.length > 0 && coalescedMessages[0].role !== 'user') {
      coalescedMessages.shift()
    }

    // Normalize string content to Converse API content block format.
    // The Converse API requires content to be an array of content blocks,
    // not a plain string. The SDK's internal logger crashes on string content.
    for (const msg of coalescedMessages) {
      if (typeof msg.content === 'string') {
        msg.content = [{ text: msg.content }]
      }
    }

    if (coalescedMessages.length === 0) {
      log('error', 'Chat: no valid messages after coalescing', { requestId, sessionId, tenantId })
      if (hasResponseStream) {
        responseStream.write(JSON.stringify({ error: true, statusCode: 400, message: 'No valid messages to process' }))
        responseStream.end()
        return
      }
      return errorResponse(400, 'No valid messages to process', {}, origin)
    }

    // 4.3: For image sessions, inject image content block into the FIRST user message only.
    // The image persists in Bedrock's conversation context across turns — re-injecting it
    // into the last message on every turn caused the model to hallucinate "new angles" or
    // "different views" of the same image. Fix: attach to the first user message so it
    // appears once at the start of the conversation history.
    if (itemType === 'image' && imageBase64) {
      const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const firstMsg = coalescedMessages[firstUserIdx]
        const textContent = Array.isArray(firstMsg.content)
          ? (firstMsg.content.find(b => b.text)?.text || '')
          : (typeof firstMsg.content === 'string' ? firstMsg.content : '')
        coalescedMessages[firstUserIdx] = {
          role: 'user',
          content: [
            { image: { format: (documentKey || '').split('.').pop()?.toLowerCase() === 'png' ? 'png' : 'jpeg', source: { bytes: Buffer.from(imageBase64, 'base64') } } },
            { text: textContent },
          ],
        }
      }
    }

    // 5.4/5.5: Native document attachment — send-once pattern for PDF/DOCX items.
    // On first turn (no prior transcript), attach original file as document content block.
    // On subsequent turns, the document is already in conversation history — no re-attachment.
    const isFirstTurn = history.length === 0
    if (isFirstTurn && itemType === 'document' && documentKey) {
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
          log('warn', 'Chat: failed to read original document from S3 for native context', { requestId, sessionId, tenantId, documentKey, errorName: err?.name })
        }
        if (!docBytes) {
          log('warn', 'Chat: original document not available from S3, proceeding with extracted text only', { requestId, sessionId, tenantId, documentKey })
        }
        if (docBytes) {
          const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
          if (firstUserIdx !== -1) {
            const firstMsg = coalescedMessages[firstUserIdx]
            const textContent = Array.isArray(firstMsg.content)
              ? (firstMsg.content.find(b => b.text)?.text || '')
              : (typeof firstMsg.content === 'string' ? firstMsg.content : '')
            coalescedMessages[firstUserIdx] = {
              role: 'user',
              content: [
                { document: { format: ext, name: 'document', source: { bytes: docBytes } } },
                { text: textContent },
              ],
            }
          }
        }
      }
    }

    // 4.2: Set streamingLock before Bedrock call
    if (!isPreview) {
      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
          UpdateExpression: 'SET streamingLock = :lock',
          ConditionExpression: 'attribute_not_exists(streamingLock) OR attribute_type(streamingLock, :nullType) OR streamingLock < :threshold',
          ExpressionAttributeValues: {
            ':lock': { S: new Date().toISOString() },
            ':threshold': { S: new Date(Date.now() - 60000).toISOString() },
            ':nullType': { S: 'NULL' },
          },
        }))
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') {
          log('warn', 'Chat: streamingLock contention — another request is active', { requestId, sessionId, tenantId })
          if (hasResponseStream) {
            responseStream.write(JSON.stringify({ error: true, statusCode: 409, message: 'Please wait for the current response' }))
            responseStream.end()
            return
          }
          return errorResponse(409, 'Please wait for the current response', {}, origin)
        }
        log('warn', 'Chat: failed to set streamingLock', { requestId, sessionId, errorName: err.name })
      }
    }

    // 8. Invoke Bedrock (Converse/ConverseStream API)
    const bedrockStart = Date.now()

    let agentText = ''
    let tokensIn = 0
    let tokensOut = 0

    if (isStreaming) {
      // 4.1: Streaming path — ConverseStream
      try {
        const streamResponse = await bedrock.send(new ConverseStreamCommand({
          modelId: process.env.BEDROCK_MODEL_ID,
          system: [{ text: systemPrompt }],
          messages: coalescedMessages,
          inferenceConfig: { maxTokens: 1024 },
        }))

        for await (const event of streamResponse.stream) {
          if (event.contentBlockDelta?.delta?.text) {
            const text = event.contentBlockDelta.delta.text
            agentText += text
            responseStream.write(text)
          }
          if (event.metadata?.usage) {
            tokensIn = event.metadata.usage.inputTokens || 0
            tokensOut = event.metadata.usage.outputTokens || 0
          }
        }

        responseStream.end()
      } catch (streamErr) {
        log('error', 'Chat: streaming error', { requestId, sessionId, tenantId, errorName: streamErr.name })
        try { responseStream.end() } catch { /* ignore */ }
        // Clear streamingLock on error
        if (!isPreview) {
          try {
            await dynamo.send(new UpdateItemCommand({
              TableName: process.env.SESSIONS_TABLE,
              Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
              UpdateExpression: 'REMOVE streamingLock',
            }))
          } catch { /* ignore */ }
        }
        throw streamErr
      }
    } else {
      // Non-streaming fallback (API Gateway proxy) — Converse
      const bedrockResponse = await bedrock.send(new ConverseCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        system: [{ text: systemPrompt }],
        messages: coalescedMessages,
        inferenceConfig: { maxTokens: 1024 },
      }))

      agentText = bedrockResponse.output?.message?.content?.[0]?.text || ''
      tokensIn = bedrockResponse.usage?.inputTokens || 0
      tokensOut = bedrockResponse.usage?.outputTokens || 0
    }

    const bedrockLatency = Date.now() - bedrockStart

    // Annotate X-Ray trace
    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: tokensIn,
      bedrockTokensOut: tokensOut,
    })

    // 9. Atomically write reviewer + agent messages
    const agentMessageId = ulid()
    const now = new Date().toISOString()
    if (!isPreview) {
      await dynamo.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: process.env.TRANSCRIPTS_TABLE,
              Item: {
                sessionId: { S: sessionId },
                messageId: { S: reviewerMessageId },
                role: { S: 'reviewer' },
                content: { S: transcriptContent },
                timestamp: { S: now },
              },
            },
          },
          {
            Put: {
              TableName: process.env.TRANSCRIPTS_TABLE,
              Item: {
                sessionId: { S: sessionId },
                messageId: { S: agentMessageId },
                role: { S: 'agent' },
                content: { S: agentText },
                timestamp: { S: now },
              },
            },
          },
        ],
      }))
    }

    // 10. Section tracking
    const sectionMatch = agentText.match(/\[SECTION:(\d+)\]/)
    if (sectionMatch) {
      const newSection = parseInt(sectionMatch[1], 10)
      if (newSection > currentSection && newSection <= totalSections) {
        currentSection = newSection
      }
    }

    // 4.4: Update sectionCoverage when [SECTION:N] tags detected
    if (sectionMatch && frozenSnapshot?.feedbackSections) {
      const sectionNum = parseInt(sectionMatch[1], 10)
      const sectionIdx = sectionNum - 1
      if (sectionIdx >= 0 && sectionIdx < frozenSnapshot.feedbackSections.length) {
        const sectionId = frozenSnapshot.feedbackSections[sectionIdx]
        if (sectionId && sectionCoverage[sectionId]) {
          sectionCoverage[sectionId] = {
            touched: true,
            depth: frozenSnapshot.sectionDepthPreferences?.[sectionId] || 'explore',
          }
        }
      }
    }

    // 10b. Compute closing state transitions
    let newClosingState = closingState
    let newGraceMessagesRemaining = graceMessagesRemaining

    if (closingState === 'exploring' && !isSpecial && startedAt && timeLimitMinutes > 0) {
      const elapsedMs = Date.now() - new Date(startedAt).getTime()
      const remainingMs = (timeLimitMinutes * 60 * 1000) - elapsedMs
      if (remainingMs <= 4 * 60 * 1000) {
        newClosingState = 'narrowing'
      }
    }

    if ((closingState === 'narrowing' || closingState === 'exploring') && windingDown === 'final') {
      newClosingState = 'closing'
      newGraceMessagesRemaining = 10
    }

    if (closingState === 'closing' && !isSpecial) {
      if (graceMessagesRemaining <= 0) {
        newClosingState = 'closed'
      } else {
        newGraceMessagesRemaining = graceMessagesRemaining - 1
      }
    }

    if (agentText.includes('[SESSION_COMPLETE]')) {
      newClosingState = 'closed'
    }

    // 11. Session state updates
    const isFirstMessage = message === '__session_start__'
    const sessionComplete = message === '__session_end__' || agentText.includes('[SESSION_COMPLETE]') || newClosingState === 'closed'

    if (!isPreview) {
      const updateExprParts = [
        '#updatedAt = :updatedAt',
        'currentSection = :cs',
        'closingState = :closingState',
        'graceMessagesRemaining = :grace',
      ]
      const updateNames = { '#updatedAt': 'updatedAt' }
      const updateValues = {
        ':updatedAt': { S: new Date().toISOString() },
        ':cs': { N: String(currentSection) },
        ':closingState': { S: newClosingState },
        ':grace': { N: String(newGraceMessagesRemaining) },
      }

      // Clear streamingLock after stream completes (4.2)
      updateExprParts.push('streamingLock = :noLock')
      updateValues[':noLock'] = { NULL: true }

      // Update sectionCoverage if we have a frozenSnapshot (4.4)
      if (frozenSnapshot?.feedbackSections) {
        updateExprParts.push('sectionCoverage = :sc')
        updateValues[':sc'] = marshalSectionCoverage(sectionCoverage)
      }

      if (isFirstMessage) {
        updateExprParts.push('#status = :status', 'startedAt = :startedAt')
        updateNames['#status'] = 'status'
        updateValues[':status'] = { S: 'in_progress' }
        updateValues[':startedAt'] = { S: new Date().toISOString() }
      }

      if (sessionComplete) {
        updateExprParts.push('#status = :status', 'completedAt = :completedAt')
        updateNames['#status'] = 'status'
        updateValues[':status'] = { S: 'completed' }
        updateValues[':completedAt'] = { S: new Date().toISOString() }
      }

      // Guard: prevent overwriting terminal session states (expired/completed by another process)
      updateNames['#status'] = 'status'
      updateValues[':not_started'] = { S: 'not_started' }
      updateValues[':in_progress'] = { S: 'in_progress' }

      try {
        await dynamo.send(new UpdateItemCommand({
          TableName: process.env.SESSIONS_TABLE,
          Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
          UpdateExpression: `SET ${updateExprParts.join(', ')}`,
          ConditionExpression: '#status IN (:not_started, :in_progress)',
          ExpressionAttributeNames: updateNames,
          ExpressionAttributeValues: updateValues,
        }))
      } catch (condErr) {
        if (condErr.name === 'ConditionalCheckFailedException') {
          log('warn', 'Chat: session is no longer active, skipping update', { requestId, sessionId, tenantId })
          if (hasResponseStream && !isStreaming) {
            const errResp = errorResponse(410, 'Session is no longer active', {}, origin)
            responseStream.write(JSON.stringify(errResp))
            responseStream.end()
            return
          }
          if (!hasResponseStream) {
            return errorResponse(410, 'Session is no longer active', {}, origin)
          }
          // Streaming path: response already sent to client, just return
          return
        }
        throw condErr
      }

      // 4.4: On session complete, update item coverageMap with aggregate coverage
      if (sessionComplete && frozenSnapshot?.feedbackSections && itemId) {
        try {
          await updateItemCoverageMap(tenantId, itemId, sectionCoverage, sessionId, session.reviewerEmail?.S || session.tenantId?.S || 'anonymous')
        } catch (err) {
          log('warn', 'Chat: failed to update item coverageMap', { requestId, sessionId, tenantId, errorName: err.name })
        }
      }

      // Coverage fallback — infer from transcript when sectionCoverage is empty
      if (sessionComplete && sectionCoverage && Object.keys(sectionCoverage).length === 0) {
        if (frozenSnapshot?.sectionMap?.sections) {
          const inferredCoverage = {}
          const agentMessages = history.filter(m => m.role === 'assistant').map(m => m.content)
          // Include the current agent response in inference
          agentMessages.push(agentText)
          const allAgentText = agentMessages.join(' ')

          for (const section of frozenSnapshot.sectionMap.sections) {
            if (section.title && allAgentText.includes(section.title)) {
              inferredCoverage[section.id] = { touched: true, depth: 'inferred' }
            }
          }

          if (Object.keys(inferredCoverage).length > 0) {
            sectionCoverage = inferredCoverage
            // Update session record with inferred coverage
            await dynamo.send(new UpdateItemCommand({
              TableName: process.env.SESSIONS_TABLE,
              Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
              UpdateExpression: 'SET sectionCoverage = :cov',
              ExpressionAttributeValues: {
                ':cov': marshalSectionCoverage(inferredCoverage),
              },
            }))
            log('info', 'Chat: inferred sectionCoverage from transcript', { sessionId, inferredSections: Object.keys(inferredCoverage).length })
          }
        }
      }

      // Invoke downstream Lambdas on session complete
      if (sessionComplete) {
        const generateSummaryFnName = process.env.GENERATE_SESSION_SUMMARY_FUNCTION_NAME
        if (generateSummaryFnName) {
          try {
            await lambda.send(new InvokeCommand({
              FunctionName: generateSummaryFnName,
              InvocationType: 'Event',
              Payload: JSON.stringify({ sessionId, tenantId }),
            }))
          } catch (err) {
            log('warn', 'Chat: failed to invoke generateSessionSummary', { requestId, sessionId, tenantId, errorName: err.name })
          }
        }

        const generateReportFnName = process.env.GENERATE_REPORT_FUNCTION_NAME
        if (generateReportFnName) {
          try {
            await lambda.send(new InvokeCommand({
              FunctionName: generateReportFnName,
              InvocationType: 'Event',
              Payload: JSON.stringify({ sessionId, tenantId }),
            }))
          } catch (err) {
            log('warn', 'Chat: failed to invoke generateReport', { requestId, sessionId, tenantId, errorName: err.name })
          }
        }
      }
    }

    // 14. Publish CloudWatch metrics
    await putMetrics([
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
      { MetricName: 'ChatMessages', Value: 1, Unit: 'Count' },
    ])

    log('info', 'Chat: success', {
      requestId, sessionId, tenantId,
      bedrockLatency, tokensIn, tokensOut,
      modelId: process.env.BEDROCK_MODEL_ID,
      sessionComplete,
    })

    // For non-streaming path, return JSON response
    if (!isStreaming) {
      const jsonResp = createResponse(200, {
        data: {
          message: agentText,
          section: currentSection,
          sessionComplete,
          closingState: newClosingState,
        },
      }, {}, origin)
      if (hasResponseStream) {
        // API Gateway call through streaming wrapper — write response to stream
        responseStream.write(JSON.stringify(jsonResp))
        responseStream.end()
        return
      }
      return jsonResp
    }
  } catch (err) {
    log('error', 'Chat: unexpected error', { requestId, sessionId, tenantId, errorName: err.name, errorMessage: err.message, stack: err.stack })
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])

    if (hasResponseStream) {
      try { responseStream.end() } catch { /* ignore */ }
      return
    }

    if (err.name === 'AccessDeniedException') {
      return errorResponse(503, 'AI service temporarily unavailable', {}, origin)
    }
    if (err.name === 'ThrottlingException' || err.name === 'ServiceUnavailableException') {
      return errorResponse(503, 'AI service temporarily unavailable — please try again', {}, origin)
    }
    return errorResponse(500, 'Failed to process chat message', {}, origin)
  }
}


/**
 * Update item coverageMap with aggregate coverage from this session (4.4).
 */
async function updateItemCoverageMap(tenantId, itemId, sectionCoverage, sessionId, reviewerId) {
  // Guard: skip if sectionCoverage is null/empty — nothing to aggregate
  if (!sectionCoverage || Object.keys(sectionCoverage).length === 0) {
    log('warn', 'updateItemCoverageMap: sectionCoverage is empty, skipping', { tenantId, itemId, sessionId })
    return
  }

  // Guard: skip if no sections were actually touched
  const hasTouched = Object.values(sectionCoverage).some(d => d.touched)
  if (!hasTouched) {
    log('warn', 'updateItemCoverageMap: no touched sections, skipping', { tenantId, itemId, sessionId })
    return
  }

  // Read current item coverageMap (with updatedAt for optimistic locking)
  const MAX_RETRIES = 2
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      ProjectionExpression: 'coverageMap, updatedAt',
    }))

    const expectedUpdatedAt = itemResult.Item?.updatedAt?.S || null
    const existingCoverage = itemResult.Item?.coverageMap?.M ? unmarshalMap(itemResult.Item.coverageMap) : {}

    // Merge this session's coverage into the aggregate
    for (const [sectionId, data] of Object.entries(sectionCoverage)) {
      if (!data.touched) continue

      if (!existingCoverage[sectionId]) {
        existingCoverage[sectionId] = { sessionCount: 0, avgDepth: null, reviewerIds: [] }
      }

      const entry = existingCoverage[sectionId]
      entry.sessionCount = (entry.sessionCount || 0) + 1
      entry.avgDepth = data.depth || entry.avgDepth
      if (!entry.reviewerIds) entry.reviewerIds = []
      if (reviewerId && !entry.reviewerIds.includes(reviewerId)) {
        entry.reviewerIds.push(reviewerId)
      }
    }

    // Ensure untouched sections have entries too
    for (const [sectionId, data] of Object.entries(sectionCoverage)) {
      if (!existingCoverage[sectionId]) {
        existingCoverage[sectionId] = { sessionCount: 0, avgDepth: null, reviewerIds: [] }
      }
    }

    const conditionParts = []
    const condValues = {
      ':cm': marshalCoverageMap(existingCoverage),
      ':now': { S: new Date().toISOString() },
    }

    if (expectedUpdatedAt) {
      conditionParts.push('updatedAt = :expectedUpdatedAt')
      condValues[':expectedUpdatedAt'] = { S: expectedUpdatedAt }
    } else {
      conditionParts.push('attribute_not_exists(updatedAt)')
    }

    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
        UpdateExpression: 'SET coverageMap = :cm, updatedAt = :now',
        ConditionExpression: conditionParts.join(' AND '),
        ExpressionAttributeValues: condValues,
      }))
      return // Success — exit retry loop
    } catch (writeErr) {
      if (writeErr.name === 'ConditionalCheckFailedException') {
        if (attempt < MAX_RETRIES) {
          log('warn', 'updateItemCoverageMap: concurrent write detected, retrying', { tenantId, itemId, sessionId, attempt: attempt + 1 })
          continue // Re-read and re-merge
        }
        log('warn', 'updateItemCoverageMap: concurrent write detected, max retries exceeded', { tenantId, itemId, sessionId })
        return // Give up gracefully — coverage will be slightly stale but not lost
      }
      throw writeErr
    }
  }
}

/**
 * Build the system prompt (4.5: overhauled).
 * Behavioral guardrails at top, then conversational instructions.
 */
function buildSystemPrompt({ itemName, itemDescription, itemContent, itemType, totalSections, currentSection, closingState, windingDown, message, isSpecial, frozenSnapshot, coverageMap, imageBase64, isSelfReview, timeLimitMinutes }) {
  // ── Behavioral guardrails (placed at top per 4.5/8.8) ──
  let prompt = `BEHAVIORAL GUARDRAILS — follow these rules at all times:
- Never guess or assume the reviewer's intent. If something is unclear, ask for clarification. Say "Could you tell me more about what you mean?" rather than interpreting on your own.
- Never fabricate details about the document or image. If you don't know something, say so.
- Never show [SECTION:N] or [SESSION_COMPLETE] tags inline with your conversational text. Always place them on their own line at the very end.
- Never refer to sections by number with the reviewer. Transition naturally.
- Ask one focused question at a time. Wait for their answer.
- Do not use markdown formatting like bold (**text**) or headers (##). Plain text and lists only.
- Each paragraph you write appears as its own chat bubble. Group related thoughts into one bubble.
- A question always gets its own bubble, separated by a blank line.
- Most responses should be one to three bubbles. Four is the upper end.
- When a reviewer signals a topic is covered — through agreement, short answers, humor, or explicit redirection — move to the next section or topic. Don't mine a topic past its natural depth. Two to three exchanges on a single thread is usually enough before pivoting.
- When a reviewer gives a definitive opinion on an element (strong positive or negative with clear reasoning), acknowledge it and move to a new aspect. Don't re-ask about the same element unless the reviewer brings it back up.

`

  // ── Agent identity (4.5/8.1: informed expert, not coordinator) ──
  prompt += `You are Pulse — an AI feedback agent built by ur/gd Studios. You are an informed expert who has carefully read and understood the material being reviewed. You guide reviewers through structured, one-on-one feedback sessions.

`

  // R8: Self-review vs third-party identity injection
  if (isSelfReview) {
    prompt += `IMPORTANT: This is a self-review session. The reviewer IS the creator of this work. They are reviewing their own material to reflect on it and identify areas for improvement. Questions about their creative intent, process decisions, and authorial choices are appropriate and encouraged. Frame this as "your own perspective matters here — what were you going for?"

`
  } else {
    prompt += `CRITICAL: The reviewer is NOT the creator of this work. They are a third party — a colleague, client, stakeholder, or outside perspective — invited to give feedback on someone else's work. Never assume the reviewer made, designed, wrote, photographed, or created the content. Ask about their reactions, impressions, and opinions — not about their creative intent or process.

`
  }

  prompt += `Your approach:
- You have read the material thoroughly. You know its structure, key claims, and potential weak points.
- Before asking a question, share a brief observation about what you noticed in the material. This shows the reviewer you've done the work and gives them something concrete to react to.
- When a reviewer gives a short answer (fewer than 15 words), acknowledge briefly and ask a follow-up that invites elaboration. Don't move to a new topic until you've given them a chance to expand.
- When transitioning between sections, connect themes you've noticed across sections when natural connections arise. "This connects to what you said earlier about..." builds continuity.
- Warm, calm, and conversational — like a thoughtful colleague who has done their homework.
- Respectful of the reviewer's time and attention.
- Brief and natural — keep messages short and human. No walls of text.
- Less is more. Silence and brevity are tools, not failures.

`

  // ── Communication style ──
  prompt += `Communication style:
- Mirror the reviewer's energy. Match their pace.
- Vary your response length and shape. If your last three responses were the same shape, your next one must be different.
- Not every response needs context + analysis + question. Sometimes a short acknowledgment and a direct question is enough.
- Use bullet points or numbered lists when listing specific items. Keep lists to seven items or fewer.
- Acknowledge what the reviewer said before moving on — but keep acknowledgments short. One sentence max.

Asking good questions:
- Match the question to the content type. Never use "feel" for legal, financial, or structural content. Use "match," "reflect," "look right," or "work for you."
- Keep questions short and specific. One sentence. Give the reviewer something concrete to react to.

`

  // ── Item context ──
  prompt += `The item being reviewed:
- Name: "${itemName}"
- Type: ${itemType}

`

  // ── Anchor pattern (4.5/8.10): reference tenant's feedback focus ──
  if (itemDescription) {
    prompt += `Feedback focus (from the person who created this session):
"${itemDescription}"

This is your primary steering signal. Shape your questions around it. Periodically reference this focus to keep the conversation on track — especially when transitioning between sections or when the conversation drifts. Sections that connect to this focus deserve your best, most specific questions.

`
  } else {
    prompt += `No specific feedback focus was provided. Default to a balanced walkthrough: for each section, identify the most consequential claim, decision, or assumption and ask the reviewer to react to it.

`
  }

  // ── Document/image content ──
  if (itemType === 'image') {
    prompt += `This is an image feedback session. The image was provided once at the start of this session. It does not change between messages. Never describe it as a "new angle," "different view," "full picture," or suggest the image has changed in any way. You saw the complete image at the start — reference it naturally without re-describing it each turn.

When describing the image, use everyday language. Say "the patterned wood floor" not "herringbone parquet." Say "the small bathroom" not "the powder room." Say "the dark tile" not "zellige tile." If the reviewer uses a specific term, you can mirror it — but don't assume vocabulary. The reviewer is a regular person giving their honest reaction.

`
  } else {
    prompt += `Document content:
${itemContent || '(No document content available)'}

`
  }

  // ── Section structure and depth-aware pacing (4.5/8.7) ──
  if (frozenSnapshot?.feedbackSections && frozenSnapshot.sectionDepthPreferences) {
    const sections = frozenSnapshot.feedbackSections
    const depths = frozenSnapshot.sectionDepthPreferences
    const sectionMap = frozenSnapshot.sectionMap

    // v1.1: Compute per-section time allocations from wordCount × depth
    const sectionEntries = sectionMap?.sections || []
    const timeAllocations = sectionEntries.length > 0 && timeLimitMinutes > 0
      ? computeTimeAllocations(sectionEntries, depths, timeLimitMinutes)
      : null

    prompt += `Session structure:
- This session covers ${totalSections} section${totalSections !== 1 ? 's' : ''}. Current section: ${currentSection} of ${totalSections}.
- Section pacing by depth preference:
`
    for (let i = 0; i < sections.length; i++) {
      const sId = sections[i]
      const depth = depths[sId] || 'explore'
      const sectionInfo = sectionEntries.find(s => s.id === sId)
      const title = sectionInfo?.title || `Section ${i + 1}`
      const pacingNote = depth === 'deep' ? 'thorough — multiple exchanges, dig into details'
        : depth === 'explore' ? 'cover well — 1-2 substantive exchanges'
        : 'brief acknowledgment — mention key point, move on quickly'
      const timeBudget = timeAllocations ? ` (~${timeAllocations[i].toFixed(1)} min)` : ''
      prompt += `  ${i + 1}. "${title}" (${depth}): ${pacingNote}${timeBudget}\n`
    }
    prompt += '\n'
  } else {
    prompt += `Session structure:
- This is a ${totalSections}-section review. Current section: ${currentSection} of ${totalSections}.
- Each section should have at least two substantive exchanges before transitioning.

`
  }

  // ── Coverage routing (4.4): inject gap info ──
  if (coverageMap) {
    const uncoveredSections = []
    if (frozenSnapshot?.feedbackSections) {
      for (const sId of frozenSnapshot.feedbackSections) {
        const coverage = coverageMap[sId]
        if (!coverage || coverage.sessionCount === 0) {
          const sectionInfo = frozenSnapshot.sectionMap?.sections?.find(s => s.id === sId)
          uncoveredSections.push(sectionInfo?.title || sId)
        }
      }
    }
    if (uncoveredSections.length > 0) {
      prompt += `Coverage gaps from previous reviewers — the following sections have NOT been covered yet. Prioritize these sections and spend more time on them:
${uncoveredSections.map(s => `- ${s}`).join('\n')}

`
    }
  }

  // ── Section coverage tracking (critical) ──
  prompt += `SECTION COVERAGE TRACKING (CRITICAL):
You MUST emit a [SECTION:N] tag at the start of EVERY section transition, including the FIRST section.
This applies to ALL session types including self-review sessions.
If you discuss content from section 2, emit [SECTION:2] before your first message about that section.
Missing tags means the coverage map will be incomplete — this directly affects the tenant's ability to see which sections received feedback.

`

  // ── Section transition rules ──
  prompt += `Section transitions:
- You MUST cover ALL ${totalSections} listed sections before ending the session. Do not skip any section. Do not end the session with uncovered sections remaining.
- After the depth-appropriate number of exchanges for the current section, transition to the next section. Do not linger on one section at the expense of others.
- When you move to a new section, include [SECTION:N] (where N is the section number) at the very end of your last sentence — appended directly after the period or question mark, no newline before it. Example: "...what stood out to you about the pricing model?[SECTION:3]"
- Before transitioning, consider whether the feedback focus applies to the upcoming content.
- When all sections are covered, include [SESSION_COMPLETE] at the very end of your final message.
- Never ask the reviewer to react to something you haven't shown them. Summarize or quote first, then ask.
- If the reviewer goes off-topic, gently guide them back.
- If the reviewer hints at something deeper, follow up before moving on — but keep an eye on the remaining sections.
- If the reviewer disagrees with something, welcome it. Don't defend the document.
- If the reviewer asks about something the document doesn't cover, say so honestly.

`

  // ── Closing phase (4.5/8.5, R9: evidence-based rewrite) ──
  prompt += `Closing phase:
- When the session nears completion, synthesize 2-3 key themes from the conversation — not a list of everything discussed, just the threads that mattered most.
- Reference the most interesting or important thing the reviewer shared. Name it specifically. This is what makes the closing feel like it belongs to this conversation.
- Avoid formulaic phrases. Do not say "Thank you for your valuable feedback", "This has been a productive session", "I appreciate your time", "Thanks for taking the time", or "Really glad to have had your perspective." These are filler. Instead, close with something only you could say about this specific conversation.
- Keep the closing to 2-3 bubbles max. Do not write a summary report or bullet-point recap. A closing is a moment, not a deliverable.
- End with something that gives the reviewer a reason to feel good about what they contributed — a specific insight, a tension they named, a reframe they offered. Make it concrete.

`

  // ── Winding down signals ──
  if (windingDown === 'true') {
    prompt += 'The session is approaching its suggested time. Let the reviewer finish their current thought before steering toward a natural close. Don\'t mention the time limit directly.\n\n'
  } else if (windingDown === 'final') {
    prompt += 'The session is near the end of its suggested time. Honor any mid-thought, then deliver a brief, warm closing. Thank the reviewer. Summarize what you covered in a sentence or two.\n\n'
  }

  // ── Reflection pauses ──
  prompt += 'Reflection pauses: At key moments, you may invite the reviewer to take a moment before answering. Use sparingly.\n\n'

  // ── Closing state ──
  if (closingState === 'narrowing') {
    prompt += 'The session is entering its final phase. Go deeper on the current topic — ask the follow-up you haven\'t asked yet, or push on the most interesting thing the reviewer just said. Do not open new sections or topics. Do not announce this shift or mention time.\n\n'
  } else if (closingState === 'closing') {
    prompt += `The session is entering its closing phase. Before you deliver the summary, ask ONE open-ended closing question to give the reviewer a chance to surface anything the structured questions didn't draw out.

Your closing question must:
- Be conversational and specific to THIS conversation — reference the item name ("${itemName}") or a topic you actually discussed. For example: "Before we wrap up — is there anything about [specific topic from the conversation] you wanted to share that we didn't get to?"
- NOT be generic or templated. Do not say "Is there anything else you'd like to add?" without referencing something concrete from the session.
- NOT use "Thanks for taking the time", "I appreciate your time", "Thank you for your valuable feedback", "This has been a productive session", "Really glad to have had your perspective", or any similar formulaic phrase.

After you ask the closing question:
- If the reviewer shares additional thoughts, acknowledge what they say briefly and note it for the author. Do not press for elaboration or dig deeper — just receive it warmly and let them know it will be included.
- Allow a natural exchange of a few turns if they have more to say. Keep your responses short — acknowledgment, not investigation.
- Once the reviewer signals they are done (e.g., "No, that's all", "I think we covered it", or a short affirmative), proceed directly to the summary.

Then deliver the closing summary:
- Synthesize 2-3 key themes from the conversation — not a list of everything discussed, just the threads that mattered most.
- Reference the most interesting or important thing the reviewer shared. Name it specifically.
- Keep the closing to 2-3 bubbles max. Do not write a summary report or bullet-point recap.
- End with something concrete the reviewer contributed — a specific insight, a tension they named, a reframe they offered.
- Include [SESSION_COMPLETE] at the very end of your final summary message.

`
  } else if (closingState === 'closed') {
    prompt += 'This session is complete. Do not respond to further messages.\n\n'
  }

  // ── Special message handling ──
  if (message === '__session_start__') {
    if (itemType === 'image') {
      // 4.5/8.6: Photo session opening — two-step like documents
      prompt += `This is the very start of the session. This is an image feedback session. The reviewer did NOT create this image — they are giving feedback on it as an outside perspective.

Structure your opening the same way as a document session — greet first, THEN describe the image after they're ready:

1. A warm, brief greeting. Introduce yourself as Pulse. Explain you're here to walk through this image and hear their honest impressions. Let them know they're in control. Ask if they're ready to start.

Do NOT describe the image yet. Wait for the reviewer to respond. On your NEXT message (after they say they're ready), describe the image in 2-3 sentences using everyday language — focus on the overall impression and one or two standout details, not an exhaustive inventory. Save specific observations for later in the conversation as anchors for questions. Then ask your first question.

Your opening should feel natural and different each time. Vary the words — don't use the same phrasing across sessions. Keep it to 3-4 short sentences.

Do NOT mention sections. Do NOT ask about the reviewer's creative process or intent — they didn't make this.\n`
    } else {
      prompt += `This is the very start of the session. Your opening should feel natural and different each time. Hit these beats:

1. Greet warmly. Introduce yourself as Pulse — an AI feedback guide.
2. Explain you're here to walk through the material and hear their honest take. Keep it casual — just a conversation, nothing formal.
3. Let them know they're in control — they can take their time, and they can end the session whenever they want.
4. Invite them to start.

Vary the words — don't use the same phrasing across sessions. Keep it to 3-4 short sentences total. Do NOT mention the number of sections.\n`
    }
  } else if (message === '__session_resume__') {
    prompt += 'The reviewer has returned to continue their session. Welcome them back warmly and briefly. Reference where you left off.\n'
  } else if (message === '__session_end__') {
    prompt += 'The reviewer has chosen to end the session early. Thank them genuinely. Briefly mention what you covered together. Keep it warm and short.\n'
  }

  return prompt
}


// 4.1: Streaming handler wrapped with awslambda.streamifyResponse()
// Falls back to standard handler when responseStream is not available (API Gateway proxy)
const streamingHandler = async (event, responseStream, context) => {
  return handleChat(event, responseStream)
}

// Export: use streamifyResponse if available (Lambda streaming), otherwise standard handler
export const handler = typeof globalThis.awslambda?.streamifyResponse === 'function'
  ? globalThis.awslambda.streamifyResponse(streamingHandler)
  : async (event) => handleChat(event, null)

// Named exports for testing
export { computeTimeAllocations, DEPTH_MULTIPLIER, buildSystemPrompt }
