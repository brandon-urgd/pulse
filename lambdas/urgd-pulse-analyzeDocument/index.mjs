// ur/gd pulse — Analyze Document Lambda
// Async invocation (no API route): receives { itemId, tenantId }
// Reads extracted text from S3, classifies document sections via Bedrock,
// writes sectionMap to item record in DynamoDB.

import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['ITEMS_TABLE', 'DATA_BUCKET', 'BEDROCK_MODEL_ID'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

async function getS3Text(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const chunks = []
  for await (const chunk of res.Body) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

/**
 * Parse Bedrock's JSON response into a validated sectionMap.
 * Throws if the response is malformed.
 */
function parseSectionMap(responseText) {
  // Extract JSON from response — Bedrock may wrap it in markdown code fences
  let jsonStr = responseText.trim()
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonStr = fenceMatch[1].trim()

  const parsed = JSON.parse(jsonStr)

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error('Bedrock response missing or empty sections array')
  }

  const sections = parsed.sections.map((s, i) => {
    const id = s.id || `s${i + 1}`
    const title = String(s.title || '').trim()
    const classification = s.classification === 'substantive' ? 'substantive' : 'lightweight'
    if (!title) throw new Error(`Section ${id} has empty title`)
    if (!/^s\d+$/.test(id)) throw new Error(`Section ${id} has invalid id format`)
    const entry = { id, title, classification }
    // Validate wordCount: must be a non-negative integer; otherwise omit
    const wc = s.wordCount
    if (Number.isInteger(wc) && wc >= 0) {
      entry.wordCount = wc
    }
    return entry
  })

  const totalSubstantiveSections = sections.filter(s => s.classification === 'substantive').length

  return {
    sections,
    totalSubstantiveSections,
    analyzedAt: new Date().toISOString(),
  }
}

/**
 * Marshal a sectionMap object into DynamoDB Map attribute format.
 */
function marshalSectionMap(sectionMap) {
  return {
    M: {
      sections: {
        L: sectionMap.sections.map(s => {
          const entry = {
            M: {
              id: { S: s.id },
              title: { S: s.title },
              classification: { S: s.classification },
            },
          }
          if (Number.isInteger(s.wordCount) && s.wordCount >= 0) {
            entry.M.wordCount = { N: String(s.wordCount) }
          }
          return entry
        }),
      },
      totalSubstantiveSections: { N: String(sectionMap.totalSubstantiveSections) },
      analyzedAt: { S: sectionMap.analyzedAt },
    },
  }
}

export { parseSectionMap, marshalSectionMap }

export const handler = async (event) => {
  const { itemId, tenantId } = event || {}

  if (!itemId || !tenantId) {
    log('error', 'AnalyzeDocument: missing itemId or tenantId', { itemId, tenantId })
    return
  }

  try {
    // 1. Read extracted text from S3
    const s3Key = `pulse/${tenantId}/items/${itemId}/extracted.md`
    let extractedText
    try {
      extractedText = await getS3Text(process.env.DATA_BUCKET, s3Key)
    } catch (err) {
      log('error', 'AnalyzeDocument: failed to read extracted text from S3', { tenantId, itemId, errorName: err.name })
      return // Graceful fallback — no sectionMap, item uses totalSections: 5
    }

    if (!extractedText || extractedText.trim().length === 0) {
      log('warn', 'AnalyzeDocument: extracted text is empty', { tenantId, itemId })
      return
    }

    // 2. Call Bedrock to classify sections
    const systemPrompt = `You are a document analysis assistant. Your job is to identify the major sections of a document and classify each as either "substantive" (contains meaningful content worth discussing in a feedback session) or "lightweight" (supporting material like glossaries, tables of contents, appendices, status tables, boilerplate).

Return a JSON object with this exact structure:
{
  "sections": [
    { "id": "s1", "title": "Section Title", "classification": "substantive", "wordCount": 450 },
    { "id": "s2", "title": "Another Section", "classification": "lightweight", "wordCount": 120 }
  ]
}

Rules:
- Use sequential IDs: s1, s2, s3, etc.
- Title should be the actual section heading from the document, or a brief descriptive title if no heading exists.
- Classification must be exactly "substantive" or "lightweight".
- wordCount is the approximate number of words in the section body content, excluding the section title. Must be a non-negative integer.
- Aim for 3-10 sections. If the document is very short, 2-3 sections is fine.
- Do not include sub-sections — only top-level structural divisions.
- Return ONLY the JSON object, no other text.`

    let bedrockResponse
    try {
      bedrockResponse = await bedrock.send(new ConverseCommand({
        modelId: process.env.BEDROCK_MODEL_ID,
        system: [{ text: systemPrompt }],
        messages: [
          { role: 'user', content: [{ text: `Analyze this document and classify its sections:\n\n${extractedText.slice(0, 50000)}` }] },
        ],
        inferenceConfig: { maxTokens: 2048 },
      }))
    } catch (err) {
      log('error', 'AnalyzeDocument: Bedrock invocation failed', { tenantId, itemId, errorName: err.name })
      return // Graceful fallback
    }

    const responseText = bedrockResponse.output?.message?.content?.[0]?.text ?? ''

    // 3. Parse and validate the response
    let sectionMap
    try {
      sectionMap = parseSectionMap(responseText)
    } catch (err) {
      log('error', 'AnalyzeDocument: failed to parse Bedrock response', { tenantId, itemId, errorName: err.name, errorMessage: err.message })
      return // Graceful fallback
    }

    // 4. Write sectionMap to item record (only if item is still draft or active)
    try {
      await dynamo.send(new UpdateItemCommand({
        TableName: process.env.ITEMS_TABLE,
        Key: {
          tenantId: { S: tenantId },
          itemId: { S: itemId },
        },
        UpdateExpression: 'SET sectionMap = :sm, updatedAt = :now',
        ConditionExpression: '#status IN (:draft, :active)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':sm': marshalSectionMap(sectionMap),
          ':now': { S: new Date().toISOString() },
          ':draft': { S: 'draft' },
          ':active': { S: 'active' },
        },
      }))
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') {
        log('warn', 'AnalyzeDocument: item was closed/revised before analysis completed, skipping write', { tenantId, itemId })
        return
      }
      throw err
    }

    log('info', 'AnalyzeDocument: sectionMap written', {
      tenantId, itemId,
      sectionCount: sectionMap.sections.length,
      substantiveCount: sectionMap.totalSubstantiveSections,
    })
  } catch (err) {
    // Catch-all: log and do NOT update item record
    log('error', 'AnalyzeDocument: unexpected error', { tenantId, itemId, errorName: err.name, errorMessage: err.message })
  }
}
