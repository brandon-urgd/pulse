// ur/gd pulse — Health Lambda
// GET /v1/health → 200 { status: "healthy" }

import { createResponse, log } from './shared/utils.mjs'

// Fail-fast env var validation
const REQUIRED_ENV = ['CORS_ALLOWED_ORIGINS']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin

  log('info', 'Health check', { path: event.path })

  return createResponse(200, { status: 'healthy' }, {}, origin)
}
