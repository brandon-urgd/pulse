// ur/gd pulse — Chat Lambda
// POST /api/session/{sessionId}/chat
// Handles AI-guided feedback conversation via Bedrock

import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
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

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const sessionId = event?.requestContext?.authorizer?.sessionId
  const tenantId = event?.requestContext?.authorizer?.tenantId

  if (!sessionId || !tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return errorResponse(400, 'Invalid request body', {}, origin)
  }

  const { message, windingDown } = body

  if (!message || typeof message !== 'string') {
    return errorResponse(400, 'message is required', {}, origin)
  }

  try {
    // 1. Get session record
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
    }))

    if (!sessionResult.Item) {
      return errorResponse(404, 'Session not found', {}, origin)
    }

    const session = sessionResult.Item

    // 2. Validate confidentialityAcceptedAt
    if (!session.confidentialityAcceptedAt?.S) {
      log('warn', 'Chat: confidentiality not accepted', { requestId, sessionId, tenantId })
      return errorResponse(403, 'Confidentiality agreement not accepted', {}, origin)
    }

    // 3. Validate status
    const status = session.status?.S
    if (status === 'expired' || status === 'completed') {
      log('info', 'Chat: session not active', { requestId, sessionId, tenantId, status })
      return errorResponse(410, 'Session is no longer active', {}, origin)
    }

    const itemId = session.itemId?.S
    let currentSection = parseInt(session.currentSection?.N || '1', 10)
    const totalSections = parseInt(session.totalSections?.N || '5', 10)

    // 4. Save reviewer message
    const reviewerMessageId = ulid()
    // Save all messages to transcript — including special messages as their bracket form
    // so conversation history always has alternating user/assistant roles
    const isSpecial = SPECIAL_MESSAGES.includes(message)
    const transcriptContent = isSpecial ? `[${message}]` : message

    // Skip saving __session_end__ as reviewer message (saved before Bedrock call below)
    if (message !== '__session_end__') {
      await dynamo.send(new PutItemCommand({
        TableName: process.env.TRANSCRIPTS_TABLE,
        Item: {
          sessionId: { S: sessionId },
          messageId: { S: reviewerMessageId },
          role: { S: 'reviewer' },
          content: { S: transcriptContent },
          timestamp: { S: new Date().toISOString() },
        },
      }))
    }

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

    // 6. Load item content from S3
    let itemContent = ''
    if (itemId && tenantId) {
      const extractedKey = `pulse/${tenantId}/items/${itemId}/extracted.md`
      const documentKey = `pulse/${tenantId}/items/${itemId}/document.md`
      itemContent = await getS3Text(process.env.DATA_BUCKET, extractedKey)
        || await getS3Text(process.env.DATA_BUCKET, documentKey)
        || ''
    }

    // 6b. Load item metadata (name, description) from DynamoDB
    let itemName = 'this item'
    let itemDescription = ''
    if (itemId && tenantId) {
      try {
        const itemResult = await dynamo.send(new GetItemCommand({
          TableName: process.env.ITEMS_TABLE,
          Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
          ProjectionExpression: 'itemName, description',
        }))
        if (itemResult.Item) {
          itemName = itemResult.Item.itemName?.S || 'this item'
          itemDescription = itemResult.Item.description?.S || ''
        }
      } catch {
        // Non-fatal — fall back to generic name
      }
    }

    // 7. Build system prompt
    let systemPrompt = `You are Pulse — an AI feedback agent built by ur/gd Studios. You guide reviewers through structured, one-on-one feedback sessions.

Your personality:
- Warm, calm, and conversational — like a thoughtful colleague, not a chatbot
- Respectful of the reviewer's time and attention
- Patient and unhurried — one question at a time, never overwhelming
- Quietly confident — you know the material, but you're here to listen, not lecture
- Brief and natural — keep messages short and human. No walls of text.

Communication style:
- Use short paragraphs. Two to three sentences max per thought.
- Never use bullet points or numbered lists in conversation — speak naturally.
- Acknowledge what the reviewer said before moving on. Make them feel heard.
- Ask one focused question at a time. Wait for their answer.
- Transition between sections conversationally, not mechanically.

The item being reviewed:
- Name: "${itemName}"
${itemDescription ? `- Context: ${itemDescription}` : ''}

Document content:
${itemContent || '(No document content available)'}

Session structure:
- This is a ${totalSections}-section review. Current section: ${currentSection} of ${totalSections}.
- Each section should feel like a natural conversation, not an interrogation.
- When you move to a new section, include [SECTION:N] (where N is the section number) at the very end of your message — after all your visible text. The reviewer never sees this tag.
- When all sections are covered, include [SESSION_COMPLETE] at the very end of your final message.

Important:
- Never show [SECTION:N] or [SESSION_COMPLETE] tags inline with your conversational text. Always place them on their own line at the very end.
- Never refer to sections by number with the reviewer. Use natural transitions like "Let's shift gears" or "I'd love to hear your thoughts on another angle."
- If the reviewer goes off-topic, gently guide them back without being dismissive.
- If the reviewer gives a short answer, that's okay — acknowledge it and move on. Don't push.`

    if (windingDown === 'true') {
      systemPrompt += '\n\nThe session is approaching its time limit. Start wrapping up the current topic naturally. Don\'t mention the time limit directly — just begin steering toward a close.'
    } else if (windingDown === 'final') {
      systemPrompt += '\n\nThe session is nearly out of time. Deliver a brief, warm closing. Thank the reviewer for their time. Summarize what you covered together in a sentence or two. Let them know they can come back to continue.'
    }

    if (message === '__session_start__') {
      systemPrompt += `\n\nThis is the very start of the session. Send your opening as a series of short, distinct thoughts — not one big block. Structure it like this:

1. First message: A warm, brief greeting. Introduce yourself as Pulse. One to two sentences max. Example tone: "Hey! I'm Pulse, an AI feedback agent powered by ur/gd Studios."

2. Then explain what you're here to do: "I'm here to walk you through ${itemName} and hear what you think. We'll cover it in ${totalSections} sections — just a conversation, nothing formal."

3. Then let them know they're in control: "You can take your time, and if you ever want to stop early, just tap 'End session' at the top."

4. Then invite them to begin: "Ready to dive in? Or any questions before we start?"

Keep each thought to one or two sentences. Be warm but not over-the-top. This should feel like the start of a good conversation, not a briefing.`
    } else if (message === '__session_resume__') {
      systemPrompt += '\n\nThe reviewer has returned to continue their session. Welcome them back warmly and briefly. Reference where you left off. Keep it to two or three short sentences — don\'t re-explain the whole process.'
    } else if (message === '__session_end__') {
      systemPrompt += '\n\nThe reviewer has chosen to end the session early. Thank them genuinely for the time they gave. Briefly mention what you covered together (one sentence). Keep it warm and short — no more than three sentences total.'
    }

    // Build messages for Bedrock
    // For __session_end__, save the reviewer message now (before Bedrock) so transcript
    // has the complete user→assistant pair written before status transitions to completed
    const bedrockMessages = [...history]
    if (message === '__session_end__') {
      const endMessageId = ulid()
      await dynamo.send(new PutItemCommand({
        TableName: process.env.TRANSCRIPTS_TABLE,
        Item: {
          sessionId: { S: sessionId },
          messageId: { S: endMessageId },
          role: { S: 'reviewer' },
          content: { S: '[__session_end__]' },
          timestamp: { S: new Date().toISOString() },
        },
      }))
      bedrockMessages.push({ role: 'user', content: '[__session_end__]' })
    }

    // 8. Invoke Bedrock
    const bedrockStart = Date.now()
    const bedrockPayload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages: bedrockMessages,
    }

    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(bedrockPayload),
    }))

    const bedrockLatency = Date.now() - bedrockStart
    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const agentText = responseBody.content?.[0]?.text || ''
    const tokensIn = responseBody.usage?.input_tokens || 0
    const tokensOut = responseBody.usage?.output_tokens || 0

    // Annotate X-Ray trace with Bedrock metadata
    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: tokensIn,
      bedrockTokensOut: tokensOut,
    })

    // 9. Save agent response
    const agentMessageId = ulid()
    await dynamo.send(new PutItemCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      Item: {
        sessionId: { S: sessionId },
        messageId: { S: agentMessageId },
        role: { S: 'agent' },
        content: { S: agentText },
        timestamp: { S: new Date().toISOString() },
      },
    }))

    // 10. Update currentSection if agent signals section transition
    const sectionMatch = agentText.match(/\[SECTION:(\d+)\]/)
    if (sectionMatch) {
      const newSection = parseInt(sectionMatch[1], 10)
      if (newSection > currentSection && newSection <= totalSections) {
        currentSection = newSection
      }
    }

    // 11. If first message: update status to in_progress, set startedAt
    const isFirstMessage = message === '__session_start__'
    const sessionComplete = message === '__session_end__' || agentText.includes('[SESSION_COMPLETE]')

    const updateExprParts = ['#updatedAt = :updatedAt', 'currentSection = :cs']
    const updateNames = { '#updatedAt': 'updatedAt' }
    const updateValues = {
      ':updatedAt': { S: new Date().toISOString() },
      ':cs': { N: String(currentSection) },
    }

    if (isFirstMessage) {
      updateExprParts.push('#status = :status', 'startedAt = :startedAt')
      updateNames['#status'] = 'status'
      updateValues[':status'] = { S: 'in_progress' }
      updateValues[':startedAt'] = { S: new Date().toISOString() }
    }

    // 13. If sessionComplete: update status to completed, set completedAt
    if (sessionComplete) {
      updateExprParts.push('#status = :status', 'completedAt = :completedAt')
      updateNames['#status'] = 'status'
      updateValues[':status'] = { S: 'completed' }
      updateValues[':completedAt'] = { S: new Date().toISOString() }
    }

    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      UpdateExpression: `SET ${updateExprParts.join(', ')}`,
      ExpressionAttributeNames: updateNames,
      ExpressionAttributeValues: updateValues,
    }))

    // 13. Invoke generateSessionSummary async if complete
    if (sessionComplete) {
      const generateFnName = process.env.GENERATE_SESSION_SUMMARY_FUNCTION_NAME
      if (generateFnName) {
        try {
          await lambda.send(new InvokeCommand({
            FunctionName: generateFnName,
            InvocationType: 'Event',
            Payload: JSON.stringify({ sessionId, tenantId }),
          }))
        } catch (err) {
          log('warn', 'Chat: failed to invoke generateSessionSummary', { requestId, sessionId, tenantId, errorName: err.name })
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

    return createResponse(200, {
      data: {
        message: agentText,
        section: currentSection,
        sessionComplete,
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'Chat: unexpected error', { requestId, sessionId, tenantId, errorName: err.name, errorMessage: err.message, stack: err.stack })
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])

    if (err.name === 'AccessDeniedException') {
      return errorResponse(503, 'AI service temporarily unavailable', {}, origin)
    }
    if (err.name === 'ThrottlingException' || err.name === 'ServiceUnavailableException') {
      return errorResponse(503, 'AI service temporarily unavailable — please try again', {}, origin)
    }
    return errorResponse(500, 'Failed to process chat message', {}, origin)
  }
}
