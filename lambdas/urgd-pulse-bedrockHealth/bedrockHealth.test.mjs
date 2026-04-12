// Unit tests for urgd-pulse-bedrockHealth
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

const { handler } = await import('./index.mjs')

function makeEvent() {
  return { headers: { origin: 'https://pulse.urgdstudios.com' } }
}

describe('urgd-pulse-bedrockHealth', () => {
  beforeEach(() => {
    bedrockSendSpy.mockReset()
  })

  it('returns healthy when Bedrock responds successfully', async () => {
    bedrockSendSpy.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'pong' }] } },
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    const result = await handler(makeEvent())

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.status).toBe('healthy')
  })

  it('returns degraded when Bedrock throws an error', async () => {
    const err = Object.assign(new Error('ServiceUnavailable'), { name: 'ServiceUnavailableException' })
    bedrockSendSpy.mockRejectedValueOnce(err)

    const result = await handler(makeEvent())

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.status).toBe('degraded')
    expect(body.reason).toBe('ServiceUnavailableException')
  })

  it('returns degraded when Bedrock throws a generic error', async () => {
    bedrockSendSpy.mockRejectedValueOnce(new Error('Network error'))

    const result = await handler(makeEvent())

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.status).toBe('degraded')
  })

  it('includes CORS headers in response', async () => {
    bedrockSendSpy.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'pong' }] } },
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    const result = await handler(makeEvent())

    expect(result.headers).toHaveProperty('Access-Control-Allow-Origin')
  })

  it('invokes Bedrock with the configured model ID', async () => {
    bedrockSendSpy.mockResolvedValueOnce({
      output: { message: { content: [{ text: 'pong' }] } },
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    await handler(makeEvent())

    expect(bedrockSendSpy).toHaveBeenCalledTimes(1)
    const call = bedrockSendSpy.mock.calls[0][0]
    expect(call.input.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0')
  })
})
