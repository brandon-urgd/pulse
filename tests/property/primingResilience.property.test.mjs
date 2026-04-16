// Property-based tests for Phased Cache Priming — Property 9: Priming Failure Resilience
// Feature: phased-cache-priming, Property 9: priming failure resilience
// **Validates: Requirements 1.5**
//
// For any error thrown during the priming call (Bedrock throttling, S3 read failure,
// timeout, or any exception), the priming function SHALL log the failure at warn level
// and SHALL NOT throw — the calling Lambda continues normally.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('AWS_REGION', 'us-west-2')

// ── AWS SDK mocks ──

const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send(...args) { return s3SendSpy(...args) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send(...args) { return bedrockSendSpy(...args) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand }
})

// Mock buildSystemPrompt to avoid pulling in the full prompt builder
vi.mock('./buildSystemPrompt.mjs', () => ({
  buildSystemPrompt: () => 'mock-system-prompt',
}))

// Track console.warn calls for priming failure logging verification
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

const { primeCacheAsync } = await import('../../lambdas/shared/primeCacheAsync.mjs')

// ── Helpers ──

/** Creates a fake S3 readable stream from a Buffer */
function fakeS3Body(buf) {
  return {
    Body: {
      async *[Symbol.asyncIterator]() { yield buf },
    },
  }
}

const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4 fake document content')

/** Standard eligible priming params */
function makeEligibleParams(overrides = {}) {
  return {
    itemName: 'Test Document',
    itemDescription: 'A test document',
    itemType: 'document',
    documentKey: 'pulse/tenant-1/items/item-1/document.pdf',
    pageCount: 0,
    tenantId: 'tenant-1',
    itemId: 'item-1',
    sessionId: 'session-1',
    requestId: 'req-1',
    frozenSnapshot: null,
    timeLimitMinutes: 30,
    isSelfReview: false,
    coverageMap: null,
    dataBucket: 'urgd-pulse-data-dev',
    bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
    ...overrides,
  }
}

// ── Generators ──

// Generate various error types that could occur during priming
const errorNameArb = fc.constantFrom(
  'ThrottlingException',
  'AccessDeniedException',
  'ServiceUnavailableException',
  'ValidationException',
  'ModelTimeoutException',
  'InternalServerException',
  'ResourceNotFoundException',
  'NoSuchKey',
  'NetworkingError',
  'TimeoutError',
  'Error',
  'TypeError',
  'RangeError',
)

const errorMessageArb = fc.constantFrom(
  'Rate exceeded',
  'Access denied',
  'Service unavailable',
  'Model timeout',
  'Internal server error',
  'The specified key does not exist',
  'Network error',
  'Connection timed out',
  'Unexpected error',
)

const errorArb = fc.tuple(errorNameArb, errorMessageArb).map(([name, message]) => {
  const err = new Error(message)
  err.name = name
  return err
})

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 9: Priming failure resilience
// **Validates: Requirements 1.5**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 9: priming failure resilience', () => {
  beforeEach(() => {
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
    consoleWarnSpy.mockClear()
  })

  it('for any Bedrock error, primeCacheAsync does not throw and logs a warning', async () => {
    await fc.assert(
      fc.asyncProperty(
        errorArb,
        async (error) => {
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          consoleWarnSpy.mockClear()

          // S3 succeeds (document loads fine)
          s3SendSpy.mockResolvedValue(fakeS3Body(FAKE_PDF_BYTES))

          // Bedrock throws the generated error
          bedrockSendSpy.mockRejectedValue(error)

          // primeCacheAsync must NOT throw
          await expect(
            primeCacheAsync(makeEligibleParams())
          ).resolves.not.toThrow()

          // A warning must have been logged
          const warnCalls = consoleWarnSpy.mock.calls.map(c => c[0])
          const primingWarn = warnCalls.find(msg =>
            typeof msg === 'string' && msg.includes('priming')
          )
          expect(primingWarn).toBeDefined()

          // The warning should contain the error name
          expect(primingWarn).toContain(error.name)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any S3 error loading the document, primeCacheAsync does not throw', async () => {
    await fc.assert(
      fc.asyncProperty(
        errorArb,
        async (error) => {
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          consoleWarnSpy.mockClear()

          // S3 fails to load the document
          s3SendSpy.mockRejectedValue(error)

          // primeCacheAsync must NOT throw
          await expect(
            primeCacheAsync(makeEligibleParams())
          ).resolves.not.toThrow()

          // Bedrock should NOT have been called (document load failed)
          expect(bedrockSendSpy).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any S3 error loading page images, primeCacheAsync does not throw and still calls Bedrock', async () => {
    await fc.assert(
      fc.asyncProperty(
        errorArb,
        fc.integer({ min: 1, max: 5 }),
        async (error, pageCount) => {
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          consoleWarnSpy.mockClear()

          // S3: document loads fine, page images fail
          let callCount = 0
          s3SendSpy.mockImplementation(() => {
            callCount++
            if (callCount === 1) {
              // First call is the document — succeeds
              return Promise.resolve(fakeS3Body(FAKE_PDF_BYTES))
            }
            // Subsequent calls are page images — return null (getS3Bytes catches errors)
            return Promise.reject(error)
          })

          // Bedrock succeeds
          bedrockSendSpy.mockResolvedValue({
            usage: { inputTokens: 100, outputTokens: 1, cacheWriteInputTokens: 90, cacheReadInputTokens: 0 },
          })

          // primeCacheAsync must NOT throw
          await expect(
            primeCacheAsync(makeEligibleParams({ pageCount }))
          ).resolves.not.toThrow()

          // Bedrock should still have been called (document loaded, page images are optional)
          expect(bedrockSendSpy).toHaveBeenCalledTimes(1)
        },
      ),
      { numRuns: 50 },
    )
  })

  it('for any error type, the return value is undefined (silent failure)', async () => {
    await fc.assert(
      fc.asyncProperty(
        errorArb,
        async (error) => {
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()
          consoleWarnSpy.mockClear()

          s3SendSpy.mockResolvedValue(fakeS3Body(FAKE_PDF_BYTES))
          bedrockSendSpy.mockRejectedValue(error)

          const result = await primeCacheAsync(makeEligibleParams())

          // Fire-and-forget: return value is undefined
          expect(result).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })
})
