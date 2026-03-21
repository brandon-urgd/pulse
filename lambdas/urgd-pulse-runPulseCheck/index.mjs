// ur/gd pulse — Run Pulse Check Lambda
// POST /api/manage/items/{itemId}/pulse-check
//
// Validates all sessions are terminal, loads all reports, consolidates via Bedrock,
// stores result in pulseChecks table, returns 200 with full pulse check data.

import { DynamoDBClient, QueryCommand, PutItemCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'REPORTS_TABLE', 'PULSE_CHECKS_TABLE', 'SESSIONS_TABLE',
  'BEDROCK_MODEL_ID', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cw = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

const TERMINAL_STATUSES = new Set(['completed', 'expired', 'cancelled', 'discarded'])

function buildConsolidationPrompt(reports) {
  const reportSections = reports.map((r, idx) => {
    const isSelf = r.isSelfReview?.BOOL === true
    const label = isSelf ? `Self-Review (Reviewer ${idx + 1})` : `Reviewer ${idx + 1}`
    const verdict = r.verdict?.S || 'Unknown'
    const conviction = (r.conviction?.L || []).map(x => x.S).join('; ')
    const tension = (r.tension?.L || []).map(x => x.S).join('; ')
    const uncertainty = (r.uncertainty?.L || []).map(x => x.S).join('; ')
    const energy = r.energy?.S || 'unknown'
    const shape = r.conversationShape?.S || 'unknown'
    return `--- ${label} ---\nVerdict: ${verdict}\nEnergy: ${energy}\nConversation shape: ${shape}\nConviction: ${conviction || 'none'}\nTension: ${tension || 'none'}\nUncertainty: ${uncertainty || 'none'}`
  }).join('\n\n')

  return `You are synthesizing feedback from ${reports.length} reviewer(s) into a consolidated Pulse Check.

${reportSections}

Return a JSON object with:
- verdict: one-line synthesized verdict ("Worth developing further" | "Not there yet" | "Unclear / needs clarity")
- themes: array of { themeId, label, reviewerSignals } objects
- sharedConviction: array of strings (themes where multiple reviewers showed conviction)
- repeatedTension: array of strings (themes where tension appeared across reviewers)
- openQuestions: array of strings (unresolved questions across sessions)
- reviewerVerdicts: array of { sessionId, verdict, energy, isSelfReview } per reviewer

Preserve reviewer voice. Compress aggressively. Separate self-review signals from external signals.`
}

async function publishMetrics(latencyMs, tokensIn, tokensOut) {
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Bedrock',
      MetricData: [
        { MetricName: 'BedrockLatency', Value: latencyMs, Unit: 'Milliseconds' },
        { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
        { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
      ],
    }))
  } catch { /* non-fatal */ }
}

async function publishAlert(message, tenantId, itemId) {
  if (!process.env.ALERTS_TOPIC_ARN) return
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.ALERTS_TOPIC_ARN,
      Message: message,
      Subject: 'Pulse Check Alert',
      MessageAttributes: {
        tenantId: { DataType: 'String', StringValue: tenantId },
        itemId: { DataType: 'String', StringValue: itemId },
      },
    }))
  } catch { /* non-fatal */ }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) return errorResponse(401, 'Unauthorized', {}, origin)
  if (!itemId) return errorResponse(400, 'itemId is required', {}, origin)

  try {
    // 1. Query all sessions for this item
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :itemId',
      ExpressionAttributeValues: { ':itemId': { S: itemId } },
      ProjectionExpression: 'sessionId, #status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))

    const sessions = sessionsResult.Items || []
    if (sessions.length === 0) return errorResponse(404, 'No sessions found for this item', {}, origin)

    // 2. Validate all sessions are terminal
    const openSessions = sessions.filter(s => !TERMINAL_STATUSES.has(s.status?.S))
    if (openSessions.length > 0) {
      log('warn', 'RunPulseCheck: open sessions remain', { requestId, tenantId, itemId, openCount: openSessions.length })
      return errorResponse(409, 'Not all sessions are closed. Wait for remaining sessions to complete or expire.', {}, origin)
    }

    // 3. Load all reports for this item
    const reportsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.REPORTS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :itemId',
      ExpressionAttributeValues: { ':itemId': { S: itemId } },
    }))

    const reports = reportsResult.Items || []

    // 4. Consolidate via Bedrock
    const prompt = buildConsolidationPrompt(reports)
    const bedrockStart = Date.now()

    let bedrockResult
    try {
      bedrockResult = await bedrock.send(new InvokeModelCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      }))
    } catch (bedrockErr) {
      log('error', 'RunPulseCheck: Bedrock error', { requestId, tenantId, itemId, errorName: bedrockErr.name })
      await publishAlert(`Bedrock error in runPulseCheck: ${bedrockErr.message}`, tenantId, itemId)
      return errorResponse(503, 'Pulse check generation temporarily unavailable', {}, origin)
    }

    const bedrockLatency = Date.now() - bedrockStart
    const bedrockBody = JSON.parse(Buffer.from(bedrockResult.body).toString())
    const usage = bedrockBody.usage || {}
    await publishMetrics(bedrockLatency, usage.input_tokens || 0, usage.output_tokens || 0)

    // 5. Parse Bedrock response
    let parsed
    try {
      parsed = JSON.parse(bedrockBody.content[0].text)
    } catch {
      parsed = {}
    }

    const VALID_VERDICTS = ['Worth developing further', 'Not there yet', 'Unclear / needs clarity']
    const verdict = VALID_VERDICTS.includes(parsed.verdict) ? parsed.verdict : 'Unclear / needs clarity'
    const themes = Array.isArray(parsed.themes) ? parsed.themes : []
    const sharedConviction = Array.isArray(parsed.sharedConviction) ? parsed.sharedConviction : []
    const repeatedTension = Array.isArray(parsed.repeatedTension) ? parsed.repeatedTension : []
    const openQuestions = Array.isArray(parsed.openQuestions) ? parsed.openQuestions : []
    const reviewerVerdicts = Array.isArray(parsed.reviewerVerdicts) ? parsed.reviewerVerdicts : []
    const generatedAt = new Date().toISOString()

    // 6. Store pulse check
    await dynamo.send(new PutItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
        status: { S: 'complete' },
        verdict: { S: verdict },
        themes: { L: themes.map(t => ({ M: {
          themeId: { S: t.themeId || '' },
          label: { S: t.label || '' },
          reviewerSignals: { L: (t.reviewerSignals || []).map(s => ({ S: JSON.stringify(s) })) },
        }})) },
        sharedConviction: { L: sharedConviction.map(s => ({ S: s })) },
        repeatedTension: { L: repeatedTension.map(s => ({ S: s })) },
        openQuestions: { L: openQuestions.map(s => ({ S: s })) },
        reviewerVerdicts: { L: reviewerVerdicts.map(rv => ({ M: {
          sessionId: { S: rv.sessionId || '' },
          verdict: { S: rv.verdict || '' },
          energy: { S: rv.energy || '' },
          isSelfReview: { BOOL: rv.isSelfReview === true },
        }})) },
        sessionCount: { N: String(sessions.length) },
        generatedAt: { S: generatedAt },
      },
    }))

    log('info', 'RunPulseCheck: pulse check complete', { requestId, tenantId, itemId, sessionCount: sessions.length })

    return createResponse(200, {
      data: {
        verdict,
        themes,
        sharedConviction,
        repeatedTension,
        openQuestions,
        reviewerVerdicts,
        sessionCount: sessions.length,
        generatedAt,
        status: 'complete',
      },
    }, {}, origin)
  } catch (err) {
    log('error', 'RunPulseCheck: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to run pulse check', {}, origin)
  }
}
