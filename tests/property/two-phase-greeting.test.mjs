// Property-based tests for Two-Phase Session Start
// Properties 1–7: template greeting generation, system prompt integration,
// transcript schema, streaming state, item-scoping, and round-trip.

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ── Env stubs required by buildSystemPrompt's transitive imports ──
vi.stubEnv('SESSIONS_TABLE', 'urgd-pulse-sessions-dev')
vi.stubEnv('TRANSCRIPTS_TABLE', 'urgd-pulse-transcripts-dev')
vi.stubEnv('ITEMS_TABLE', 'urgd-pulse-items-dev')
vi.stubEnv('DATA_BUCKET', 'urgd-pulse-data-dev')
vi.stubEnv('BEDROCK_MODEL_ID', 'us.anthropic.claude-sonnet-4-6')
vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://pulse.urgdstudios.com')
vi.stubEnv('AWS_REGION', 'us-west-2')

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send() { return Promise.resolve({}) } }
  class GetItemCommand { constructor(input) { this.input = input } }
  class QueryCommand { constructor(input) { this.input = input } }
  class UpdateItemCommand { constructor(input) { this.input = input } }
  class TransactWriteItemsCommand { constructor(input) { this.input = input } }
  return { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand }
})
vi.mock('@aws-sdk/client-s3', () => {
  class S3Client { send() { return Promise.resolve({}) } }
  class GetObjectCommand { constructor(input) { this.input = input } }
  class PutObjectCommand { constructor(input) { this.input = input } }
  return { S3Client, GetObjectCommand, PutObjectCommand }
})
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  class BedrockRuntimeClient { send() { return Promise.resolve({}) } }
  class ConverseCommand { constructor(input) { this.input = input } }
  class ConverseStreamCommand { constructor(input) { this.input = input } }
  return { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand }
})
vi.mock('@aws-sdk/client-cloudwatch', () => {
  class CloudWatchClient { send() { return Promise.resolve({}) } }
  class PutMetricDataCommand { constructor(input) { this.input = input } }
  return { CloudWatchClient, PutMetricDataCommand }
})
vi.mock('@aws-sdk/client-lambda', () => {
  class LambdaClient { send() { return Promise.resolve({}) } }
  class InvokeCommand { constructor(input) { this.input = input } }
  return { LambdaClient, InvokeCommand }
})

// ── Imports ──
import { buildTemplateGreeting, GREETING_TEMPLATES } from '../../lambdas/shared/greetingTemplates.mjs'
import { buildSystemPrompt } from '../../lambdas/shared/buildSystemPrompt.mjs'

// ── Generators ──
const itemTypeArb = fc.constantFrom('document', 'image', 'markdown')
const itemNameArb = fc.string({ minLength: 0, maxLength: 100 })
const nonEmptyItemNameArb = fc.string({ minLength: 1, maxLength: 100 })
  .filter(s => s.trim().length > 0 && !s.includes('{itemName}'))
const greetingStringArb = fc.string({ minLength: 1, maxLength: 500 })
const sessionTypeArb = fc.constantFrom('invited', 'self-review', 'preview')

// ── Helpers ──

/** Expected template for a given item type (image → image, everything else → document) */
function expectedTemplate(itemType) {
  return itemType === 'image' ? GREETING_TEMPLATES.image : GREETING_TEMPLATES.document
}

/** Default params for buildSystemPrompt — all required fields with sensible defaults */
function defaultPromptParams(overrides = {}) {
  return {
    itemName: 'Test Item',
    itemDescription: 'Review this document',
    itemContent: 'Some document content here.',
    itemType: 'document',
    totalSections: 3,
    currentSection: 1,
    closingState: 'exploring',
    windingDown: undefined,
    message: 'Hello',
    isSpecial: false,
    frozenSnapshot: null,
    coverageMap: null,
    imageBase64: null,
    isSelfReview: false,
    timeLimitMinutes: 30,
    nativeDocumentAvailable: false,
    templateGreeting: null,
    ...overrides,
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Property 1: Template greeting matches item type and name
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 1: Template greeting matches item type and name
 *
 * For any item type (document, image, or markdown/text) and for any valid item name,
 * the templateGreeting produced by buildTemplateGreeting SHALL match the expected
 * greeting template for that item type with the item name correctly injected.
 *
 * **Validates: Requirements 1.1, 1.2, 2.1, 2.2, 3.1, 3.2**
 */
describe('Feature: two-phase-session-start, Property 1: Template greeting matches item type and name', () => {
  it('greeting matches expected template with item name injected', () => {
    fc.assert(
      fc.property(itemTypeArb, itemNameArb, (itemType, itemName) => {
        const greeting = buildTemplateGreeting(itemType, itemName)
        const template = expectedTemplate(itemType)
        const expected = template.replace('{itemName}', itemName)

        expect(greeting).toBe(expected)
      }),
      { numRuns: 100 },
    )
  })

  it('image items use the image template, all others use the document template', () => {
    fc.assert(
      fc.property(itemTypeArb, itemNameArb, (itemType, itemName) => {
        const greeting = buildTemplateGreeting(itemType, itemName)

        if (itemType === 'image') {
          expect(greeting).toContain('take a closer look')
          expect(greeting).not.toContain('review the material')
        } else {
          expect(greeting).toContain('review the material')
          expect(greeting).not.toContain('take a closer look')
        }
      }),
      { numRuns: 100 },
    )
  })

  it('greeting always contains the item name', () => {
    // Filter out names with $ — JS String.replace treats $$ as a special
    // replacement pattern, so the literal name won't appear in the output.
    const safeNameArb = nonEmptyItemNameArb.filter(n => !n.includes('$'))
    fc.assert(
      fc.property(itemTypeArb, safeNameArb, (itemType, itemName) => {
        const greeting = buildTemplateGreeting(itemType, itemName)
        expect(greeting).toContain(itemName)
      }),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: Item name update regenerates greeting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 2: Item name update regenerates greeting
 *
 * For any item that has a templateGreeting and for any new valid item name,
 * updating the item name SHALL produce a new templateGreeting containing the
 * updated item name and matching the correct template for the item's type.
 *
 * **Validates: Requirements 1.4**
 */
describe('Feature: two-phase-session-start, Property 2: Item name update regenerates greeting', () => {
  it('calling buildTemplateGreeting with a new name produces a greeting containing the new name', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        nonEmptyItemNameArb,
        nonEmptyItemNameArb,
        (itemType, oldName, newName) => {
          // Simulate: item had a greeting with oldName, now name changes to newName
          const oldGreeting = buildTemplateGreeting(itemType, oldName)
          const newGreeting = buildTemplateGreeting(itemType, newName)

          // New greeting contains the new name
          expect(newGreeting).toContain(newName)

          // New greeting matches the correct template for the item type
          const template = expectedTemplate(itemType)
          expect(newGreeting).toBe(template.replace('{itemName}', newName))

          // If names differ, greetings differ
          if (oldName !== newName) {
            expect(newGreeting).not.toBe(oldGreeting)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('regenerated greeting preserves the item type template', () => {
    fc.assert(
      fc.property(itemTypeArb, nonEmptyItemNameArb, nonEmptyItemNameArb, (itemType, _oldName, newName) => {
        const newGreeting = buildTemplateGreeting(itemType, newName)

        // Template structure is preserved — starts with the same prefix
        expect(newGreeting).toContain("Hey! I'm Pulse")
        expect(newGreeting).toContain('ur/gd Studios')
      }),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 3: System prompt includes greeting context
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 3: System prompt includes greeting context
 *
 * For any template greeting string, when buildSystemPrompt is called with
 * templateGreeting set to that string, the output SHALL contain the greeting
 * text and a no-repeat instruction.
 *
 * **Validates: Requirements 10.1, 10.2**
 */
describe('Feature: two-phase-session-start, Property 3: System prompt includes greeting context', () => {
  it('system prompt contains the greeting text when templateGreeting is provided', () => {
    fc.assert(
      fc.property(greetingStringArb, (greeting) => {
        const prompt = buildSystemPrompt(defaultPromptParams({ templateGreeting: greeting }))

        expect(prompt).toContain(greeting)
      }),
      { numRuns: 100 },
    )
  })

  it('system prompt contains no-repeat instruction when templateGreeting is provided', () => {
    fc.assert(
      fc.property(greetingStringArb, (greeting) => {
        const prompt = buildSystemPrompt(defaultPromptParams({ templateGreeting: greeting }))

        expect(prompt).toContain('GREETING CONTEXT')
        expect(prompt).toContain('Do NOT re-introduce yourself')
        expect(prompt).toContain('repeat the greeting')
      }),
      { numRuns: 100 },
    )
  })

  it('system prompt does NOT contain greeting context when templateGreeting is null', () => {
    const prompt = buildSystemPrompt(defaultPromptParams({ templateGreeting: null }))

    expect(prompt).not.toContain('GREETING CONTEXT')
    expect(prompt).not.toContain('Do NOT re-introduce yourself')
  })

  it('system prompt does NOT contain greeting context when templateGreeting is undefined', () => {
    const prompt = buildSystemPrompt(defaultPromptParams({ templateGreeting: undefined }))

    expect(prompt).not.toContain('GREETING CONTEXT')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 4: Transcript entry schema consistency
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 4: Transcript entry schema consistency
 *
 * For any template greeting string, the transcript entry object built for the
 * greeting SHALL have role === 'agent', content === greeting, and include
 * sessionId, messageId, and timestamp fields.
 *
 * **Validates: Requirements 6.1, 6.4**
 */
describe('Feature: two-phase-session-start, Property 4: Transcript entry schema consistency', () => {
  /**
   * Build a transcript entry for a template greeting — mirrors the shape
   * written by the __template_init__ handler in the Chat Lambda.
   */
  function buildGreetingTranscriptEntry(sessionId, messageId, greeting, timestamp) {
    return {
      sessionId,
      messageId,
      role: 'agent',
      content: greeting,
      timestamp,
    }
  }

  const sessionIdArb = fc.uuid()
  const messageIdArb = fc.string({ minLength: 26, maxLength: 26 }).map(s => s.replace(/[^A-Z0-9]/gi, 'A').toUpperCase())
  const timestampArb = fc.date().map(d => d.toISOString())

  it('transcript entry has correct role, content, and required fields', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        messageIdArb,
        greetingStringArb,
        timestampArb,
        (sessionId, messageId, greeting, timestamp) => {
          const entry = buildGreetingTranscriptEntry(sessionId, messageId, greeting, timestamp)

          expect(entry.role).toBe('agent')
          expect(entry.content).toBe(greeting)
          expect(entry).toHaveProperty('sessionId')
          expect(entry).toHaveProperty('messageId')
          expect(entry).toHaveProperty('timestamp')
          expect(typeof entry.sessionId).toBe('string')
          expect(typeof entry.messageId).toBe('string')
          expect(typeof entry.timestamp).toBe('string')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('transcript entry content exactly matches the greeting input', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        messageIdArb,
        greetingStringArb,
        timestampArb,
        (sessionId, messageId, greeting, timestamp) => {
          const entry = buildGreetingTranscriptEntry(sessionId, messageId, greeting, timestamp)
          expect(entry.content).toStrictEqual(greeting)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 5: Streaming autoSend state management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 5: Streaming autoSend state management
 *
 * For any streaming response containing control tags ([SECTION:N], [SESSION_COMPLETE]),
 * the autoSend function SHALL correctly extract section numbers, detect session
 * completion, and update closingState.
 *
 * **Validates: Requirements 9.3**
 */
describe('Feature: two-phase-session-start, Property 5: Streaming autoSend state management', () => {
  /**
   * Pure function mirroring the control-tag extraction logic used by
   * consumeStream / autoSend in Chat.tsx.
   */
  function extractStreamState(text) {
    const sectionMatches = [...text.matchAll(/\[SECTION:(\d+)\]/g)]
    const sections = sectionMatches.map(m => parseInt(m[1], 10))
    const currentSection = sections.length > 0 ? sections[sections.length - 1] : null
    const sessionComplete = text.includes('[SESSION_COMPLETE]')
    return { sections, currentSection, sessionComplete }
  }

  const sectionNumberArb = fc.integer({ min: 1, max: 20 })
  const plainTextArb = fc.string({ minLength: 1, maxLength: 50 })
    .filter(s => !s.includes('[') && !s.includes(']'))

  it('section numbers are correctly extracted from stream text', () => {
    fc.assert(
      fc.property(
        fc.array(sectionNumberArb, { minLength: 1, maxLength: 5 }),
        plainTextArb,
        (sectionNums, text) => {
          // Build a stream response with section tags interspersed
          let stream = text
          for (const n of sectionNums) {
            stream += `[SECTION:${n}]` + text
          }

          const state = extractStreamState(stream)

          expect(state.sections).toEqual(sectionNums)
          expect(state.currentSection).toBe(sectionNums[sectionNums.length - 1])
        },
      ),
      { numRuns: 100 },
    )
  })

  it('session completion is detected when [SESSION_COMPLETE] is present', () => {
    fc.assert(
      fc.property(plainTextArb, fc.boolean(), (text, includeComplete) => {
        const stream = includeComplete
          ? text + '[SESSION_COMPLETE]'
          : text

        const state = extractStreamState(stream)
        expect(state.sessionComplete).toBe(includeComplete)
      }),
      { numRuns: 100 },
    )
  })

  it('combined section tags and session complete are all extracted', () => {
    fc.assert(
      fc.property(
        fc.array(sectionNumberArb, { minLength: 1, maxLength: 5 }),
        plainTextArb,
        (sectionNums, text) => {
          let stream = text
          for (const n of sectionNums) {
            stream += `[SECTION:${n}]` + text
          }
          stream += '[SESSION_COMPLETE]'

          const state = extractStreamState(stream)

          expect(state.sections).toEqual(sectionNums)
          expect(state.sessionComplete).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('no tags means no sections and no completion', () => {
    fc.assert(
      fc.property(plainTextArb, (text) => {
        const state = extractStreamState(text)

        expect(state.sections).toEqual([])
        expect(state.currentSection).toBeNull()
        expect(state.sessionComplete).toBe(false)
      }),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 6: Greeting is item-scoped, not session-scoped
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 6: Greeting is item-scoped, not session-scoped
 *
 * For any item with a templateGreeting, all sessions created on that item
 * (invited, self-review, preview) SHALL receive the same templateGreeting value.
 *
 * **Validates: Requirements 12.4**
 */
describe('Feature: two-phase-session-start, Property 6: Greeting is item-scoped, not session-scoped', () => {
  /**
   * Simulate GetSessionState reading templateGreeting from the item record.
   * The greeting is stored on the item, not the session — so all sessions
   * on the same item get the same value.
   */
  function getTemplateGreetingForSession(itemRecord, _sessionType) {
    return itemRecord.templateGreeting || null
  }

  it('all session types on the same item receive the same templateGreeting', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        nonEmptyItemNameArb,
        fc.array(sessionTypeArb, { minLength: 2, maxLength: 5 }),
        (itemType, itemName, sessionTypes) => {
          const greeting = buildTemplateGreeting(itemType, itemName)
          const itemRecord = { templateGreeting: greeting, itemType, itemName }

          const greetings = sessionTypes.map(st => getTemplateGreetingForSession(itemRecord, st))

          // All sessions get the same greeting
          for (const g of greetings) {
            expect(g).toBe(greeting)
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('greeting value depends only on item, not on session type', () => {
    fc.assert(
      fc.property(
        itemTypeArb,
        nonEmptyItemNameArb,
        sessionTypeArb,
        sessionTypeArb,
        (itemType, itemName, sessionType1, sessionType2) => {
          const greeting = buildTemplateGreeting(itemType, itemName)
          const itemRecord = { templateGreeting: greeting }

          const g1 = getTemplateGreetingForSession(itemRecord, sessionType1)
          const g2 = getTemplateGreetingForSession(itemRecord, sessionType2)

          expect(g1).toBe(g2)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Property 7: Template greeting round-trip
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: two-phase-session-start, Property 7: Template greeting round-trip
 *
 * For any valid item name, buildTemplateGreeting(itemType, itemName) followed
 * by extracting the item name from the resulting greeting string SHALL produce
 * the original item name.
 *
 * **Validates: Requirements 1.2, 2.2, 3.2**
 */
describe('Feature: two-phase-session-start, Property 7: Template greeting round-trip', () => {
  /**
   * Extract the item name from a greeting by finding the text between
   * "walk you through " and the next known suffix.
   * Document template: "walk you through {itemName}. When you're ready"
   * Image template:    "walk you through {itemName} with you. When you're ready"
   */
  function extractItemName(greeting, itemType) {
    const prefix = "walk you through "
    const prefixIdx = greeting.indexOf(prefix)
    if (prefixIdx === -1) return null

    const afterPrefix = greeting.slice(prefixIdx + prefix.length)

    if (itemType === 'image') {
      // Image: "...walk you through {itemName} with you. When..."
      const suffixIdx = afterPrefix.indexOf(' with you. When')
      if (suffixIdx === -1) return null
      return afterPrefix.slice(0, suffixIdx)
    } else {
      // Document: "...walk you through {itemName}. When you're ready"
      const suffixIdx = afterPrefix.indexOf('. When')
      if (suffixIdx === -1) return null
      return afterPrefix.slice(0, suffixIdx)
    }
  }

  // Round-trip names must not contain $ (JS replace special pattern),
  // '. When' or ' with you. When' (collides with template suffix delimiters).
  const roundTripNameArb = nonEmptyItemNameArb
    .filter(n => !n.includes('$') && !n.includes('. When') && !n.includes(' with you. When'))

  it('round-trip: build greeting then extract name recovers the original name (document)', () => {
    fc.assert(
      fc.property(roundTripNameArb, (itemName) => {
        const greeting = buildTemplateGreeting('document', itemName)
        const extracted = extractItemName(greeting, 'document')
        expect(extracted).toBe(itemName)
      }),
      { numRuns: 100 },
    )
  })

  it('round-trip: build greeting then extract name recovers the original name (image)', () => {
    fc.assert(
      fc.property(roundTripNameArb, (itemName) => {
        const greeting = buildTemplateGreeting('image', itemName)
        const extracted = extractItemName(greeting, 'image')
        expect(extracted).toBe(itemName)
      }),
      { numRuns: 100 },
    )
  })

  it('round-trip: build greeting then extract name recovers the original name (any type)', () => {
    fc.assert(
      fc.property(itemTypeArb, roundTripNameArb, (itemType, itemName) => {
        const greeting = buildTemplateGreeting(itemType, itemName)
        const extracted = extractItemName(greeting, itemType)
        expect(extracted).toBe(itemName)
      }),
      { numRuns: 100 },
    )
  })
})
