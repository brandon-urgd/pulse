// Property-based tests for Phased Cache Priming — Property 1: Priming Eligibility
// Feature: phased-cache-priming, Property 1: priming eligibility — document items with native docs only
// **Validates: Requirements 1.1, 1.2, 1.3, 9.1, 9.2**
//
// For any item type, document key, and document extension combination, the priming function
// SHALL be initiated if and only if the item type is `document` AND a document key exists
// AND the extension is `pdf` or `docx`. For image items, text-only items, or items without
// a native document, priming SHALL NOT be initiated.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'

// ── Environment variables ──

vi.stubEnv('AWS_REGION', 'us-west-2')

// ── AWS SDK mocks ──
// The priming module creates its own S3Client and BedrockRuntimeClient.
// We mock them at the module level so we can track calls.

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

const { isPrimingEligible, primeCacheAsync } = await import('../../lambdas/shared/primeCacheAsync.mjs')

// ── Generators ──

const itemTypeArb = fc.constantFrom('document', 'image', 'markdown', 'text')

const validDocExtArb = fc.constantFrom('pdf', 'docx')
const invalidDocExtArb = fc.constantFrom('md', 'txt', 'jpg', 'png', 'html', 'csv', 'xlsx')
const anyExtArb = fc.oneof(validDocExtArb, invalidDocExtArb)

const tenantIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0)
const itemIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0)

// Generate a document key with a specific extension
const docKeyWithExtArb = (extArb) =>
  fc.tuple(tenantIdArb, itemIdArb, extArb).map(
    ([tenant, item, ext]) => `pulse/${tenant}/items/${item}/document.${ext}`
  )

// Generate a document key that may or may not exist
const docKeyOrNullArb = fc.oneof(
  docKeyWithExtArb(anyExtArb),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
)

const bedrockModelIdArb = fc.oneof(
  fc.constant('us.anthropic.claude-sonnet-4-6'),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
)

const dataBucketArb = fc.oneof(
  fc.constant('urgd-pulse-data-dev'),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
)

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 1: Priming eligibility — document items with native docs only
// **Validates: Requirements 1.1, 1.2, 1.3, 9.1, 9.2**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 1: priming eligibility — document items with native docs only', () => {

  it('isPrimingEligible returns true only for document items with PDF/DOCX and valid env vars', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        docKeyOrNullArb,
        bedrockModelIdArb,
        dataBucketArb,
        (itemType, documentKey, bedrockModelId, dataBucket) => {
          const result = isPrimingEligible({ itemType, documentKey, bedrockModelId, dataBucket })

          // Determine expected eligibility
          const isDocument = itemType === 'document'
          const hasDocKey = !!documentKey
          const ext = documentKey ? documentKey.split('.').pop()?.toLowerCase() : null
          const hasValidExt = ext === 'pdf' || ext === 'docx'
          const hasModelId = !!bedrockModelId
          const hasBucket = !!dataBucket

          const expectedEligible = isDocument && hasDocKey && hasValidExt && hasModelId && hasBucket

          expect(result).toBe(expectedEligible)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('image items are never eligible for priming', () => {
    fc.assert(
      fc.property(
        docKeyWithExtArb(validDocExtArb),
        (documentKey) => {
          const result = isPrimingEligible({
            itemType: 'image',
            documentKey,
            bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
            dataBucket: 'urgd-pulse-data-dev',
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('text/markdown items are never eligible for priming', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('markdown', 'text'),
        docKeyWithExtArb(validDocExtArb),
        (itemType, documentKey) => {
          const result = isPrimingEligible({
            itemType,
            documentKey,
            bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
            dataBucket: 'urgd-pulse-data-dev',
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('document items without a native document key are not eligible', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(null, undefined, ''),
        (documentKey) => {
          const result = isPrimingEligible({
            itemType: 'document',
            documentKey,
            bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
            dataBucket: 'urgd-pulse-data-dev',
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 10 },
    )
  })

  it('document items with non-PDF/DOCX extensions are not eligible', () => {
    fc.assert(
      fc.property(
        invalidDocExtArb,
        (ext) => {
          const result = isPrimingEligible({
            itemType: 'document',
            documentKey: `pulse/tenant/items/item/document.${ext}`,
            bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
            dataBucket: 'urgd-pulse-data-dev',
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('missing BEDROCK_MODEL_ID makes priming ineligible', () => {
    fc.assert(
      fc.property(
        docKeyWithExtArb(validDocExtArb),
        fc.constantFrom(null, undefined, ''),
        (documentKey, bedrockModelId) => {
          const result = isPrimingEligible({
            itemType: 'document',
            documentKey,
            bedrockModelId,
            dataBucket: 'urgd-pulse-data-dev',
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('missing DATA_BUCKET makes priming ineligible', () => {
    fc.assert(
      fc.property(
        docKeyWithExtArb(validDocExtArb),
        fc.constantFrom(null, undefined, ''),
        (documentKey, dataBucket) => {
          const result = isPrimingEligible({
            itemType: 'document',
            documentKey,
            bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
            dataBucket,
          })
          expect(result).toBe(false)
        },
      ),
      { numRuns: 30 },
    )
  })

  describe('primeCacheAsync integration — eligibility gate', () => {
    beforeEach(() => {
      s3SendSpy.mockReset()
      bedrockSendSpy.mockReset()
    })

    it('does not call S3 or Bedrock for ineligible items', async () => {
      // Generate ineligible configurations and verify no AWS calls are made
      const ineligibleConfigs = [
        { itemType: 'image', documentKey: 'doc.pdf', bedrockModelId: 'model', dataBucket: 'bucket' },
        { itemType: 'document', documentKey: null, bedrockModelId: 'model', dataBucket: 'bucket' },
        { itemType: 'document', documentKey: 'doc.md', bedrockModelId: 'model', dataBucket: 'bucket' },
        { itemType: 'document', documentKey: 'doc.pdf', bedrockModelId: '', dataBucket: 'bucket' },
        { itemType: 'document', documentKey: 'doc.pdf', bedrockModelId: 'model', dataBucket: '' },
      ]

      for (const config of ineligibleConfigs) {
        s3SendSpy.mockReset()
        bedrockSendSpy.mockReset()

        await primeCacheAsync({
          itemName: 'Test',
          itemDescription: '',
          itemType: config.itemType,
          documentKey: config.documentKey,
          pageCount: 0,
          tenantId: 'tenant-1',
          itemId: 'item-1',
          sessionId: 'session-1',
          requestId: 'req-1',
          frozenSnapshot: null,
          timeLimitMinutes: 30,
          isSelfReview: false,
          coverageMap: null,
          dataBucket: config.dataBucket,
          bedrockModelId: config.bedrockModelId,
        })

        expect(s3SendSpy).not.toHaveBeenCalled()
        expect(bedrockSendSpy).not.toHaveBeenCalled()
      }
    })
  })
})
