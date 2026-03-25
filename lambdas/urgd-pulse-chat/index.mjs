// ur/gd pulse — Chat Lambda
// POST /api/session/{sessionId}/chat
// Handles AI-guided feedback conversation via Bedrock

import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb'
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
  // Preview flag passed from sessionAuth authorizer context
  const isPreview = event?.requestContext?.authorizer?.preview === 'true'

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
    const timeLimitMinutes = parseInt(session.timeLimitMinutes?.N || '30', 10)
    const startedAt = session.startedAt?.S
    // closingState: exploring → narrowing → closing → closed
    let closingState = session.closingState?.S || 'exploring'
    // graceMessagesRemaining: how many reviewer messages left in the grace window
    let graceMessagesRemaining = parseInt(session.graceMessagesRemaining?.N || '2', 10)

    // 4. Prepare reviewer message — written atomically with agent response after Bedrock succeeds
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

Assume the reviewer has not read the document. Your job is to bring the content to them — summarize sections in your own words, quote specific phrases when they matter, and give the reviewer enough context to react without needing to read anything first. The original document is available for reference if they want it, but the session should work completely without it.

Communication style:
- Each paragraph you write will appear as its own chat bubble — but don't make every sentence its own bubble. Group related thoughts together. A good bubble is two to four sentences that belong together. A question always gets its own bubble.
- Every paragraph must be two to four sentences max. When summarizing document content, break it into multiple short paragraphs rather than one dense block.
- Separate each thought with a blank line. Every distinct idea gets its own short paragraph.
- Never send a wall of text. If you have multiple things to say, space them out with line breaks.
- Never use bullet points, numbered lists, or markdown formatting (no bold, no headers). Speak naturally, like a real conversation.
- Acknowledge what the reviewer said before moving on. Make them feel heard.
- Ask one focused question at a time. Wait for their answer. Your question MUST be its own paragraph, separated by a blank line from everything above it. Never attach the question to the end of a summary.
- When introducing a section, paraphrase the key idea in two to three short paragraphs. Don't recite the document — distill it. Pull direct quotes only when the exact wording matters (names, claims, specific numbers, language choices). Example: "The document describes ur/gd as a Washington State LLC — does that match?"
- Never ask the reviewer to react to something you haven't shown them. If your question references a concept from the document, summarize or quote it first.
- Transition lines should be short and standalone — "Let's shift gears" or "One more area to cover." Never name the full topic in the transition line. The topic name goes in the next paragraph.
- Never start two consecutive responses with the same word. Avoid starting with "Good" or "That" more than twice in a session. Sometimes the best acknowledgment is no acknowledgment — just move naturally into your next thought. "Noted." or simply starting with the next topic is fine.

Asking good questions:
- Match the question to the content type. Never use the word "feel" when asking about legal, financial, or structural content. Reserve "feel" for questions about values, culture, or personal vision. For everything else, use "match," "reflect," "look right," or "work for you."
- For factual or identity content (names, dates, structure): ask if it's accurate or if anything looks off. "Does that match how you'd describe it?" or "Anything there that doesn't look right?"
- For process or operational content: ask if it reflects how things actually work. "Does that match reality day to day?"
- For values, vision, or opinion content: then open-ended questions work. "How does that sit with you?" is fine here.
- Keep questions short and specific. One sentence. Give the reviewer something concrete to react to.

The item being reviewed:
- Name: "${itemName}"

${itemDescription
  ? `Feedback focus (from the person who created this session):
"${itemDescription}"

This is your primary steering signal. It tells you what the tenant cares about most. Shape your questions around it. When choosing which parts of a section to dig into vs. skim, use this as your filter. Sections that connect to this focus deserve your best, most specific questions. Sections that don't can be acknowledged more briefly.`
  : `No specific feedback focus was provided. Default to a balanced walkthrough: for each section, identify the most consequential claim, decision, or assumption and ask the reviewer to react to it. Prioritize sections that contain tradeoffs, risks, or open questions over sections that are purely informational.`}

Document content:
${itemContent || '(No document content available)'}

Session structure:
- This is a ${totalSections}-section review. Current section: ${currentSection} of ${totalSections}.
- Each section should have at least two substantive exchanges before transitioning. If the reviewer gives a short confirmation, ask one follow-up before moving on — even if it's just "Anything you'd change about that section if you could?" A single yes/no doesn't count as exploring a topic.
- Each section should feel like a natural conversation, not an interrogation.
- When you move to a new section, include [SECTION:N] (where N is the section number) at the very end of your message — after all your visible text. The reviewer never sees this tag.
- Before transitioning to a new section, consider whether the tenant's feedback focus applies to the upcoming content. If it does, lead with a question that connects the section to that focus. If it doesn't, acknowledge the section more briefly and move on. Not every section deserves equal depth — the feedback focus tells you where to invest.
- When all sections are covered, include [SESSION_COMPLETE] at the very end of your final message.

Important:
- Never show [SECTION:N] or [SESSION_COMPLETE] tags inline with your conversational text. Always place them on their own line at the very end.
- Never refer to sections by number with the reviewer. Use natural transitions like "Let's shift gears" or "I'd love to hear your thoughts on another angle."
- If the reviewer goes off-topic, gently guide them back without being dismissive.
- If the reviewer gives a short answer, that's okay — acknowledge it and move on. Don't push.
- If the reviewer hints at something deeper ("we've changed a lot," "that part concerns me," "it's complicated"), follow up. Ask them to tell you more. Don't move on until you've given them space to share what's on their mind. This is the most valuable part of the session.
- Only move to the next section when the current topic feels genuinely explored — not after a single question-and-answer exchange.
- If the reviewer confirms everything is fine for three or more consecutive turns, gently probe for something they might not have considered. Don't accept "looks good" as the final word on every section. A good reviewer sometimes needs a nudge to think about edge cases or gaps they haven't noticed. Try: "One thing I notice the document doesn't address is..." or "What would happen if [specific scenario]?" — but only when it's genuine, not manufactured.
- If the reviewer disagrees with something in the document or pushes back, that's valuable. Welcome it. Don't defend the document or explain it away — your job is to capture their honest reaction, not convince them.
- If the reviewer asks about something the document doesn't cover, say so honestly. "I don't see that addressed in the document" is a perfectly good answer. Never make up details about the item.
- Vary your acknowledgments. Don't say "Great question!" or "That's a really insightful point!" on every turn. A simple "Got it," "That makes sense," "Noted," or just moving naturally into your next thought is better. Be genuine, not performative.
- If the reviewer responds with depth and specificity, they may have read the document — match their level. If they respond with short or general answers, they likely haven't — give them more context before asking your next question. Calibrate how much content you surface based on how much the reviewer already seems to know.
- If the reviewer seems uncertain, confused, or asks a clarifying question about a section, offer to show them more. Something like "I can share more of that section if it'd help" or "Want me to pull up the details on that part?" Only offer when the moment calls for it — not after every summary. Read the conversation, not a checklist.`

    if (windingDown === 'true') {
      systemPrompt += '\n\nThe session is approaching its suggested time. This is a soft pacing signal — not a hard stop. Let the reviewer finish their current thought completely before you begin steering toward a natural close. Never cut off a response mid-thought. If they\'re in the middle of something meaningful, follow it through. Then begin wrapping the current topic naturally. Don\'t mention the time limit directly.'
    } else if (windingDown === 'final') {
      systemPrompt += '\n\nThe session is near the end of its suggested time. This is still a soft signal — if the reviewer is mid-thought or has just said something worth following up on, honor that first. Then deliver a brief, warm closing. Thank the reviewer for their time. Summarize what you covered together in a sentence or two. Let them know they can come back to continue. Never leave a reviewer feeling cut off.'
    }

    // Reflection pause guidance — added to all sessions
    systemPrompt += '\n\nReflection pauses: At key moments — after presenting a complex or consequential section, or just before your closing question — you may invite the reviewer to take a moment before answering. Use phrases like "Take a moment before answering." or "What\'s your gut reaction to that?" These signal that thoughtful answers are valued. Use sparingly — not every exchange, just when the content genuinely warrants it.'

    // Closing state system prompt additions
    if (closingState === 'narrowing') {
      systemPrompt += '\n\nThe session is entering its final phase. Begin naturally focusing the conversation — go deeper on the current topic rather than opening new ones. Do not announce this shift. Let the conversation feel like it\'s finding its natural depth, not winding down.'
    } else if (closingState === 'closing') {
      systemPrompt += '\n\nThe session is in its closing phase. You MUST wrap up within the next two exchanges. Send your genuine final question — something the reviewer actually wants to answer, not a formality. After they respond, send one warm final reply that acknowledges what they shared, thank them for their time, and include [SESSION_COMPLETE] at the very end. Do not ask new questions. Do not open new topics. If the reviewer has already answered your closing question, skip straight to the thank-you and [SESSION_COMPLETE]. The session will be force-closed if you do not emit [SESSION_COMPLETE] soon.'
    } else if (closingState === 'closed') {
      systemPrompt += '\n\nThis session is complete. Do not respond to further messages.'
    }

    if (message === '__session_start__') {
      systemPrompt += `\n\nThis is the very start of the session. Send your opening as a series of short, distinct thoughts — not one big block. Structure it like this:

1. First message: A warm, brief greeting. Introduce yourself as Pulse. One to two sentences max. Example tone: "Hey! I'm Pulse, an AI feedback agent powered by ur/gd Studios."

2. Then explain what you're here to do: "I'm here to walk you through ${itemName} and hear what you think — just a conversation, nothing formal."

3. Then let them know they're in control: "You can take your time, and if you ever want to stop early, just tap 'End session' at the top."

4. Then invite them to begin: "Ready to dive in? Or any questions before we start?"

Keep each thought to one or two sentences. Be warm but not over-the-top. This should feel like the start of a good conversation, not a briefing. Do NOT mention the number of sections.`
    } else if (message === '__session_resume__') {
      systemPrompt += '\n\nThe reviewer has returned to continue their session. Welcome them back warmly and briefly. Reference where you left off. Keep it to two or three short sentences — don\'t re-explain the whole process.'
    } else if (message === '__session_end__') {
      systemPrompt += '\n\nThe reviewer has chosen to end the session early. Thank them genuinely for the time they gave. Briefly mention what you covered together (one sentence). Keep it warm and short — no more than three sentences total.'
    }

    // Build messages for Bedrock — reviewer message written atomically after Bedrock succeeds
    const bedrockMessages = [...history]
    if (message === '__session_end__') {
      bedrockMessages.push({ role: 'user', content: '[__session_end__]' })
    } else if (!isSpecial) {
      // Regular message — add to Bedrock context (will be written atomically on success)
      bedrockMessages.push({ role: 'user', content: message })
    } else if (message === '__session_start__' || message === '__session_resume__') {
      // Seed Bedrock with the trigger so it has a user turn to respond to
      bedrockMessages.push({ role: 'user', content: transcriptContent })
    }

    // Coalesce consecutive same-role messages — Bedrock requires strictly alternating
    // user/assistant roles. Race conditions (double-send, network retry) can produce
    // consecutive user messages in the transcript. Merge them so Bedrock never rejects.
    const coalescedMessages = []
    for (const msg of bedrockMessages) {
      const prev = coalescedMessages[coalescedMessages.length - 1]
      if (prev && prev.role === msg.role) {
        prev.content += '\n\n' + msg.content
      } else {
        coalescedMessages.push({ ...msg })
      }
    }

    // Bedrock requires the first message to be role: 'user'. If history starts with
    // an orphaned assistant message (shouldn't happen, but defensive), drop it.
    while (coalescedMessages.length > 0 && coalescedMessages[0].role !== 'user') {
      coalescedMessages.shift()
    }

    if (coalescedMessages.length === 0) {
      log('error', 'Chat: no valid messages after coalescing', { requestId, sessionId, tenantId })
      return errorResponse(400, 'No valid messages to process', {}, origin)
    }

    // 8. Invoke Bedrock
    const bedrockStart = Date.now()
    const bedrockPayload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages: coalescedMessages,
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

    // 9. Atomically write reviewer + agent messages — nothing written if Bedrock failed
    // In preview mode: skip all DynamoDB writes — transcript and session state are not persisted
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
    const sectionMatch = agentText.match(/\[SECTION:(\d+)\]/)
    if (sectionMatch) {
      const newSection = parseInt(sectionMatch[1], 10)
      if (newSection > currentSection && newSection <= totalSections) {
        currentSection = newSection
      }
    }

    // 10b. Compute closing state transitions
    // Time-based: narrowing at ~70% elapsed, closing when model sends closing question
    // Turn-based grace window: closing → closed after 2 reviewer messages + 1 agent reply
    let newClosingState = closingState
    let newGraceMessagesRemaining = graceMessagesRemaining

    if (closingState === 'exploring' && !isSpecial && startedAt && timeLimitMinutes > 0) {
      const elapsedMs = Date.now() - new Date(startedAt).getTime()
      const remainingMs = (timeLimitMinutes * 60 * 1000) - elapsedMs
      // Absolute threshold: narrowing when 4 minutes remain — scales correctly at all session lengths
      if (remainingMs <= 4 * 60 * 1000) {
        newClosingState = 'narrowing'
      }
    }

    if ((closingState === 'narrowing' || closingState === 'exploring') && windingDown === 'final') {
      // Model is sending its closing question — transition to closing
      newClosingState = 'closing'
      newGraceMessagesRemaining = 4
    }

    if (closingState === 'closing' && !isSpecial) {
      // Count down grace window: each reviewer message decrements the counter
      // After the agent's final reply (graceMessagesRemaining === 0), transition to closed
      if (graceMessagesRemaining <= 0) {
        newClosingState = 'closed'
      } else {
        newGraceMessagesRemaining = graceMessagesRemaining - 1
      }
    }

    // SESSION_COMPLETE tag always closes regardless of state
    if (agentText.includes('[SESSION_COMPLETE]')) {
      newClosingState = 'closed'
    }

    // 11. If first message: update status to in_progress, set startedAt
    const isFirstMessage = message === '__session_start__'
    // Session is complete if: reviewer ended early, model emitted [SESSION_COMPLETE],
    // or the grace window expired (closingState transitioned to 'closed').
    // Without this, the grace window expiry leaves the session in a dead state —
    // input disabled but no completion card shown.
    const sessionComplete = message === '__session_end__' || agentText.includes('[SESSION_COMPLETE]') || newClosingState === 'closed'

    // In preview mode: skip all session state updates and downstream invocations
    if (!isPreview) {
      const updateExprParts = ['#updatedAt = :updatedAt', 'currentSection = :cs', 'closingState = :closingState', 'graceMessagesRemaining = :grace']
      const updateNames = { '#updatedAt': 'updatedAt' }
      const updateValues = {
        ':updatedAt': { S: new Date().toISOString() },
        ':cs': { N: String(currentSection) },
        ':closingState': { S: newClosingState },
        ':grace': { N: String(newGraceMessagesRemaining) },
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

      // 13. Invoke generateSessionSummary and generateReport async if complete
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

    return createResponse(200, {
      data: {
        message: agentText,
        section: currentSection,
        sessionComplete,
        closingState: newClosingState,
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
