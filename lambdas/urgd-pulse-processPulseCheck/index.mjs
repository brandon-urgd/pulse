// ur/gd pulse — Process Pulse Check Lambda
// Invoked async by runPulseCheck (InvocationType: Event).
// Loads reports, consolidates via Bedrock, writes 'complete' to DynamoDB.
// No API Gateway integration — never called directly by the frontend.

import { DynamoDBClient, QueryCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv([
  'REPORTS_TABLE', 'PULSE_CHECKS_TABLE', 'ITEMS_TABLE',
  'BEDROCK_MODEL_ID', 'ALERTS_TOPIC_ARN',
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
  } catch { /* X-Ray SDK not available */ }
}

async function putMetrics(metrics) {
  try {
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: 'Pulse/Reports', MetricData: metrics }))
  } catch (err) {
    log('warn', 'ProcessPulseCheck: failed to publish CloudWatch metrics', { errorName: err.name })
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
    log('warn', 'ProcessPulseCheck: failed to publish SNS alert', { errorName: err.name })
  }
}

// ─── Token Budget Scaling ──────────────────────────────────────────────────────
// Per Scaling Roadmap: 4096 for 1-7, 8192 for 8-15, 4096 per-batch for 16-20

export function getMaxTokens(sessionCount) {
  if (sessionCount <= 7) return 4096
  if (sessionCount <= 15) return 8192
  // 16-20: map-reduce handles token budget per batch
  return 4096 // per-batch max_tokens
}

export function getConsolidationMaxTokens() {
  return 8192
}

async function markFailed(tenantId, itemId, startedAt, incompleteCount, sessionCount) {
  await dynamo.send(new PutItemCommand({
    TableName: process.env.PULSE_CHECKS_TABLE,
    Item: {
      tenantId: { S: tenantId }, itemId: { S: itemId },
      status: { S: 'failed' }, generatedAt: { S: startedAt },
      sessionCount: { N: String(sessionCount) },
      incompleteCount: { N: String(incompleteCount) },
    },
  })).catch(() => {})
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function formatReport(r, idx) {
  return `
Reviewer ${idx + 1}${r.isSelfReview ? ' (Self-Review)' : ''}${r.incomplete ? ' (Session incomplete)' : ''}:
- Verdict: ${r.verdict}
- Energy: ${r.energy}
- Conversation Shape: ${r.conversationShape}
- Conviction: ${r.conviction.join('; ') || 'none'}
- Tension: ${r.tension.join('; ') || 'none'}
- Uncertainty: ${r.uncertainty.join('; ') || 'none'}
- Themes: ${r.themes.join(', ') || 'none'}`
}

function parseBedrockJson(rawText) {
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/)
    return jsonMatch ? JSON.parse(jsonMatch[0]) : {}
  } catch {
    return {}
  }
}

async function invokeBedrockModel(systemPrompt, userPrompt, maxTokens) {
  const response = await bedrock.send(new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }))
  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8'))
  return {
    text: responseBody.content?.[0]?.text || '{}',
    tokensIn: responseBody.usage?.input_tokens || 0,
    tokensOut: responseBody.usage?.output_tokens || 0,
  }
}

// ─── Single-Prompt Generation (1–15 sessions) ────────────────────────────────

const PULSE_CHECK_JSON_FORMAT = `Respond in valid JSON:
{
  "verdict": "A short verdict — 10 words max. This is a headline, not a paragraph. Capture the core takeaway in one punchy phrase. Examples: 'Clear direction on positioning, one open question on pricing', 'Strong concept, tone needs calibration', 'Solid foundation with one structural gap'. Never exceed 15 words.",
  "narrative": "2–3 sentences from the facilitator's perspective. Orient the reader: what does this feedback mean for the work? What's the key tension or open question? Plain, direct language. No bullet points. No hedging.",
  "themes": [
    {
      "themeId": "unique-slug",
      "label": "Theme label",
      "reviewerSignals": [
        { "sessionId": "session-id", "signalType": "conviction | tension | uncertainty", "quote": "reviewer's own words" }
      ]
    }
  ],
  "sharedConviction": ["points where 2+ reviewers showed conviction"],
  "repeatedTension": ["points where tension appeared across 2+ reviewers"],
  "openQuestions": ["unresolved questions that surfaced across sessions"],
  "reviewerVerdicts": [
    { "sessionId": "session-id", "verdict": "reviewer verdict", "energy": "reviewer energy level", "isSelfReview": false }
  ],
  "proposedRevisions": [
    {
      "revisionId": "unique-slug",
      "proposal": "A specific, concrete change the author could make. Derived from tension or uncertainty. Maximum 2 sentences.",
      "rationale": "Why this revision is warranted — grounded in reviewer signals. One sentence.",
      "revisionType": "structural | line-edit | conceptual | feature",
      "sourceThemeIds": ["themeId-1"]
    }
  ]
}`

const PULSE_CHECK_RULES = `CRITICAL RULES:
- Detect patterns across reviewers: shared conviction, repeated tension, common uncertainty
- Preserve individual reviewer voice in theme-level details — don't homogenize
- Compress aggressively — each item should be readable in 3–5 seconds
- Never rewrite reviewer quotes into corporate language

QUOTE SELECTION RULES:
- Only extract quotes that contain substantive feedback about the work being reviewed
- NEVER use meta-conversation quotes — things like "I think we've covered this", "let's move on", "good question", "that makes sense" are NOT feedback quotes
- NEVER use the reviewer's corrections or redirections of the AI agent as signal quotes
- Each quote must be self-explanatory — a reader who hasn't seen the conversation should understand the point being made. If a quote is too short to stand alone (e.g., "it's the simplicity"), expand it to include enough context: "it's the simplicity — that's what would actually get someone to switch"
- Prefer quotes of 10–30 words that capture a complete thought over fragments

VERDICT CALIBRATION:
- The verdict is a free-form single sentence — not a fixed enum. Write what actually fits the feedback.
- Reflect the quality and depth of feedback, not just the number of reviewers.
- One thorough reviewer who covered the requested sections and gave specific, actionable feedback deserves a verdict that reflects what was learned — not a dismissal for low sample size.
- Only suggest "gather more input" if the feedback was genuinely too thin to act on — incomplete sessions, surface-level responses, or requested sections not covered.
- Good verdicts are specific to the content: "Clear direction on X, open question on Y" is better than generic assessments.

For sharedConviction/repeatedTension: only include if 2+ reviewers showed the same signal. For solo reviews, leave these empty — the signal lives in themes and proposedRevisions instead.
For proposedRevisions: include as many as the signals warrant — no minimum, no maximum. Let signal density drive the count. A technical document may produce many small line-edits; a philosophical one may produce a few conceptual shifts. Return empty array only if no actionable changes are warranted.
For revisionType: use "structural" for changes to organization/flow, "line-edit" for specific wording/phrasing changes, "conceptual" for changes to ideas/framing/argument, "feature" for additions or removals of discrete capabilities or sections.`

async function singlePromptGeneration(reports, tenantId, itemId) {
  const sessionCount = reports.length
  const incompleteReports = reports.filter(r => r.incomplete)
  const selfReviewReports = reports.filter(r => r.isSelfReview)
  const hasSelfReview = selfReviewReports.length > 0

  const allReportsText = reports.map((r, i) => formatReport(r, i)).join('\n')
  const incompleteNote = incompleteReports.length > 0
    ? `\nNote: ${incompleteReports.length} of ${sessionCount} sessions were incomplete. Weight their feedback less heavily.`
    : ''

  const qualityInstruction = sessionCount >= 8
    ? `\nIMPORTANT: Identify the 5-7 strongest themes rather than listing every observation. Prioritize themes that appear across multiple reviewers. For each theme, select the 3 most representative quotes.\n`
    : ''

  const systemPrompt = `You are synthesizing feedback from ${sessionCount} reviewer session${sessionCount > 1 ? 's' : ''} into a consolidated Pulse Check.
${qualityInstruction}
${hasSelfReview ? `Note: ${selfReviewReports.length} of these sessions are self-review. Separate self-review signals from external reviewer signals where relevant.` : ''}

${PULSE_CHECK_RULES}

${PULSE_CHECK_JSON_FORMAT}`

  const userPrompt = `Individual Reports:
${allReportsText}
${incompleteNote}

Synthesize these reports into a consolidated Pulse Check following the JSON format specified in your instructions.`

  const bedrockStart = Date.now()
  try {
    const result = await invokeBedrockModel(systemPrompt, userPrompt, getMaxTokens(sessionCount))
    const bedrockLatency = Date.now() - bedrockStart

    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: bedrockLatency,
      bedrockTokensIn: result.tokensIn,
      bedrockTokensOut: result.tokensOut,
      generationPath: 'single-prompt',
    })

    return {
      consolidated: parseBedrockJson(result.text),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      bedrockLatency,
    }
  } catch (bedrockErr) {
    const bedrockLatency = Date.now() - bedrockStart
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
    await addXRayAnnotations({ bedrockError: bedrockErr.name, bedrockLatencyMs: bedrockLatency })
    await publishAlert('Bedrock invocation failed during pulse check (single-prompt)', { tenantId, itemId, errorName: bedrockErr.name })
    log('error', 'ProcessPulseCheck: Bedrock invocation failed (single-prompt)', { tenantId, itemId, errorName: bedrockErr.name })
    return null
  }
}

// ─── Map-Reduce Generation (16–20 sessions) ──────────────────────────────────
// Per Scaling Roadmap: split into batches of 8-10, summarize each batch,
// then consolidate all batch summaries into the final pulse check.

const MAX_PARALLEL_BATCHES = 3

function splitIntoBatches(reports, batchSize = 10) {
  const batches = []
  for (let i = 0; i < reports.length; i += batchSize) {
    batches.push(reports.slice(i, i + batchSize))
  }
  // If last batch is very small (< 4) and there are multiple batches, merge it into the previous
  if (batches.length > 1 && batches[batches.length - 1].length < 4) {
    const last = batches.pop()
    batches[batches.length - 1] = batches[batches.length - 1].concat(last)
  }
  return batches
}

async function processBatchWithRetry(batch, batchIndex, tenantId, itemId) {
  const batchReportsText = batch.map((r, i) => formatReport(r, i)).join('\n')

  const batchSystemPrompt = `You are analyzing feedback from a batch of ${batch.length} reviewer sessions.
Your job is to identify themes, extract representative quotes, and note sentiment patterns. Output structured JSON.`

  const batchUserPrompt = `Here are the session reports for this batch:
${batchReportsText}

Identify:
1. Top themes (max 7) with frequency count
2. Most representative quote per theme (verbatim)
3. Sentiment distribution per theme (positive/mixed/negative mapped to conviction/tension/uncertainty)
4. Any outlier perspectives worth preserving
5. Proposed revisions with reviewer support count

Respond in valid JSON:
{
  "themes": [
    {
      "themeId": "unique-slug",
      "label": "Theme label",
      "frequency": 3,
      "reviewerSignals": [
        { "sessionId": "session-id", "signalType": "conviction | tension | uncertainty", "quote": "reviewer's own words" }
      ]
    }
  ],
  "sharedConviction": ["points of conviction"],
  "repeatedTension": ["points of tension"],
  "openQuestions": ["open questions"],
  "reviewerVerdicts": [
    { "sessionId": "session-id", "verdict": "reviewer verdict", "energy": "energy level", "isSelfReview": false }
  ],
  "proposedRevisions": [
    {
      "revisionId": "unique-slug",
      "proposal": "specific change",
      "rationale": "why warranted",
      "revisionType": "structural | line-edit | conceptual | feature",
      "supportCount": 1
    }
  ]
}`

  // First attempt
  try {
    const result = await invokeBedrockModel(batchSystemPrompt, batchUserPrompt, getMaxTokens(batch.length))
    return { success: true, data: parseBedrockJson(result.text), tokensIn: result.tokensIn, tokensOut: result.tokensOut, sessionsInBatch: batch.length }
  } catch (err) {
    log('warn', `ProcessPulseCheck: batch ${batchIndex} failed, retrying`, { tenantId, itemId, errorName: err.name })
  }

  // Retry once
  try {
    const result = await invokeBedrockModel(batchSystemPrompt, batchUserPrompt, getMaxTokens(batch.length))
    return { success: true, data: parseBedrockJson(result.text), tokensIn: result.tokensIn, tokensOut: result.tokensOut, sessionsInBatch: batch.length }
  } catch (err) {
    log('error', `ProcessPulseCheck: batch ${batchIndex} failed after retry, skipping`, { tenantId, itemId, errorName: err.name })
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
    return { success: false, data: null, tokensIn: 0, tokensOut: 0, sessionsInBatch: batch.length }
  }
}

async function mapReduceGeneration(reports, tenantId, itemId) {
  const sessionCount = reports.length
  const batches = splitIntoBatches(reports)

  log('info', 'ProcessPulseCheck: starting map-reduce generation', {
    tenantId, itemId, sessionCount, batchCount: batches.length,
    batchSizes: batches.map(b => b.length),
  })

  // Phase 1: Batch summarization with concurrency limit (max 3 parallel)
  const batchResults = []
  let totalTokensIn = 0
  let totalTokensOut = 0
  const mapStart = Date.now()

  for (let i = 0; i < batches.length; i += MAX_PARALLEL_BATCHES) {
    const chunk = batches.slice(i, i + MAX_PARALLEL_BATCHES)
    const results = await Promise.allSettled(
      chunk.map((batch, j) => processBatchWithRetry(batch, i + j, tenantId, itemId))
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        batchResults.push(result.value)
        totalTokensIn += result.value.tokensIn
        totalTokensOut += result.value.tokensOut
      } else {
        batchResults.push({ success: false, data: null, tokensIn: 0, tokensOut: 0, sessionsInBatch: 0 })
      }
    }
  }

  const mapLatency = Date.now() - mapStart
  const successfulBatches = batchResults.filter(r => r.success)
  const sessionsAnalyzed = successfulBatches.reduce((sum, r) => sum + r.sessionsInBatch, 0)

  if (successfulBatches.length === 0) {
    log('error', 'ProcessPulseCheck: all batches failed in map-reduce', { tenantId, itemId })
    await publishAlert('All batches failed during map-reduce pulse check', { tenantId, itemId })
    return null
  }

  const skippedBatches = batchResults.filter(r => !r.success).length
  if (skippedBatches > 0) {
    log('warn', `ProcessPulseCheck: ${skippedBatches} batch(es) skipped in map-reduce`, { tenantId, itemId, skippedBatches })
  }

  // Phase 2: Consolidation — feed all batch summaries into a single prompt
  const batchSummariesText = successfulBatches.map((r, i) =>
    `Batch ${i + 1} Summary:\n${JSON.stringify(r.data, null, 2)}`
  ).join('\n\n')

  const consolidationSystemPrompt = `You are producing the final Pulse Check synthesis from batch summaries.
Each batch represents 8-10 reviewer sessions. Your job is to merge themes across batches, rank by frequency, resolve duplicates, and produce the final structured output.

${PULSE_CHECK_RULES}

${PULSE_CHECK_JSON_FORMAT}`

  const skippedNote = skippedBatches > 0
    ? `\nNote: ${skippedBatches} batch(es) could not be processed. This analysis covers ${sessionsAnalyzed} of ${sessionCount} total sessions.`
    : ''

  const consolidationUserPrompt = `Batch summaries:
${batchSummariesText}

Total reviewers: ${sessionCount}
Sessions analyzed: ${sessionsAnalyzed}${skippedNote}

Produce the final Pulse Check by merging themes across batches, ranking by frequency, resolving duplicates, and generating the complete structured output.`

  const consolidationStart = Date.now()
  try {
    const result = await invokeBedrockModel(consolidationSystemPrompt, consolidationUserPrompt, getConsolidationMaxTokens())
    const consolidationLatency = Date.now() - consolidationStart
    totalTokensIn += result.tokensIn
    totalTokensOut += result.tokensOut

    await addXRayAnnotations({
      bedrockModelId: process.env.BEDROCK_MODEL_ID,
      bedrockLatencyMs: mapLatency + consolidationLatency,
      bedrockTokensIn: totalTokensIn,
      bedrockTokensOut: totalTokensOut,
      generationPath: 'map-reduce',
      batchCount: batches.length,
      successfulBatches: successfulBatches.length,
    })

    return {
      consolidated: parseBedrockJson(result.text),
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      bedrockLatency: mapLatency + consolidationLatency,
      sessionsAnalyzed,
    }
  } catch (bedrockErr) {
    const consolidationLatency = Date.now() - consolidationStart
    await putMetrics([{ MetricName: 'BedrockErrors', Value: 1, Unit: 'Count' }])
    await addXRayAnnotations({ bedrockError: bedrockErr.name, bedrockLatencyMs: mapLatency + consolidationLatency })
    await publishAlert('Bedrock consolidation failed during map-reduce pulse check', { tenantId, itemId, errorName: bedrockErr.name })
    log('error', 'ProcessPulseCheck: consolidation failed in map-reduce', { tenantId, itemId, errorName: bedrockErr.name })
    return null
  }
}

export const handler = async (event) => {
  const { tenantId, itemId, startedAt } = event

  if (!tenantId || !itemId) {
    log('error', 'ProcessPulseCheck: missing tenantId or itemId in event', { event })
    return
  }

  try {
    // 1. Query all reports for this item
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
      log('error', 'ProcessPulseCheck: no reports found', { tenantId, itemId })
      await markFailed(tenantId, itemId, startedAt, 0, 0)
      return
    }

    const incompleteReports = reports.filter(r => r.incomplete)
    const sessionCount = reports.length

    // 2. Branch: single-prompt (≤15) or map-reduce (16+)
    let consolidated
    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalBedrockLatency = 0
    let sessionsAnalyzed = sessionCount

    if (sessionCount <= 15) {
      const result = await singlePromptGeneration(reports, tenantId, itemId)
      if (!result) {
        await markFailed(tenantId, itemId, startedAt, incompleteReports.length, sessionCount)
        return
      }
      consolidated = result.consolidated
      totalTokensIn = result.tokensIn
      totalTokensOut = result.tokensOut
      totalBedrockLatency = result.bedrockLatency
    } else {
      const result = await mapReduceGeneration(reports, tenantId, itemId)
      if (!result) {
        await markFailed(tenantId, itemId, startedAt, incompleteReports.length, sessionCount)
        return
      }
      consolidated = result.consolidated
      totalTokensIn = result.tokensIn
      totalTokensOut = result.tokensOut
      totalBedrockLatency = result.bedrockLatency
      sessionsAnalyzed = result.sessionsAnalyzed
    }

    // 3. Validate and normalize consolidated output
    const verdict = typeof consolidated.verdict === 'string' && consolidated.verdict.trim().length > 0
      ? consolidated.verdict.trim()
      : 'Review the feedback below'
    const narrative = typeof consolidated.narrative === 'string' ? consolidated.narrative.trim() : ''
    const themes = Array.isArray(consolidated.themes) ? consolidated.themes : []
    const sharedConviction = Array.isArray(consolidated.sharedConviction) ? consolidated.sharedConviction : []
    const repeatedTension = Array.isArray(consolidated.repeatedTension) ? consolidated.repeatedTension : []
    const openQuestions = Array.isArray(consolidated.openQuestions) ? consolidated.openQuestions : []
    const reviewerVerdicts = Array.isArray(consolidated.reviewerVerdicts) ? consolidated.reviewerVerdicts : []
    const proposedRevisions = Array.isArray(consolidated.proposedRevisions) ? consolidated.proposedRevisions : []

    // 4. Stamp hasPulseCheck on item
    const generatedAt = new Date().toISOString()
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.ITEMS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
      UpdateExpression: 'SET hasPulseCheck = :t, pulseCheckGeneratedAt = :gen, updatedAt = :now',
      ExpressionAttributeValues: { ':t': { BOOL: true }, ':gen': { S: generatedAt }, ':now': { S: generatedAt } },
    })).catch(err => {
      log('warn', 'ProcessPulseCheck: failed to stamp hasPulseCheck on item', { tenantId, itemId, errorName: err.name })
    })

    // 5. Serialize and store complete pulse check
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
        revisionType: { S: r.revisionType || 'structural' },
        sourceThemeIds: { L: (r.sourceThemeIds || []).map(id => ({ S: id })) },
      },
    }))

    const pulseCheckItem = {
      tenantId: { S: tenantId },
      itemId: { S: itemId },
      verdict: { S: verdict },
      narrative: { S: narrative },
      themes: { L: serializeThemes },
      sharedConviction: { L: sharedConviction.map(s => ({ S: s })) },
      repeatedTension: { L: repeatedTension.map(s => ({ S: s })) },
      openQuestions: { L: openQuestions.map(s => ({ S: s })) },
      reviewerVerdicts: { L: serializeReviewerVerdicts },
      proposedRevisions: { L: serializeProposedRevisions },
      sessionCount: { N: String(sessionCount) },
      sessionsAnalyzed: { N: String(sessionsAnalyzed) },
      incompleteCount: { N: String(incompleteReports.length) },
      generatedAt: { S: generatedAt },
      status: { S: 'complete' },
    }

    await dynamo.send(new PutItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Item: pulseCheckItem,
    }))

    await putMetrics([
      { MetricName: 'BedrockLatency', Value: totalBedrockLatency, Unit: 'Milliseconds' },
      { MetricName: 'BedrockTokensIn', Value: totalTokensIn, Unit: 'Count' },
      { MetricName: 'BedrockTokensOut', Value: totalTokensOut, Unit: 'Count' },
    ])

    log('info', 'ProcessPulseCheck: pulse check stored', {
      tenantId, itemId,
      sessionCount, sessionsAnalyzed,
      incompleteCount: incompleteReports.length,
      generationPath: sessionCount <= 15 ? 'single-prompt' : 'map-reduce',
      verdict, bedrockLatency: totalBedrockLatency, tokensIn: totalTokensIn, tokensOut: totalTokensOut,
    })
  } catch (err) {
    log('error', 'ProcessPulseCheck: unexpected error', { tenantId, itemId, errorName: err.name, message: err.message })
    await markFailed(tenantId, itemId, startedAt, 0, 0)
  }
}
