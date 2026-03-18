// Unit tests for urgd-pulse-register
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Env setup (must happen before module import) ──────────────────────────────
vi.stubEnv('USER_POOL_ID', 'us-west-2_test')
vi.stubEnv('USER_POOL_CLIENT_ID', 'testclientid')
vi.stubEnv('PUBLIC_SIGNUP', 'true')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

// ── Mock AWS SDK ──────────────────────────────────────────────────────────────
// Use a module-level send spy that the mock instance delegates to
const sendSpy = vi.fn()

vi.mock('@aws-sdk/client-cognito-identity-provider', () => {
  class CognitoIdentityProviderClient {
    send(...args) { return sendSpy(...args) }
  }
  class AdminCreateUserCommand {
    constructor(input) { this.input = input }
  }
  class AdminSetUserPasswordCommand {
    constructor(input) { this.input = input }
  }
  return { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand }
})

const { handler } = await import('./index.mjs')

const makeEvent = (body, origin = 'https://pulse.urgdstudios.com') => ({
  headers: { origin },
  requestContext: { requestId: 'req-123' },
  body: JSON.stringify(body),
})

describe('urgd-pulse-register', () => {
  beforeEach(() => {
    sendSpy.mockReset()
    vi.stubEnv('PUBLIC_SIGNUP', 'true')
  })

  it('returns 201 on valid registration', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ name: 'Test User', email: 'test@example.com', password: 'Password1!' }))
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).message).toBe('User registered successfully')
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it('returns 403 when PUBLIC_SIGNUP is false', async () => {
    vi.stubEnv('PUBLIC_SIGNUP', 'false')
    const res = await handler(makeEvent({ name: 'Test', email: 'test@example.com', password: 'Password1!' }))
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).message).toMatch(/not enabled/i)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('returns 409 when email already exists', async () => {
    const err = new Error('User already exists')
    err.name = 'UsernameExistsException'
    sendSpy.mockRejectedValueOnce(err)
    const res = await handler(makeEvent({ name: 'Test', email: 'dupe@example.com', password: 'Password1!' }))
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toMatch(/already exists/i)
  })

  it('returns 400 when name is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/name/i)
  })

  it('returns 400 when email is invalid', async () => {
    const res = await handler(makeEvent({ name: 'Test', email: 'not-an-email', password: 'Password1!' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/email/i)
  })

  it('returns 400 when password is too short', async () => {
    const res = await handler(makeEvent({ name: 'Test', email: 'test@example.com', password: 'short' }))
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/password/i)
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await handler({
      headers: { origin: 'https://pulse.urgdstudios.com' },
      requestContext: { requestId: 'req-bad' },
      body: '{invalid json',
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 500 on unexpected Cognito error', async () => {
    sendSpy.mockRejectedValueOnce(new Error('Service unavailable'))
    const res = await handler(makeEvent({ name: 'Test', email: 'test@example.com', password: 'Password1!' }))
    expect(res.statusCode).toBe(500)
  })

  it('response always has Content-Type application/json', async () => {
    sendSpy.mockResolvedValue({})
    const res = await handler(makeEvent({ name: 'Test', email: 'test@example.com', password: 'Password1!' }))
    expect(res.headers['Content-Type']).toBe('application/json')
  })
})
