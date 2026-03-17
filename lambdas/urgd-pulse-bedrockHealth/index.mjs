// ur/gd pulse — Bedrock Health Lambda
// GET /v1/bedrock/health → 200 { status: "degraded", reason: "Bedrock not configured" } (S0)

import { createResponse, log } from './utils.mjs'

// Fail-fast env var validation
const REQUIRED_ENV = ['CORS_ALLOWED_ORIGINS', 'BEDROCK_MODEL_ID']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin

  log('info', 'Bedrock health check', { modelId: process.env.BEDROCK_MODEL_ID })

  // S0: Bedrock not yet wired — return degraded
  return createResponse(200, { status: 'degraded', reason: 'Bedrock not configured' }, {}, origin)
}
