// ur/gd pulse — Suggest Description Lambda
// POST /api/manage/items/{itemId}/suggest-description
// Generates AI-powered feedback request suggestions using document/image context

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['ITEMS_TABLE', 'DATA_BUCKET', 'BEDROCK_MODEL_ID', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

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

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    log('warn', 'SuggestDescription: missing tenantId in authorizer context', { requestId })
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

  const { roughInput, itemType } = body

  try {
    // 1. Fetch item record — verify ownership
    const itemResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!itemResult.Item) {
      return errorResponse(404, 'Item not found', {}, origin)
    }

    // Verify tenant ownership
    if (itemResult.Item.tenantId?.S !== tenantId) {
      return errorResponse(403, 'Forbidden', {}, origin)
    }

    const item = itemResult.Item
    const documentKey = item.documentKey?.S
    const resolvedItemType = itemType || item.itemType?.S || 'document'

    // 2. Gather context — document text or image
    let documentContext = null
    let imageBytes = null

    if (documentKey) {
      if (resolvedItemType === 'image') {
        imageBytes = await getS3Bytes(process.env.DATA_BUCKET, documentKey)
      } else {
        // Try extracted text first, then raw document
        const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
        documentContext = await getS3Text(process.env.DATA_BUCKET, extractedKey)
        if (!documentContext) {
          const docKey = `pulse/${tenantId}/items/${itemId}/document.md`
          documentContext = await getS3Text(process.env.DATA_BUCKET, docKey)
        }
      }
    }

    // 3. Validate — need at least roughInput or document/image
    const hasRoughInput = roughInput && typeof roughInput === 'string' && roughInput.trim().length > 0
    const hasDocument = !!documentContext
    const hasImage = !!imageBytes

    if (!hasRoughInput && !hasDocument && !hasImage) {
      return errorResponse(400, 'Provide input text or upload a document first', {}, origin)
    }

    // 4. Build Bedrock prompt
    const systemPrompt = `You are a writing assistant helping someone articulate what kind of feedback they want on their work. They may give you rough notes, a document, or an image. Your job is to turn their rough intent into a clear, specific 2-3 sentence feedback request that a reviewer can act on.

Rules:
- Write in first person from the perspective of the person requesting feedback ("I'd like feedback on...")
- Be specific about what aspects to focus on
- Keep it to 2-3 sentences
- If they provided rough notes, expand and clarify them
- If they provided a document or image, identify the most important aspects worth getting feedback on
- Return ONLY the suggestion text, no other commentary`

    const userParts = []
    if (hasRoughInput) {
      userParts.push(`My rough notes on what I want feedback on: "${roughInput.trim()}"`)
    }
    if (hasDocument) {
      userParts.push(`Here's the document content (first 10,000 chars):\n${documentContext.slice(0, 10000)}`)
    }

    const messages = []
    if (hasImage && !hasRoughInput && !hasDocument) {
      // Image-only: use multimodal content block
      const ext = (documentKey || '').split('.').pop()?.toLowerCase() || 'jpeg'
      const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
      const mediaType = mediaTypeMap[ext] || 'image/jpeg'
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBytes.toString('base64') } },
          { type: 'text', text: 'Generate a feedback request suggestion for this image.' },
        ],
      })
    } else if (hasImage && hasRoughInput) {
      const ext = (documentKey || '').split('.').pop()?.toLowerCase() || 'jpeg'
      const mediaTypeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
      const mediaType = mediaTypeMap[ext] || 'image/jpeg'
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBytes.toString('base64') } },
          { type: 'text', text: `My rough notes on what I want feedback on: "${roughInput.trim()}"` },
        ],
      })
    } else {
      messages.push({ role: 'user', content: userParts.join('\n\n') })
    }

    // 5. Call Bedrock
    const bedrockPayload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 512,
      system: systemPrompt,
      messages,
    }

    let bedrockResponse
    try {
      bedrockResponse = await bedrock.send(new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(bedrockPayload),
      }))
    } catch (err) {
      log('error', 'SuggestDescription: Bedrock error', { requestId, tenantId, itemId, errorName: err.name })
      return errorResponse(500, 'Failed to generate suggestion', {}, origin)
    }

    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const suggestion = responseBody.content?.[0]?.text || ''

    log('info', 'SuggestDescription: suggestion generated', { requestId, tenantId, itemId })

    return createResponse(200, { data: { suggestion: suggestion.trim() } }, {}, origin)
  } catch (err) {
    log('error', 'SuggestDescription: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to generate suggestion', {}, origin)
  }
}
