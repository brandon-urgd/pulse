// ur/gd pulse — Generate Session Summary Lambda
// Invoked async by chat Lambda after session completion
// Generates AI summary of the session transcript

import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { log, requireEnv } from './shared/utils.mjs'
import { resolveFeature } from './shared/features.mjs'

requireEnv(['SESSIONS_TABLE', 'TRANSCRIPTS_TABLE', 'BEDROCK_MODEL_ID'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

function unmarshalFeatures(m) {
  if (!m) return {}
  const result = {}
  for (const [key, val] of Object.entries(m)) {
    if ('N' in val) result[key] = Number(val.N)
    else if ('BOOL' in val) result[key] = val.BOOL
    else if ('S' in val) result[key] = val.S
    else if ('M' in val) result[key] = unmarshalFeatures(val.M)
  }
  return result
}

export const handler = async (event) => {
  const { sessionId, tenantId } = event

  if (!sessionId || !tenantId) {
    log('error', 'GenerateSessionSummary: missing sessionId or tenantId', { sessionId, tenantId })
    return
  }

  try {
    // Check aiReports feature flag
    if (process.env.TENANTS_TABLE) {
      try {
        const [tenantResult, systemResult] = await Promise.all([
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: tenantId } },
          })),
          dynamo.send(new GetItemCommand({
            TableName: process.env.TENANTS_TABLE,
            Key: { tenantId: { S: 'SYSTEM' } },
          })),
        ])
        const tenantRecord = tenantResult.Item ? {
          tier: tenantResult.Item.tier?.S ?? 'free',
          features: unmarshalFeatures(tenantResult.Item.features?.M),
          serviceFlags: unmarshalFeatures(tenantResult.Item.serviceFlags?.M),
        } : { tier: 'free', features: {}, serviceFlags: {} }
        const systemRecord = systemResult.Item ? {
          serviceFlags: unmarshalFeatures(systemResult.Item.serviceFlags?.M),
        } : null

        const aiReportsResult = resolveFeature(tenantRecord, 'aiReports', systemRecord)
        if (!aiReportsResult.allowed) {
          log('info', 'GenerateSessionSummary: aiReports feature blocked', { sessionId, tenantId, reason: aiReportsResult.reason })
          return
        }
      } catch (err) {
        log('warn', 'GenerateSessionSummary: failed to check aiReports flag, proceeding', { sessionId, tenantId, errorName: err.name })
      }
    }

    // 1. Query full transcript
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
      log('warn', 'GenerateSessionSummary: no transcript found', { sessionId, tenantId })
      return
    }

    const transcriptText = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n')

    // 2. Send to Bedrock for summary generation
    const prompt = `You are analyzing a feedback session transcript. Based on the conversation below, provide a structured summary.

Transcript:
${transcriptText}

Please provide:
1. A list of sections covered (as an array of section names/topics)
2. 3-5 key themes or insights from the feedback (as bullet points)
3. A brief, professional closing message (2-3 sentences) that could be shown to the reviewer

Respond in valid JSON format:
{
  "sections": ["section1", "section2"],
  "themes": ["theme1", "theme2", "theme3"],
  "closingMessage": "Thank you for your thoughtful feedback..."
}`

    const bedrockResponse = await bedrock.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    }))

    const responseBody = JSON.parse(Buffer.from(bedrockResponse.body).toString('utf-8'))
    const rawText = responseBody.content?.[0]?.text || '{}'

    let summary
    try {
      // Extract JSON from response (may have surrounding text)
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      summary = jsonMatch ? JSON.parse(jsonMatch[0]) : { sections: [], themes: [], closingMessage: '' }
    } catch {
      summary = { sections: [], themes: [], closingMessage: rawText.slice(0, 500) }
    }

    // Ensure required fields
    if (!Array.isArray(summary.sections)) summary.sections = []
    if (!Array.isArray(summary.themes)) summary.themes = []
    if (typeof summary.closingMessage !== 'string') summary.closingMessage = ''

    // 3. Store summary in session record
    await dynamo.send(new UpdateItemCommand({
      TableName: process.env.SESSIONS_TABLE,
      Key: { tenantId: { S: tenantId }, sessionId: { S: sessionId } },
      UpdateExpression: 'SET summary = :summary, summaryGeneratedAt = :generatedAt',
      ExpressionAttributeValues: {
        ':summary': { S: JSON.stringify(summary) },
        ':generatedAt': { S: new Date().toISOString() },
      },
    }))

    log('info', 'GenerateSessionSummary: summary stored', { sessionId, tenantId })
  } catch (err) {
    log('error', 'GenerateSessionSummary: unexpected error', { sessionId, tenantId, errorName: err.name })
  }
}
