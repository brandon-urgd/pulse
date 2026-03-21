// ur/gd pulse — Run Pulse Check Lambda
// POST /api/manage/items/{itemId}/pulse-check
// Validates all sessions are completed/expired, loads all reports, consolidates via Bedrock

import { DynamoDBClient, QueryCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'REPORTS_TABLE', 'PULSE_CHECKS_TABLE', 'SESSIONS_TABLE', 'ITEMS_TABLE',
  'BEDROCK_MODEL_ID', 'ALERTS_TOPIC_ARN', 'CORS_ALLOWED_ORIGINS',
])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

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
    // X-Ray SDK not available — safe to ignore
  }
}

async function putMetrics(metrics) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Reports',
      MetricData: metrics,
    }))
  } catch (err) {
    log('warn', 'RunPulseCheck: failed to publish CloudWatch metrics', { errorName: err.name })
  }
}

async function publishAlert(message, context) {
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.ALERTS_TOPIC_ARN,
      Subject: 'Pulse Check Bedrock Error',
      Message: JSON.stringify({ message, ...context }),
    }))
  } catch (err) {
    log('warn', 'RunPulseCheck: failed to publish SNS alert', { errorName: err.name })
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  try {
    // 1. Query all sessions for this item via item-index GSI
    const sessionsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.SESSIONS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :itemId',
      ExpressionAttributeValues: { ':itemId': { S: itemId } },
      ProjectionExpression: 'sessionId, #status',
      ExpressionAttributeNames: { '#status': 'status' },
    }))

    const sessions = sessionsResult.Items || []

    if (sessions.length === 0) {
      return errorResponse(404, 'No sessions found for this item', {}, origin)
    }

    // 2. Validate all sessions are completed or expired
    const TERMINAL_STATUSES = new Set(['completed', 'expired', 'cancelled', 'discarded'])
    const openSessions = sessions.filter(s => {
      const status = s.status?.S
      return !TERMINAL_STATUSES.has(status)
    })

    if (openSessions.length > 0) {
      log('info', 'RunPulseCheck: sessions still open', { requestId, tenantId, itemId, openCount: openSessions.length })
      return errorResponse(409, 'Not all sessions are closed. Wait for remaining sessions to complete or expire.', {}, origin)
    }

    // 3. Query all reports for this item via item-index GSI
    const reportsResult = await dynamo.send(new QueryCommand({
      TableName: process.env.REPORTS_TABLE,
      IndexName: 'item-index',
      KeyConditionExpression: 'itemId = :itemId',
      ExpressionAttributeValues: { ':itemId': { S: itemId } },
    }))

    const reports = (reportsResult.Items || []).map(item => ({
      sessionId: item.sessionId?.S,
      verdict: item.verdict?.S,
      conviction: (item.conviction?.L || []).map(c => c.S),
      tension: (item.tension?.L || []).map(t => t.S),
      uncertainty: (item.uncertainty?.L || []).map(u => u.S),
      energy: item.energy?.S,
      conversationShape: item.conversationShape?.S,
      themes: (item.themes?.L || []).map(t => t.S),
      isSelfReview: item.isSelfReview?.BOOL === true,
      incomplete: item.incomplete?.BOOL === true,
    }))

    if (reports.length === 0) {
      return errorResponse(404, 'No reports found — reports may still be generating', {}, origin)
    }

    // 4. Build consolidation prompt
    const selfReviewReports = reports.filter(r => r.isSelfReview)
    const externalReports = reports.filter(r => !r.isSelfReview)
    const hasSelfReview = selfReviewReports.length > 0
    const incompleteReports = reports.filter(r => r.incomplete)
    const completeReports = reports.filter(r => !r.incomplete)

    const formatReport = (r, idx) => `
Reviewer ${idx + 1}${r.isSelfReview ? ' (Self-Review)' : ''}${r.incomplete ? ' (Session incomplete — reviewer did not finish)' : ''}:
- Verdict: ${r.verdict}
- Energy: ${r.energy}
- Conversation Shape: ${r.conversationShape}
- Conviction: ${r.conviction.join('; ') || 'none'}
- Tension: ${r.tension.join('; ') || 'none'}
- Uncertainty: ${r.uncertainty.join('; ') || 'none'}
- Themes: ${r.themes.join(', ') || 'none'}`

    const allReportsText = reports.map((r, i) => formatReport(r, i)).join('\n')

    const incompleteNote = incompleteReports.length > 0
      ? `\nNote: ${incompleteReports.length} of ${reports.length} session${reports.length > 1 ? 's' : ''} were incomplete (reviewer did not finish). Their partial feedback is included but should be weighted less heavily than complete sessions.`
      : ''

    const prompt = `You are synthesizing feedback from ${reports.length} reviewer session${reports.length > 1 ? 's' : ''} into a consolidated Pulse Check.

${hasSelfReview ? `Note: ${selfReviewReports.length} of these sessions are self-review (the item creator reviewing their own work). Separate self-review signals from external reviewer signals where relevant.` : ''}${incompleteNote}

Individual Reports:
${allReportsText}

CRITICAL RULES:
- Detect patterns across reviewers: shared conviction, repeated tension, common uncertainty
- Preserve individual reviewer voice in theme-level details — don't homogenize
- Adapt to the mix of conversation shapes across sessions
- Compress aggressively — each item should be readable in 3–5 seconds
- Never rewrite reviewer quotes into corporate language

Respond in valid JSON:
{
  "verdict": "synthesized one-line verdict across all reviewers — must be exactly one of: 'Worth developing further' | 'Not there yet' | 'Unclear / needs clarity'",
  "themes": [
    {
      "themeId": "unique-slug-for-theme",
      "label": "Theme label",
      "reviewerSignals": [
        {
          "sessionId": "session-id",
          "signalType": "conviction | tension | uncertainty",
          "quote": "reviewer's own words"
        }
      ]
    }
  ],
  "sharedConviction": ["themes or points where multiple reviewers showed conviction"],
  "repeatedTension": ["themes or points where tension appeared across multiple reviewers"],
  "openQuestions": ["unresolved questions that surfaced across sessions"],
  "reviewerVerdicts": [
    {
      "sessionId": "session-id",
      "verdict": "reviewer verdict",
      "energy": "reviewer energy level",
      "isSelfReview": false
    }
  ],
  "proposedRevisions": [
    {
      "revisionId": "unique-slug",
      "proposal": "A specific, concrete change the author could make to the document — written as an actionable suggestion, not an observation. Derived from repeated tension or unresolved uncertainty. Example: 'Address the medium assumption gap — add a section that either defends radio as the right channel or explicitly acknowledges it as an open question.' Maximum 2 sentences.",
      "rationale": "Why this revision is warranted — grounded in reviewer signals, not editorial opinion. One sentence.",
      "sourceThemeIds": ["themeId-1", "themeId-2"]
    }
  ]
}

For verdict: synthesize across all external reviewers primarily. If self-review exists, note it but weight external signals more heavily.
For themes: union of themes across all reports. Each theme should have per-reviewer signal breakdown.
For sharedConviction: only include if 2+ reviewers showed conviction on the same theme.
For repeatedTension: only include if 2+ reviewers showed tension on the same theme.
For proposedRevisions: derive 2–5 concrete, actionable changes the author could make. Only include revisions grounded in tension or uncertainty signals — do not propose revisions for conviction themes. Each revision must be specific enough that an author knows exactly what to do. Do not include vague suggestions like "expand the section" — say what to expand and why. If there is no meaningful tension or uncertainty, return an empty array.`

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
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      }))
    } catch (bedrockErr) {
      const bedrockLatency = Date.now() - bedrockStart
      await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
      await addXRayAnnotations({ bedrockError: bedrockErr.name, bedrockLatencyMs: bedrockLatency })
      await publishAlert('Bedrock invocation failed during pulse check consolidation', {
        tenantId, itemId, errorName: bedrockErr.name,
      })
      log('error', 'RunPulseCheck: Bedrock invocation failed', { requestId, tenantId, itemId, errorName: bedrockErr.name })
      return errorResponse(503, 'AI service temporarily unavailable', {}, origin)
    }

    const bedrockLatency = Date.now() - bedrockStart
    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const rawText = responseBody.content?.[0]?.text || '{}'
    const tokensIn = responseBody.usage?.input_tokens || 0
    const tokensOut = responseBody.usage?.output_tokens || 0

    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: tokensIn,
      bedrockTokensOut: tokensOut,
    })

    // 6. Parse Bedrock response
    let consolidated
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      consolidated = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      consolidated = {}
    }

    const VALID_VERDICTS = ['Worth developing further', 'Not there yet', 'Unclear / needs clarity']
    const verdict = VALID_VERDICTS.includes(consolidated.verdict) ? consolidated.verdict : 'Unclear / needs clarity'
    const themes = Array.isArray(consolidated.themes) ? consolidated.themes : []
    const sharedConviction = Array.isArray(consolidated.sharedConviction) ? consolidated.sharedConviction : []
    const repeatedTension = Array.isArray(consolidated.repeatedTension) ? consolidated.repeatedTension : []
    const openQuestions = Array.isArray(consolidated.openQuestions) ? consolidated.openQuestions : []
    const reviewerVerdicts = Array.isArray(consolidated.reviewerVerdicts) ? consolidated.reviewerVerdicts : []
    const proposedRevisions = Array.isArray(consolidated.proposedRevisions) ? consolidated.proposedRevisions : []

    // 7. Store pulse check — PutItem replaces existing
    const generatedAt = new Date().toISOString()

    // Also stamp hasPulseCheck on the item record so getItems can surface it cheaply
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression: 'SET hasPulseCheck = :t, updatedAt = :now',
      ExpressionAttributeValues: {
        ':t': { BOOL: true },
        ':now': { S: new Date().toISOString() },
      },
    })).catch(err => {
      // Non-fatal — pulse check still stored even if item stamp fails
      log('warn', 'RunPulseCheck: failed to stamp hasPulseCheck on item', { requestId, tenantId, itemId, errorName: err.name })
    })

    const serializeThemes = themes.map(t => ({
      M: {
        themeId: { S: t.themeId || '' },
        label: { S: t.label || '' },
        reviewerSignals: {
          L: (t.reviewerSignals || []).map(s => ({
            M: {
              sessionId: { S: s.sessionId || '' },
              signalType: { S: s.signalType || '' },
              quote: { S: s.quote || '' },
            },
          })),
        },
      },
    }))

    const serializeReviewerVerdicts = reviewerVerdicts.map(rv => ({
      M: {
        sessionId: { S: rv.sessionId || '' },
        verdict: { S: rv.verdict || '' },
        energy: { S: rv.energy || '' },
        isSelfReview: { BOOL: rv.isSelfReview === true },
      },
    }))

    const serializeProposedRevisions = proposedRevisions.map(r => ({
      M: {
        revisionId: { S: r.revisionId || '' },
        proposal: { S: r.proposal || '' },
        rationale: { S: r.rationale || '' },
        sourceThemeIds: { L: (r.sourceThemeIds || []).map(id => ({ S: id })) },
      },
    }))

    await dynamo.send(new PutItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Item: {
        tenantId: { S: tenantId },
        itemId: { S: itemId },
        verdict: { S: verdict },
        themes: { L: serializeThemes },
        sharedConviction: { L: sharedConviction.map(s => ({ S: s })) },
        repeatedTension: { L: repeatedTension.map(s => ({ S: s })) },
        openQuestions: { L: openQuestions.map(s => ({ S: s })) },
        reviewerVerdicts: { L: serializeReviewerVerdicts },
        proposedRevisions: { L: serializeProposedRevisions },
        sessionCount: { N: String(reports.length) },
        incompleteCount: { N: String(incompleteReports.length) },
        generatedAt: { S: generatedAt },
        status: { S: 'complete' },
      },
    }))

    // 8. Publish CloudWatch metrics
    await putMetrics([
      { MetricName: 'BedrockLatency', Value: bedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: tokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: tokensOut, Unit: 'Count' },
    ])

    const pulseCheck = {
      itemId,
      verdict,
      themes,
      sharedConviction,
      repeatedTension,
      openQuestions,
      reviewerVerdicts,
      proposedRevisions,
      sessionCount: reports.length,
      incompleteCount: incompleteReports.length,
      generatedAt,
      status: 'complete',
    }

    log('info', 'RunPulseCheck: pulse check stored', {
      requestId, tenantId, itemId,
      sessionCount: reports.length,
      incompleteCount: incompleteReports.length,
      verdict,
      bedrockLatency, tokensIn, tokensOut,
    })

    return createResponse(200, { data: pulseCheck }, {}, origin)
  } catch (err) {
    log('error', 'RunPulseCheck: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to run pulse check', {}, origin)
  }
}
