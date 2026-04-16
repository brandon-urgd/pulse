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
import { buildSystemPrompt, computeTimeAllocations, DEPTH_MULTIPLIER } from './shared/buildSystemPrompt.mjs'
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
    let pageCount = 0

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
          pageCount = itemResult.Item.pageCount?.N ? parseInt(itemResult.Item.pageCount.N, 10) : 0
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

    // Phased Cache Priming: Turn-aware document injection
    // Count prior user messages in transcript to determine the turn number.
    // Turn 1 = 0 prior user messages (greeting), Turn 2 = 1 prior, Turn 3+ = 2+ prior.
    // Phase 1 (turns 1-2): text-only, no native doc — fast responses (3-5s)
    // Phase 2 (turn 3+): inject native doc from warm cache — full document intelligence
    const priorUserMessages = history.filter(m => m.role === 'user').length
    const turnNumber = priorUserMessages + 1

    // Document injection only applies to document sessions with a native document (PDF/DOCX).
    // Image sessions and text-only sessions are unaffected by turn-awareness.
    const isDocumentInjectionTurn = turnNumber >= 3

    let nativeDocBytes = null
    if (isDocumentInjectionTurn && itemType === 'document' && documentKey) {
      const ext = documentKey.split('.').pop()?.toLowerCase()
      const docMediaTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      if (docMediaTypes[ext]) {
        try {
          nativeDocBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
        } catch (err) {
          log('warn', 'Chat: failed to read original document from S3 for native context', { requestId, sessionId, tenantId, documentKey, errorName: err?.name })
        }
        if (!nativeDocBytes) {
          log('warn', 'Chat: original document not available from S3, proceeding with extracted text only', { requestId, sessionId, tenantId, documentKey })
        }
      }
    }

    // nativeDocumentAvailable controls the system prompt phase:
    // - false for turns 1-2 of document sessions (text-only phase)
    // - true for turn 3+ of document sessions (full document phase)
    // - For non-document sessions, this follows existing behavior (based on whether doc bytes loaded)
    const nativeDocumentAvailable = !!nativeDocBytes

    // Phased Cache Priming: System prompt no longer uses templateGreeting — the model
    // generates its own greeting at turn 1 via __session_start__.
    const systemPrompt = buildSystemPrompt({
      itemName, itemDescription, itemContent, itemType,
      totalSections, currentSection, closingState,
      windingDown, message, isSpecial,
      frozenSnapshot, coverageMap, imageBase64, isSelfReview,
      timeLimitMinutes,
      nativeDocumentAvailable,
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

    // Phased Cache Priming: Native document attachment — send-once pattern for PDF/DOCX items.
    // On document injection turn (turn 3+), attach original file as document content block.
    // On turns 1-2, the document is not attached — text-only phase for fast responses.
    // On subsequent turns after injection, the document is already in conversation history.
    // nativeDocBytes was pre-loaded above (before system prompt building).
    if (isDocumentInjectionTurn && itemType === 'document' && documentKey && nativeDocBytes) {
      const ext = documentKey.split('.').pop()?.toLowerCase()
      const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const firstMsg = coalescedMessages[firstUserIdx]
        const textContent = Array.isArray(firstMsg.content)
          ? (firstMsg.content.find(b => b.text)?.text || '')
          : (typeof firstMsg.content === 'string' ? firstMsg.content : '')
        coalescedMessages[firstUserIdx] = {
          role: 'user',
          content: [
            { document: { format: ext, name: 'document', source: { bytes: nativeDocBytes } } },
            { text: textContent },
          ],
        }
      }
    }

    // Phased Cache Priming: Attach page images on document injection turn (send-once pattern)
    if (isDocumentInjectionTurn && itemType === 'document' && pageCount > 0) {
      const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const existingContent = Array.isArray(coalescedMessages[firstUserIdx].content)
          ? [...coalescedMessages[firstUserIdx].content]
          : [{ text: coalescedMessages[firstUserIdx].content }]

        // Insert page images before the text block (after document block if present)
        const textIdx = existingContent.findIndex(b => b.text)
        const insertAt = textIdx !== -1 ? textIdx : existingContent.length

        for (let p = 1; p <= pageCount; p++) {
          const pageKey = `pulse/${tenantId}/items/${itemId}/pages/page-${String(p).padStart(3, '0')}.png`
          try {
            const pageBytes = await getS3Bytes(process.env.DATA_BUCKET, pageKey)
            if (pageBytes) {
              existingContent.splice(insertAt + (p - 1), 0, { image: { format: 'png', source: { bytes: pageBytes } } })
            }
          } catch {
            log('warn', 'Chat: failed to read page image, skipping', { requestId, sessionId, tenantId, page: p })
          }
        }

        // Prompt Cache Priming: Insert document-level cache point after all document/image blocks
        // and before the text block. This marks the boundary of the cacheable document prefix
        // so Bedrock can cache the system prompt + document + page images across turns.
        if (nativeDocBytes) {
          const cacheTextIdx = existingContent.findIndex(b => b.text)
          if (cacheTextIdx > 0) {
            existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
          }
        }

        coalescedMessages[firstUserIdx] = { role: 'user', content: existingContent }
      }
    }

    // Prompt Cache Priming: Insert document-level cache point when native doc is present
    // but there are no page images (pageCount === 0). The page images block above handles
    // the case when pageCount > 0.
    if (isDocumentInjectionTurn && itemType === 'document' && nativeDocBytes && pageCount === 0) {
      const firstUserIdx = coalescedMessages.findIndex(m => m.role === 'user')
      if (firstUserIdx !== -1) {
        const existingContent = Array.isArray(coalescedMessages[firstUserIdx].content)
          ? [...coalescedMessages[firstUserIdx].content]
          : [{ text: coalescedMessages[firstUserIdx].content }]
        const cacheTextIdx = existingContent.findIndex(b => b.text)
        if (cacheTextIdx > 0) {
          existingContent.splice(cacheTextIdx, 0, { cachePoint: { type: 'default' } })
        }
        coalescedMessages[firstUserIdx] = { role: 'user', content: existingContent }
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
    // System prompt with cache point — enables Bedrock prompt caching on all turns
    const systemBlocks = [
      { text: systemPrompt },
      { cachePoint: { type: 'default' } },
    ]

    const bedrockStart = Date.now()

    let agentText = ''
    let tokensIn = 0
    let tokensOut = 0
    let cacheReadInputTokens = 0
    let cacheWriteInputTokens = 0

    if (isStreaming) {
      // 4.1: Streaming path — ConverseStream
      try {
        const streamResponse = await bedrock.send(new ConverseStreamCommand({
          modelId: process.env.BEDROCK_MODEL_ID,
          system: systemBlocks,
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
            cacheReadInputTokens = event.metadata.usage.cacheReadInputTokens || 0
            cacheWriteInputTokens = event.metadata.usage.cacheWriteInputTokens || 0
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
        system: systemBlocks,
        messages: coalescedMessages,
        inferenceConfig: { maxTokens: 1024 },
      }))

      agentText = bedrockResponse.output?.message?.content?.[0]?.text || ''
      tokensIn = bedrockResponse.usage?.inputTokens || 0
      tokensOut = bedrockResponse.usage?.outputTokens || 0
      cacheReadInputTokens = bedrockResponse.usage?.cacheReadInputTokens || 0
      cacheWriteInputTokens = bedrockResponse.usage?.cacheWriteInputTokens || 0
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
    // Two-Phase Session Start: also transition to in_progress when a non-special message
    // arrives for a not_started session.
    const needsStatusTransition = isFirstMessage || (status === 'not_started' && !isSpecial)
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

      if (needsStatusTransition) {
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
    const metrics = [
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
      { MetricName: 'ChatMessages', Value: 1, Unit: 'Count' },
    ]

    if (cacheReadInputTokens > 0) {
      metrics.push({ MetricName: 'CacheReadInputTokens', Value: cacheReadInputTokens, Unit: 'Count' })
    }
    if (cacheWriteInputTokens > 0) {
      metrics.push({ MetricName: 'CacheWriteInputTokens', Value: cacheWriteInputTokens, Unit: 'Count' })
    }

    await putMetrics(metrics)

    log('info', 'Chat: success', {
      requestId, sessionId, tenantId,
      bedrockLatency, tokensIn, tokensOut,
      cacheReadInputTokens, cacheWriteInputTokens,
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



// 4.1: Streaming handler wrapped with awslambda.streamifyResponse()
// Falls back to standard handler when responseStream is not available (API Gateway proxy)
const streamingHandler = async (event, responseStream, context) => {
  return handleChat(event, responseStream)
}

// Export: use streamifyResponse if available (Lambda streaming), otherwise standard handler
export const handler = typeof globalThis.awslambda?.streamifyResponse === 'function'
  ? globalThis.awslambda.streamifyResponse(streamingHandler)
  : async (event) => handleChat(event, null)

// Re-export from shared module for test compatibility
export { computeTimeAllocations, DEPTH_MULTIPLIER, buildSystemPrompt } from './shared/buildSystemPrompt.mjs'
