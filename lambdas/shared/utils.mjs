// ur/gd pulse — Shared Lambda utilities
// See Lambda Standards for complete documentation

/**
 * Dynamically determines CORS headers based on the request origin
 * and CORS_ALLOWED_ORIGINS env var (comma-separated list).
 */
export const getCorsHeaders = (requestOrigin) => {
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  const corsHeaders = {
    'Access-Control-Allow-Methods': process.env.CORS_ALLOWED_METHODS || 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      process.env.CORS_ALLOWED_HEADERS ||
      'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,x-client-version',
    'Access-Control-Max-Age': process.env.CORS_MAX_AGE || '86400',
  }

  const normalizedOrigin = requestOrigin ? requestOrigin.toLowerCase().trim() : null
  const normalizedAllowed = allowedOrigins.map(o => o.toLowerCase().trim())

  if (normalizedOrigin && normalizedAllowed.includes(normalizedOrigin)) {
    corsHeaders['Access-Control-Allow-Origin'] = requestOrigin
    corsHeaders['Access-Control-Allow-Credentials'] = 'true'
    corsHeaders['Vary'] = 'Origin'
  } else if (allowedOrigins.length > 0 && !requestOrigin) {
    corsHeaders['Access-Control-Allow-Origin'] = allowedOrigins[0]
    corsHeaders['Vary'] = 'Origin'
  } else if (requestOrigin) {
    log('warn', `CORS: Rejected origin ${requestOrigin}`, { allowedOrigins })
  }

  return corsHeaders
}

/**
 * Creates a standardized JSON response with dynamic CORS headers.
 */
export const createResponse = (statusCode, data, additionalHeaders = {}, requestOrigin) => {
  const response = {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(requestOrigin),
      ...additionalHeaders,
    },
  }
  if (statusCode !== 204) {
    response.body = JSON.stringify(data)
  }
  return response
}

/**
 * Creates a standardized error response.
 */
export const errorResponse = (statusCode, message, details = {}, requestOrigin) =>
  createResponse(statusCode, { error: true, message, ...details }, {}, requestOrigin)

/**
 * Structured JSON logging.
 */
export const log = (level, message, context = {}) => {
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    service: process.env.AWS_LAMBDA_FUNCTION_NAME,
    ...context
  })
  if (level === 'error') console.error(output)
  else if (level === 'warn') console.warn(output)
  else console.log(output)
}

/**
 * Creates a structured HTTP error for use in Lambda handlers.
 * NOTE: Not currently used in Pulse handlers — retained for standards compliance.
 * See Lambda Standards for the createAdminError/isAdminHttpError pattern.
 */
export const createAdminError = (statusCode, message, details = {}) => {
  const error = new Error(message)
  error.name = 'AdminHttpError'
  error.statusCode = statusCode
  error.details = details
  return error
}

export const isAdminHttpError = (error) => error?.name === 'AdminHttpError'

/**
 * Input validation helpers
 */
export const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

/**
 * Fail-fast env var validation — throws at module load time if any required var is missing.
 */
export const requireEnv = (names) => {
  for (const key of names) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`)
    }
  }
}

/**
 * Recursively unmarshals a DynamoDB Map (features, serviceFlags, usageCounters)
 * into a plain JS object. Handles N, BOOL, S, and nested M types.
 */
export function unmarshalFeatures(m) {
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
