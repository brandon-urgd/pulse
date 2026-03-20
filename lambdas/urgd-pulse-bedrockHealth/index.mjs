// ur/gd pulse — Bedrock Health Lambda
// GET /v1/bedrock/health → 200 { status: "healthy" }

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { createResponse, log } from './shared/utils.mjs'

// Fail-fast env var validation
const REQUIRED_ENV = ['CORS_ALLOWED_ORIGINS', 'BEDROCK_MODEL_ID']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' })

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin

  log('info', 'Bedrock health check', { modelId: process.env.BEDROCK_MODEL_ID })

  try {
    await bedrock.send(new InvokeModelCommand({
      modelId: process.env.BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    }))

    return createResponse(200, { status: 'healthy' }, {}, origin)
  } catch (err) {
    log('warn', 'Bedrock health check failed', { errorName: err.name })
    return createResponse(200, { status: 'degraded', reason: err.name }, {}, origin)
  }
}
