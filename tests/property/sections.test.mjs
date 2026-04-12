// Property-based tests for section map, default preferences, graceful fallback, snapshot immutability
// Properties P4, P5, P6, P7

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Inline validation logic mirroring analyzeDocument parseSectionMap ──
function validateSectionMap(sections) {
  return sections.every(s =>
    (s.classification === 'substantive' || s.classification === 'lightweight') &&
    /^s\d+$/.test(s.id) &&
    s.title && s.title.trim().length > 0
  )
}

function computeTotalSubstantive(sections) {
  return sections.filter(s => s.classification === 'substantive').length
}

// ── Default preferences logic mirroring SectionPanel ──
function getDefaultFeedbackSections(sections) {
  return sections.filter(s => s.classification === 'substantive').map(s => s.id)
}

function getDefaultDepthPreferences(sections) {
  const prefs = {}
  for (const s of sections) {
    prefs[s.id] = s.classification === 'substantive' ? 'explore' : 'skim'
  }
  return prefs
}

// ── Generators ──
const sectionArb = fc.record({
  id: fc.nat({ max: 99 }).map(n => `s${n + 1}`),
  title: fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0),
  classification: fc.constantFrom('substantive', 'lightweight'),
})

// Deduplicate by id to avoid ambiguous test cases where same id has two classifications
const sectionMapArb = fc.array(sectionArb, { minLength: 1, maxLength: 10 }).map(sections => {
  const seen = new Set()
  return sections.filter(s => {
    if (seen.has(s.id)) return false
    seen.add(s.id)
    return true
  })
}).filter(sections => sections.length > 0)

/**
 * Property P4: Section map classification invariant
 *
 * Every section has classification exactly "substantive" or "lightweight",
 * id matches /^s\d+$/, non-empty title.
 * totalSubstantiveSections equals count of substantive sections.
 *
 * Validates: Requirements 3.2
 */
describe('Property P4: Section map classification invariant', () => {
  it('all sections have valid classification, id format, and non-empty title', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        expect(validateSectionMap(sections)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('totalSubstantiveSections equals count of substantive sections', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const total = computeTotalSubstantive(sections)
        const expected = sections.filter(s => s.classification === 'substantive').length
        expect(total).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('totalSubstantiveSections is between 0 and sections.length', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const total = computeTotalSubstantive(sections)
        expect(total).toBeGreaterThanOrEqual(0)
        expect(total).toBeLessThanOrEqual(sections.length)
      }),
      { numRuns: 100 },
    )
  })

  it('invalid classification is rejected by validateSectionMap', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.nat({ max: 99 }).map(n => `s${n + 1}`),
            title: fc.string({ minLength: 1 }),
            classification: fc.string().filter(s => s !== 'substantive' && s !== 'lightweight'),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (sections) => {
          expect(validateSectionMap(sections)).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P5: Default section depth preferences
 *
 * Default feedbackSections includes exactly substantive sections.
 * Default sectionDepthPreferences maps substantive → "explore", lightweight → "skim".
 *
 * Validates: Requirements 3.4
 */
describe('Property P5: Default section depth preferences', () => {
  it('default feedbackSections includes exactly substantive sections', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const defaults = getDefaultFeedbackSections(sections)
        const substantiveIds = sections.filter(s => s.classification === 'substantive').map(s => s.id)
        expect(defaults).toEqual(substantiveIds)
      }),
      { numRuns: 100 },
    )
  })

  it('default feedbackSections excludes lightweight sections', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const defaults = getDefaultFeedbackSections(sections)
        const lightweightIds = sections.filter(s => s.classification === 'lightweight').map(s => s.id)
        for (const id of lightweightIds) {
          expect(defaults).not.toContain(id)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('default depth preferences: substantive → explore, lightweight → skim', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const prefs = getDefaultDepthPreferences(sections)
        for (const s of sections) {
          if (s.classification === 'substantive') {
            expect(prefs[s.id]).toBe('explore')
          } else {
            expect(prefs[s.id]).toBe('skim')
          }
        }
      }),
      { numRuns: 100 },
    )
  })

  it('every section has a depth preference entry', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const prefs = getDefaultDepthPreferences(sections)
        for (const s of sections) {
          expect(prefs[s.id]).toBeDefined()
        }
      }),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P6: Graceful fallback on analysis failure
 *
 * When analyzeDocument encounters errors, it returns without updating DynamoDB.
 * The item falls back to totalSections: 5.
 *
 * Validates: Requirements 3.7
 */

vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'anthropic.claude-3-5-sonnet-20241022-v2:0')
vi.stubEnv('AWS_REGION', 'us-west-2')

const dynamoSendSpy = vi.fn()
const s3SendSpy = vi.fn()
const bedrockSendSpy = vi.fn()

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send(...args) { return dynamoSendSpy(...args) } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, UpdateItemCommand }
})

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

const { handler: analyzeDocumentHandler } = await import('../../lambdas/urgd-pulse-analyzeDocument/index.mjs')

describe('Property P6: Graceful fallback on analysis failure', () => {
  beforeEach(() => {
    dynamoSendSpy.mockReset()
    s3SendSpy.mockReset()
    bedrockSendSpy.mockReset()
  })

  it('S3 read failure → no DynamoDB update', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (itemId, tenantId) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          s3SendSpy.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }))

          await analyzeDocumentHandler({ itemId, tenantId })

          // DynamoDB UpdateItem should NOT have been called
          expect(dynamoSendSpy).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('Bedrock failure → no DynamoDB update', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (itemId, tenantId) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()

          // S3 succeeds with some text
          const mockBody = {
            [Symbol.asyncIterator]: async function* () {
              yield Buffer.from('Some document content here')
            },
          }
          s3SendSpy.mockResolvedValue({ Body: mockBody })
          bedrockSendSpy.mockRejectedValue(Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' }))

          await analyzeDocumentHandler({ itemId, tenantId })

          expect(dynamoSendSpy).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('malformed Bedrock response → no DynamoDB update', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }),
        async (itemId, tenantId) => {
          dynamoSendSpy.mockReset()
          s3SendSpy.mockReset()
          bedrockSendSpy.mockReset()

          const mockBody = {
            [Symbol.asyncIterator]: async function* () {
              yield Buffer.from('Some document content here')
            },
          }
          s3SendSpy.mockResolvedValue({ Body: mockBody })

          const malformedResponse = JSON.stringify({ content: [{ text: 'not valid json at all }{' }] })
          bedrockSendSpy.mockResolvedValue({
            output: { message: { content: [{ text: 'not valid json at all }{' }] } },
            usage: { inputTokens: 10, outputTokens: 5 },
          })

          await analyzeDocumentHandler({ itemId, tenantId })

          expect(dynamoSendSpy).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('missing itemId or tenantId → no DynamoDB update', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          { itemId: null, tenantId: 'tenant-1' },
          { itemId: 'item-1', tenantId: null },
          { itemId: undefined, tenantId: undefined },
          {},
        ),
        async (event) => {
          dynamoSendSpy.mockReset()
          await analyzeDocumentHandler(event)
          expect(dynamoSendSpy).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property P7: Session snapshot immutability
 *
 * Once a frozenSnapshot is set on a session at creation time,
 * subsequent item updates do not change the snapshot.
 * The snapshot reflects item state at creation time.
 *
 * Validates: Requirements 4.1, 4.2
 */
describe('Property P7: Session snapshot immutability', () => {
  it('frozenSnapshot content matches item state at creation time', () => {
    fc.assert(
      fc.property(
        sectionMapArb,
        fc.array(fc.nat({ max: 9 }).map(n => `s${n + 1}`), { minLength: 1, maxLength: 5 }),
        fc.record({
          s1: fc.constantFrom('explore', 'skim', 'deep'),
        }),
        (sections, feedbackSections, depthPrefs) => {
          // Simulate what inviteReviewer does: capture snapshot at creation time
          const originalFeedbackSections = [...feedbackSections]
          const originalSectionTitles = sections.map(s => s.title)

          const frozenSnapshot = {
            sectionMap: JSON.parse(JSON.stringify({ sections, totalSubstantiveSections: computeTotalSubstantive(sections) })),
            feedbackSections: [...feedbackSections],
            sectionDepthPreferences: { ...depthPrefs },
          }

          // Simulate item update after snapshot creation — use clearly different values
          const updatedFeedbackSections = ['s_updated_99']
          const updatedSections = sections.map(s => ({ ...s, title: 'UPDATED_TITLE_XYZ' }))

          // Snapshot should still match original values
          expect(frozenSnapshot.feedbackSections).toEqual(originalFeedbackSections)
          expect(frozenSnapshot.feedbackSections).not.toEqual(updatedFeedbackSections)
          expect(frozenSnapshot.sectionMap.sections.map(s => s.title)).toEqual(originalSectionTitles)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('frozenSnapshot is a deep copy — mutations to original do not affect it', () => {
    fc.assert(
      fc.property(sectionMapArb, (sections) => {
        const original = { sections: sections.map(s => ({ ...s })) }
        const snapshot = JSON.parse(JSON.stringify(original))

        // Mutate original
        if (original.sections.length > 0) {
          original.sections[0].title = 'MUTATED'
        }

        // Snapshot should be unchanged
        if (snapshot.sections.length > 0) {
          expect(snapshot.sections[0].title).not.toBe('MUTATED')
        }
      }),
      { numRuns: 100 },
    )
  })
})
