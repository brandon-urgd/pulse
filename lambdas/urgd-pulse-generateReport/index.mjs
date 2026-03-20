// ur/gd pulse — Generate Report Lambda
// Invoked async by chat Lambda after session completion (alongside generateSessionSummary)
// Sends full transcript to Bedrock for structured signal extraction
// Stores report in reports table — idempotent (PutItem replaces existing)

import { DynamoDBClient, QueryCommand, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['TRANSCRIPTS_TABLE', 'REPORTS_TABLE', 'SESSIONS_TABLE', 'BEDROCK_MODEL_ID'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
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
      Namespace: 'Pulse/Reports',
      MetricData: metrics,
    }))
  } catch (err) {
    log('warn', 'GenerateReport: failed to publish CloudWatch metrics', { errorName: err.name })
  }
}

export const handler = async (event) => {
  const { sessionId, tenantId } = event

  if (!sessionId || !tenantId) {
    log('error', 'GenerateReport: missing sessionId or tenantId', { sessionId, tenantId })
    return
  }

  try {
    // 1. Get session record to retrieve itemId and isSelfReview flag
    const sessionResult = await dynamo.send(new GetItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      ProjectionExpression: 'itemId, isSelfReview',
    }))

    if (!sessionResult.Item) {
      log('error', 'GenerateReport: session not found', { sessionId, tenantId })
      return
    }

    const itemId = sessionResult.Item.itemId?.S
    const isSelfReview = sessionResult.Item.isSelfReview?.BOOL === true

    if (!itemId) {
      log('error', 'GenerateReport: session has no itemId', { sessionId, tenantId })
      return
    }

    // 2. Query full transcript
    const transcriptResult = await dynamo.send(new QueryCommand({
      TableName: process.env.TRANSCRIPTS_TABLE,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: { ':sid': { S: sessionId } },
      ScanIndexForward: true,
    }))

    const messages = (transcriptResult.Items || []).map(item => ({
      role: item.role?.S === 'reviewer' ? 'Reviewer' : 'Agent',
      content: item.content?.S || '',
    }))

    if (messages.length === 0) {
      log('warn', 'GenerateReport: no transcript found', { sessionId, tenantId })
      return
    }

    const transcriptText = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n')

    // 3. Detect conversation shape from transcript to adapt extraction
    const reviewerMessages = messages.filter(m => m.role === 'Reviewer')
    const avgLength = reviewerMessages.length > 0
      ? reviewerMessages.reduce((sum, m) => sum + m.content.length, 0) / reviewerMessages.length
      : 0

    // 4. Build Bedrock prompt — preserve reviewer voice, compress aggressively
    const prompt = `You are analyzing a feedback session transcript. Your job is to extract structured signal from the reviewer's responses.

CRITICAL RULES:
- Preserve the reviewer's exact voice and phrasing — do NOT sanitize, polish, or rewrite into corporate language
- Compress aggressively: each item should be readable in 3–5 seconds (20–30 second total readability)
- Adapt extraction to the conversation shape:
  * Deep/philosophical conversation → extract insights and nuanced positions
  * Shallow/tactical conversation → extract clarity gaps and unanswered questions
  * Mixed conversation → extract contrasts between what landed and what didn't
- Never rewrite quotes into corporate language — if the reviewer said "this feels half-baked", keep it
- Separate self-review signals from external signals if applicable

Transcript:
${transcriptText}

Extract the following and respond in valid JSON:
{
  "verdict": "one-line forced verdict — must be exactly one of: 'Worth developing further' | 'Not there yet' | 'Unclear / needs clarity'",
  "conviction": ["array of things the reviewer clearly believes, in their own words — direct quotes or close paraphrases"],
  "tension": ["array of things that didn't land or the reviewer pushed back on, in their own words"],
  "uncertainty": ["array of things the reviewer couldn't form an opinion on — gaps, confusion, or 'I don't know'"],
  "energy": "overall engagement level — must be exactly one of: 'engaged' | 'neutral' | 'resistant'",
  "conversationShape": "detected character — must be exactly one of: 'tactical' | 'emotional' | 'philosophical' | 'mixed'",
  "themes": ["array of 3–7 key topics or themes extracted from the conversation — these become row keys in the signal matrix"]
}

For verdict: choose based on the overall signal. If the reviewer showed more conviction than tension, lean toward 'Worth developing further'. If tension dominated, lean toward 'Not there yet'. If the conversation was mostly uncertainty or the reviewer couldn't engage, use 'Unclear / needs clarity'.

For energy: 'engaged' = reviewer gave substantive, specific responses; 'neutral' = polite but surface-level; 'resistant' = skeptical, dismissive, or short answers throughout.

For conversationShape: 'tactical' = focused on implementation, process, specifics; 'emotional' = values, feelings, personal reactions; 'philosophical' = big-picture, principles, meaning; 'mixed' = combination.

For themes: extract the actual topics discussed (e.g., "pricing model", "team structure", "go-to-market timing") — not generic labels.`

    // 5. Invoke Bedrock
    const bedrockStart = Date.now()
    let bedrockResponse
    try {
      bedrockResponse = await bedrock.send(new InvokeModelCommand({
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
      const bedrockLatency = Date.now() - bedrockStart
      await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
      await addXRayAnnotations({ bedrockError: bedrockErr.name, bedrockLatencyMs: bedrockLatency })
      log('error', 'GenerateReport: Bedrock invocation failed', { sessionId, tenantId, errorName: bedrockErr.name })
      throw bedrockErr
    }

    const bedrockLatency = Date.now() - bedrockStart
    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const rawText = responseBody.content?.[0]?.text || '{}'
    const tokensIn = responseBody.usage?.input_tokens || 0
    const tokensOut = responseBody.usage?.output_tokens || 0

    // Annotate X-Ray trace
    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: tokensIn,
      bedrockTokensOut: tokensOut,
    })

    // 6. Parse Bedrock response
    let extracted
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      extracted = {}
    }

    // Validate and normalize extracted fields
    const VALID_VERDICTS = ['Worth developing further', 'Not there yet', 'Unclear / needs clarity']
    const VALID_ENERGIES = ['engaged', 'neutral', 'resistant']
    const VALID_SHAPES = ['tactical', 'emotional', 'philosophical', 'mixed']

    const verdict = VALID_VERDICTS.includes(extracted.verdict) ? extracted.verdict : 'Unclear / needs clarity'
    const energy = VALID_ENERGIES.includes(extracted.energy) ? extracted.energy : 'neutral'
    const conversationShape = VALID_SHAPES.includes(extracted.conversationShape) ? extracted.conversationShape : 'mixed'
    const conviction = Array.isArray(extracted.conviction) ? extracted.conviction : []
    const tension = Array.isArray(extracted.tension) ? extracted.tension : []
    const uncertainty = Array.isArray(extracted.uncertainty) ? extracted.uncertainty : []
    const themes = Array.isArray(extracted.themes) ? extracted.themes : []

    // 7. Store report — PutItem is idempotent (replaces existing report for same session)
    const generatedAt = new Date().toISOString()
    await dynamo.send(new PutItemCommand({
      TableName: process.env.REPORTS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        sessionId: { S: sessionId },
        itemId: { S: itemId },
        verdict: { S: verdict },
        conviction: { L: conviction.map(c => ({ S: c })) },
        tension: { L: tension.map(t => ({ S: t })) },
        uncertainty: { L: uncertainty.map(u => ({ S: u })) },
        energy: { S: energy },
        conversationShape: { S: conversationShape },
        themes: { L: themes.map(t => ({ S: t })) },
        isSelfReview: { BOOL: isSelfReview },
        generatedAt: { S: generatedAt },
      },
    }))

    // 8. Publish CloudWatch metrics
    await putMetrics([
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
    ])

    log('info', 'GenerateReport: report stored', {
      sessionId, tenantId, itemId,
      verdict, energy, conversationShape,
      bedrockLatency, tokensIn, tokensOut,
      modelId: process.env.BEDROCK_MODEL_ID,
    })
  } catch (err) {
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
    log('error', 'GenerateReport: unexpected error', { sessionId, tenantId, errorName: err.name })
  }
}
