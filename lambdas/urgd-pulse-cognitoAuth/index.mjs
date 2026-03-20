// ur/gd pulse — Cognito JWT Authorizer
// Validates RS256 Cognito JWT, caches JWKS 5 min, extracts tenantId

import { log } from './shared/utils.mjs'

// Fail-fast env var validation
const REQUIRED_ENV = ['USER_POOL_ID', 'USER_POOL_CLIENT_ID']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`)
  }
}

const { USER_POOL_ID, USER_POOL_CLIENT_ID } = process.env
const REGION = process.env.AWS_REGION || 'us-west-2'
const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`

// In-memory JWKS cache (5 min TTL)
let jwksCache = null
let jwksCacheExpiry = 0

const fetchJwks = async () => {
  const now = Date.now()
  if (jwksCache && now < jwksCacheExpiry) return jwksCache

  const res = await fetch(JWKS_URL)
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`)
  const data = await res.json()
  jwksCache = data.keys
  jwksCacheExpiry = now + 5 * 60 * 1000
  return jwksCache
}

// Base64url decode
const b64urlDecode = (str) =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

// Parse JWT without verifying (for header/payload extraction)
const parseJwt = (token) => {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT structure')
  return {
    header: JSON.parse(b64urlDecode(parts[0])),
    payload: JSON.parse(b64urlDecode(parts[1])),
    parts,
  }
}

// Build RSA public key from JWK using Node crypto
const jwkToPublicKey = async (jwk) => {
  const { createPublicKey } = await import('crypto')
  const keyData = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
  }
  return createPublicKey({ key: keyData, format: 'jwk' })
}

// Verify RS256 signature
const verifySignature = async (token, publicKey) => {
  const { createVerify } = await import('crypto')
  const parts = token.split('.')
  const data = `${parts[0]}.${parts[1]}`
  const sig = b64urlDecode(parts[2])
  const verifier = createVerify('RSA-SHA256')
  verifier.update(data)
  return verifier.verify(publicKey, sig)
}

const generatePolicy = (principalId, effect, resource, context = {}) => ({
  principalId,
  policyDocument: {
    Version: '2012-10-17',
    Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
  },
  context,
})

export const handler = async (event) => {
  const token = (event.authorizationToken || '').replace(/^Bearer\s+/i, '')

  if (!token) {
    log('warn', 'CognitoAuth: missing token')
    return generatePolicy('anonymous', 'Deny', event.methodArn)
  }

  try {
    const { header, payload } = parseJwt(token)

    // Validate issuer and client_id
    if (payload.iss !== ISSUER) throw new Error('Invalid issuer')
    if (payload.client_id !== USER_POOL_CLIENT_ID && payload.aud !== USER_POOL_CLIENT_ID) {
      throw new Error('Invalid client_id/aud')
    }

    // Validate expiry
    if (Date.now() / 1000 > payload.exp) throw new Error('Token expired')

    // Find matching JWK by kid
    const keys = await fetchJwks()
    const jwk = keys.find((k) => k.kid === header.kid)
    if (!jwk) throw new Error(`No matching JWK for kid: ${header.kid}`)

    const publicKey = await jwkToPublicKey(jwk)
    const valid = await verifySignature(token, publicKey)
    if (!valid) throw new Error('Invalid signature')

    const tenantId = payload['custom:tenantId'] || payload.sub
    log('info', 'CognitoAuth: allowed', { sub: payload.sub })

    // Use wildcard ARN so the cached policy covers all methods on this API/stage
    const arnParts = event.methodArn.split('/')
    const wildcardArn = `${arnParts[0]}/*/*`
    return generatePolicy(payload.sub, 'Allow', wildcardArn, { tenantId, username: payload.username || payload.sub })
  } catch (err) {
    log('warn', 'CognitoAuth: denied', { reason: err.message })
    const arnParts = event.methodArn.split('/')
    const wildcardArn = `${arnParts[0]}/*/*`
    return generatePolicy('anonymous', 'Deny', wildcardArn)
  }
}
