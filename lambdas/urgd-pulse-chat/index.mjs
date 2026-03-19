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

    // 4. Save reviewer message (skip for special start/resume messages)
    const isSpecial = SPECIAL_MESSAGES.includes(message)
    if (!isSpecial || message === '__session_end__') {
      if (!isSpecial || message !== '__session_end__') {
        // Only save non-special messages as reviewer messages
      }
    }

    const reviewerMessageId = ulid()
    if (!SPECIAL_MESSAGES.includes(message) || message === '__session_end__') {
      if (!['__session_start__', '__session_resume__'].includes(message)) {
        await dynamo.send(new PutItemCommand({
          TableName: process.env.TRANSCRIPTS_TABLE,
          Item: {
            sessionId: { S: sessionId },
            messageId: { S: reviewerMessageId },
            role: { S: 'reviewer' },
            content: { S: message },
            timestamp: { S: new Date().toISOString() },
          },
        }))
      }
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

    // 7. Build system prompt
    let systemPrompt = `You are a professional feedback facilitator conducting a structured review session. Your role is to guide the reviewer through a thoughtful discussion of the document provided.

Document content:
${itemContent || '(No document content available)'}

You are conducting a ${totalSections}-section review. The reviewer is currently on section ${currentSection} of ${totalSections}.

Guidelines:
- Ask one focused question at a time
- Acknowledge the reviewer's responses before moving forward
- Keep the conversation natural and professional
- When transitioning between sections, clearly signal the transition
- Signal section transitions by including [SECTION:N] in your response where N is the new section number
- Signal completion by including [SESSION_COMPLETE] when all sections are covered`

    if (windingDown === 'true') {
      systemPrompt += '\n\nIMPORTANT: You are approaching the time limit. Begin wrapping up the current section naturally and prepare to move toward a closing summary.'
    } else if (windingDown === 'final') {
      systemPrompt += '\n\nIMPORTANT: The session is nearly at the time limit. Deliver a brief closing summary of what has been covered and thank the reviewer for their time.'
    }

    if (message === '__session_start__') {
      systemPrompt += '\n\nThis is the start of the session. Introduce yourself briefly, explain the review process, and present the first section topic with an opening question.'
    } else if (message === '__session_resume__') {
      systemPrompt += '\n\nThe reviewer has returned to a session in progress. Acknowledge their return warmly and reference where you left off in the review.'
    } else if (message === '__session_end__') {
      systemPrompt += '\n\nThe reviewer has chosen to end the session early. Generate a brief, professional closing summary of the topics covered so far.'
    }

    // Build messages for Bedrock
    const bedrockMessages = history.length > 0 ? history : []
    if (['__session_start__', '__session_resume__', '__session_end__'].includes(message)) {
      bedrockMessages.push({ role: 'user', content: `[${message}]` })
    } else {
      bedrockMessages.push({ role: 'user', content: message })
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
    log('error', 'Chat: unexpected error', { requestId, sessionId, tenantId, errorName: err.name })
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
    return errorResponse(500, 'Failed to process chat message', {}, origin)
  }
}
