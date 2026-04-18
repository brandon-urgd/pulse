// ur/gd pulse — Shared priming module
// Fires an async Bedrock ConverseCommand to warm the prompt cache.
// Called from validateSession, createSelfSession, and previewSession Lambdas.
// Fire-and-forget: logs success/failure, never throws.

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { buildSystemPrompt } from './buildSystemPrompt.mjs'
import { log } from './utils.mjs'

// Module-level SDK clients — initialized once per Lambda cold start, reused across invocations.
// Shared module imported by entry point Lambdas (validateSession, createSelfSession, previewSession).
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-west-2' })
const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

/**
 * Read raw bytes from S3. Returns null on any error.
 */
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

/**
 * Check whether the priming call should be initiated.
 *
 * Eligibility:
 *   - itemType === 'document'
 *   - documentKey exists and has a .pdf or .docx extension
 *   - BEDROCK_MODEL_ID and DATA_BUCKET env vars (or explicit params) are set
 */
export function isPrimingEligible({ itemType, documentKey, bedrockModelId, dataBucket }) {
  if (itemType !== 'document') return false
  if (!documentKey) return false

  const ext = documentKey.split('.').pop()?.toLowerCase()
  if (ext !== 'pdf' && ext !== 'docx') return false

  if (!bedrockModelId || !dataBucket) return false

  return true
}

/**
 * Async cache priming — warms the Bedrock prompt cache by sending the same
 * prefix that the Chat Lambda will use at turn 3 (document injection turn).
 *
 * This function:
 *   1. Checks eligibility (item type, document key, env vars)
 *   2. Loads native document bytes and page images from S3
 *   3. Builds the system prompt with nativeDocumentAvailable: true
 *   4. Sends a ConverseCommand with maxTokens: 1 (response discarded)
 *   5. Logs success at info level or failure at warn level
 *   6. Never throws — all errors are caught and logged
 *
 * @param {Object} params
 * @param {string} params.itemName - Item display name
 * @param {string} params.itemDescription - Item description / feedback focus
 * @param {string} params.itemType - 'document', 'image', or 'markdown'
 * @param {string} params.documentKey - S3 key for the native document
 * @param {number} params.pageCount - Number of page images
 * @param {string} params.tenantId - Tenant identifier
 * @param {string} params.itemId - Item identifier
 * @param {string} params.sessionId - Session identifier
 * @param {string} params.requestId - Request identifier for logging
 * @param {Object|null} params.frozenSnapshot - Frozen session snapshot
 * @param {number} params.timeLimitMinutes - Session time limit
 * @param {boolean} params.isSelfReview - Whether this is a self-review session
 * @param {Object|null} params.coverageMap - Item coverage map
 * @param {string} params.dataBucket - S3 bucket name (DATA_BUCKET)
 * @param {string} params.bedrockModelId - Bedrock model ID (BEDROCK_MODEL_ID)
 */
export async function primeCacheAsync({
  itemName, itemDescription, itemType, documentKey, pageCount,
  tenantId, itemId, sessionId, requestId,
  frozenSnapshot, timeLimitMinutes, isSelfReview, coverageMap,
  dataBucket, bedrockModelId,
}) {
  const primingStart = Date.now()

  // Read feature flag — must match Chat Lambda behavior for cache prefix alignment
  const includePageImages = process.env.INCLUDE_PAGE_IMAGES_ON_INJECTION === 'true'

  try {
    // Eligibility check
    if (!isPrimingEligible({ itemType, documentKey, bedrockModelId, dataBucket })) {
      return
    }

    // Load native document bytes
    const nativeDocBytes = await getS3Bytes(dataBucket, documentKey)
    if (!nativeDocBytes) {
      log('warn', 'Priming: native document not available from S3, skipping', {
        requestId, sessionId, tenantId, documentKey,
        primingDurationMs: Date.now() - primingStart,
      })
      return
    }

    // Determine total sections from frozenSnapshot
    let totalSections
    if (frozenSnapshot?.feedbackSections && Array.isArray(frozenSnapshot.feedbackSections)) {
      totalSections = frozenSnapshot.feedbackSections.length
    } else {
      totalSections = 5
    }

    // Build system prompt with nativeDocumentAvailable: true (matching turn 3)
    const systemPrompt = buildSystemPrompt({
      itemName: itemName || 'this item',
      itemDescription: itemDescription || '',
      itemContent: '',  // Not needed when nativeDocumentAvailable is true
      itemType,
      totalSections,
      currentSection: 1,
      closingState: 'exploring',
      windingDown: undefined,
      message: '',
      isSpecial: false,
      frozenSnapshot: frozenSnapshot || null,
      coverageMap: coverageMap || null,
      imageBase64: null,
      isSelfReview: isSelfReview || false,
      timeLimitMinutes: timeLimitMinutes || 30,
      nativeDocumentAvailable: true,
      includePageImages,
    })

    // Build user content blocks — same structure as Chat Lambda turn 3
    const userContent = []

    // Document block
    const ext = documentKey.split('.').pop()?.toLowerCase()
    userContent.push({ document: { format: ext, name: 'document', source: { bytes: nativeDocBytes } } })

    // Page images (same order as Chat Lambda) — only when feature flag is enabled
    if (includePageImages) {
      for (let p = 1; p <= (pageCount || 0); p++) {
        const pageKey = `pulse/${tenantId}/items/${itemId}/pages/page-${String(p).padStart(3, '0')}.png`
        try {
          const pageBytes = await getS3Bytes(dataBucket, pageKey)
          if (pageBytes) {
            userContent.push({ image: { format: 'png', source: { bytes: pageBytes } } })
          }
        } catch {
          log('warn', 'Priming: failed to read page image, skipping', { requestId, sessionId, page: p })
        }
      }
    }

    // Cache point after document + images
    userContent.push({ cachePoint: { type: 'default' } })

    // Minimal placeholder user message (required by Converse API)
    userContent.push({ text: '[cache_priming]' })

    // Send priming call
    const primingResponse = await bedrock.send(new ConverseCommand({
      modelId: bedrockModelId,
      system: [
        { text: systemPrompt },
        { cachePoint: { type: 'default' } },
      ],
      messages: [{ role: 'user', content: userContent }],
      inferenceConfig: { maxTokens: 1 },
    }))

    const primingDurationMs = Date.now() - primingStart
    const cacheWriteInputTokens = primingResponse.usage?.cacheWriteInputTokens || 0
    const cacheReadInputTokens = primingResponse.usage?.cacheReadInputTokens || 0

    log('info', 'Priming: cache priming completed', {
      requestId, sessionId, tenantId,
      primingDurationMs,
      cacheWriteInputTokens,
      cacheReadInputTokens,
      inputTokens: primingResponse.usage?.inputTokens || 0,
      outputTokens: primingResponse.usage?.outputTokens || 0,
    })
  } catch (err) {
    log('warn', 'Priming: cache priming failed', {
      requestId, sessionId, tenantId,
      primingDurationMs: Date.now() - primingStart,
      errorName: err?.name,
      errorMessage: err?.message,
    })
  }
}
