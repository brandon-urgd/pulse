// ur/gd pulse — PreGenerate Lambda
// Async invocation from AcceptConfidentiality or CreateSelfSession.
// Pre-generates the AI greeting message via Bedrock and stores it on the session record.
// If anything fails, logs and exits — the Chat page falls back to live generation.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { log, requireEnv } from './shared/utils.mjs'
import { buildSystemPrompt } from './shared/buildSystemPrompt.mjs'

requireEnv(['SESSIONS_TABLE', 'ITEMS_TABLE', 'DATA_BUCKET', 'BEDROCK_MODEL_ID'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

// ── S3 helpers (same as Chat Lambda) ──

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

// ── DynamoDB unmarshal (same as Chat Lambda) ──

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

// ── Handler ──

export const handler = async (event) => {
  const { tenantId, sessionId } = event
  if (!tenantId || !sessionId) {
    log('error', 'PreGenerate: missing tenantId or sessionId', { event })
    return
  }

  log('info', 'PreGenerate: starting', { tenantId, sessionId })

  try {
    // 1. Read session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      log('warn', 'PreGenerate: session not found', { tenantId, sessionId })
      return
    }

    const session = sessionResult.Item

    // Skip if session already has a pre-generated greeting
    if (session.preGeneratedGreeting?.S) {
      log('info', 'PreGenerate: greeting already exists, skipping', { tenantId, sessionId })
      return
    }

    // Skip if session is already in progress or completed
    const status = session.status?.S
    if (status === 'in_progress' || status === 'completed' || status === 'expired') {
      log('info', 'PreGenerate: session not in not_started state, skipping', { tenantId, sessionId, status })
      return
    }

    const itemId = session.itemId?.S
    if (!itemId) {
      log('warn', 'PreGenerate: no itemId on session', { tenantId, sessionId })
      return
    }

    // 2. Read frozen snapshot and session params
    const frozenSnapshot = unmarshalMap(session.frozenSnapshot)
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = parseInt(session.totalSections?.N || '5', 10)
    }
    const currentSection = 1
    const timeLimitMinutes = parseInt(session.timeLimitMinutes?.N || '30', 10)
    const isSelfReview = session.isSelfReview?.BOOL === true

    // 3. Read item record
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      log('warn', 'PreGenerate: item not found', { tenantId, sessionId, itemId })
      return
    }

    const item = itemResult.Item
    const itemName = item.itemName?.S || 'this item'
    const itemDescription = item.description?.S || ''
    const itemType = item.itemType?.S || 'document'
    const documentKey = item.documentKey?.S || null
    const pageCount = item.pageCount?.N ? parseInt(item.pageCount.N, 10) : 0
    let coverageMap = null
    if (item.coverageMap?.M) {
      coverageMap = unmarshalMap(item.coverageMap)
    }

    // 4. Load document content from S3
    let itemContent = ''
    if (itemType !== 'image') {
      const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
      const docKey = `pulse/${tenantId}/items/${itemId}/document.md`
      itemContent = await getS3Text(process.env.DATA_BUCKET, extractedKey)
        || await getS3Text(process.env.DATA_BUCKET, docKey)
        || ''
    }

    // 5. Load image for image items
    let imageBase64 = null
    if (itemType === 'image' && documentKey) {
      const imageBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
      if (imageBytes) {
        imageBase64 = imageBytes.toString('base64')
      }
    }

    // 5b. Pre-load native document bytes to determine nativeDocumentAvailable flag
    let nativeDocBytes = null
    if (itemType === 'document' && documentKey) {
      const ext = documentKey.split('.').pop()?.toLowerCase()
      const docMediaTypes = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      if (docMediaTypes[ext]) {
        nativeDocBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
        if (!nativeDocBytes) {
          log('warn', 'PreGenerate: original document not available from S3, falling back to extracted text in prompt', { tenantId, sessionId, documentKey })
        }
      }
    }

    // 6. Build system prompt — same params as Chat Lambda's __session_start__ path
    const systemPrompt = buildSystemPrompt({
      itemName, itemDescription, itemContent, itemType,
      totalSections, currentSection, closingState: 'exploring',
      windingDown: undefined, message: '__session_start__', isSpecial: true,
      frozenSnapshot, coverageMap, imageBase64, isSelfReview,
      timeLimitMinutes,
      nativeDocumentAvailable: !!nativeDocBytes,
    })

    // 7. Build Bedrock message — single user message with [__session_start__]
    const userContent = []

    // Attach image for image items (send-once pattern)
    if (itemType === 'image' && imageBase64) {
      const ext = (documentKey || '').split('.').pop()?.toLowerCase() || 'jpeg'
      userContent.push({
        image: { format: ext === 'png' ? 'png' : 'jpeg', source: { bytes: Buffer.from(imageBase64, 'base64') } },
      })
    }

    // Attach native document for PDF/DOCX items (using pre-loaded bytes)
    if (nativeDocBytes) {
      const ext = documentKey.split('.').pop()?.toLowerCase()
      userContent.push({ document: { format: ext, name: 'document', source: { bytes: nativeDocBytes } } })
    }

    // Attach page images if available
    if (pageCount > 0) {
      for (let p = 1; p <= pageCount; p++) {
        const pageKey = `pulse/${tenantId}/items/${itemId}/pages/page-${String(p).padStart(3, '0')}.png`
        const pageBytes = await getS3Bytes(process.env.DATA_BUCKET, pageKey)
        if (pageBytes) {
          userContent.push({ image: { format: 'png', source: { bytes: pageBytes } } })
        } else {
          log('warn', 'PreGenerate: failed to read page image, skipping', { tenantId, sessionId, pageKey, page: p })
        }
      }
    }

    // The [__session_start__] text message
    userContent.push({ text: '[__session_start__]' })

    const messages = [{ role: 'user', content: userContent }]

    // 8. Invoke Bedrock (non-streaming)
    log('info', 'PreGenerate: invoking Bedrock', { tenantId, sessionId, modelId: process.env.BEDROCK_MODEL_ID })
    const bedrockStart = Date.now()

    const bedrockResponse = await bedrock.send(new ConverseCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: { maxTokens: 1024 },
    }))

    const greetingText = bedrockResponse.output?.message?.content?.[0]?.text || ''
    const bedrockLatency = Date.now() - bedrockStart
    const tokensIn = bedrockResponse.usage?.inputTokens || 0
    const tokensOut = bedrockResponse.usage?.outputTokens || 0

    if (!greetingText) {
      log('warn', 'PreGenerate: Bedrock returned empty greeting', { tenantId, sessionId, bedrockLatency })
      return
    }

    log('info', 'PreGenerate: Bedrock response received', { tenantId, sessionId, bedrockLatency, tokensIn, tokensOut })

    // 9. Write preGeneratedGreeting to session record
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      UpdateExpression: 'SET preGeneratedGreeting = :greeting',
      // Only write if session is still not_started — don't overwrite if session started while we were generating
      ConditionExpression: '#status = :not_started',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':greeting': { S: greetingText },
        ':not_started': { S: 'not_started' },
      },
    }))

    log('info', 'PreGenerate: greeting stored successfully', { tenantId, sessionId, greetingLength: greetingText.length, bedrockLatency, tokensIn, tokensOut })
  } catch (err) {
    // All failures: log and exit without modifying session record
    log('error', 'PreGenerate: failed', { tenantId, sessionId, errorName: err.name, errorMessage: err.message })
  }
}
