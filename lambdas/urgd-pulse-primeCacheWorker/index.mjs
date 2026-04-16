// ur/gd pulse — Prime Cache Worker Lambda
// Invoked asynchronously by entry point Lambdas (validateSession, createSelfSession, previewSession).
// Calls primeCacheAsync with its own execution lifecycle — guaranteed to complete.

import { primeCacheAsync } from './shared/primeCacheAsync.mjs'
import { log } from './shared/utils.mjs'

export const handler = async (event) => {
  const requestId = event.requestId || 'unknown'
  log('info', 'PrimeCacheWorker: invoked', { requestId, sessionId: event.sessionId, tenantId: event.tenantId })

  await primeCacheAsync({
    itemName: event.itemName,
    itemDescription: event.itemDescription,
    itemType: event.itemType,
    documentKey: event.documentKey,
    pageCount: event.pageCount || 0,
    tenantId: event.tenantId,
    itemId: event.itemId,
    sessionId: event.sessionId,
    requestId,
    frozenSnapshot: event.frozenSnapshot || null,
    timeLimitMinutes: event.timeLimitMinutes || 30,
    isSelfReview: event.isSelfReview || false,
    coverageMap: event.coverageMap || null,
    dataBucket: process.env.DATA_BUCKET,
    bedrockModelId: process.env.BEDROCK_MODEL_ID,
  })
}
