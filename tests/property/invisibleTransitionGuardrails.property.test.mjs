// Property-based tests for Phased Cache Priming — Property 5: Invisible transition guardrails
// Feature: phased-cache-priming, Property 5: invisible transition guardrails in system prompt
// **Validates: Requirements 3.5, 10.1, 10.2, 10.4**
//
// For any system prompt built by buildSystemPrompt (regardless of phase), the prompt SHALL
// contain explicit guardrails preventing the model from revealing phased context loading —
// specifically, the prompt SHALL NOT contain language encouraging the model to say "I haven't
// seen the document yet" or "I can now see the formatting," and SHALL contain language
// instructing the model to never reveal the progressive loading.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

const { buildSystemPrompt } = await import('../../lambdas/shared/buildSystemPrompt.mjs')

// ── Generators ──

const itemNameArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0)
const itemDescriptionArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
  fc.constant(''),
  fc.constant(undefined),
)
const itemContentArb = fc.oneof(
  fc.string({ minLength: 10, maxLength: 500 }).filter(s => s.trim().length > 0),
  fc.constant(''),
  fc.constant(undefined),
)
const itemTypeArb = fc.constantFrom('document', 'image')
const nativeDocAvailableArb = fc.boolean()
const totalSectionsArb = fc.integer({ min: 1, max: 10 })
const currentSectionArb = fc.integer({ min: 1, max: 10 })
const closingStateArb = fc.constantFrom('exploring', 'narrowing', 'closing', 'closed')
const isSelfReviewArb = fc.boolean()
const timeLimitArb = fc.integer({ min: 5, max: 60 })
const messageArb = fc.constantFrom('__session_start__', '__session_resume__', '__session_end__', 'Hello', 'What do you think?')

/** Build a minimal valid params object for buildSystemPrompt */
function makePromptParams(overrides = {}) {
  return {
    itemName: 'Test Document',
    itemDescription: 'Review this document.',
    itemContent: '# Sample extracted text\n\nThis is the body of the document.',
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
    ...overrides,
  }
}

// Phrases that would reveal phased loading — the prompt should instruct the model to NEVER say these
const REVEALING_ENCOURAGEMENTS = [
  // The prompt should not encourage the model to say these things
  'tell the reviewer you haven\'t seen the document',
  'let them know you can now see',
  'inform the reviewer that you now have access',
  'explain that you previously only had text',
]

// ═══════════════════════════════════════════════════════════════════════════
// Feature: phased-cache-priming
// Property 5: Invisible transition guardrails in system prompt
// **Validates: Requirements 3.5, 10.1, 10.2, 10.4**
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: phased-cache-priming, Property 5: invisible transition guardrails in system prompt', () => {

  it('all system prompts contain guardrails against revealing progressive loading', () => {
    // **Validates: Requirements 10.1, 10.2**
    fc.assert(
      fc.property(
        itemNameArb,
        itemDescriptionArb,
        itemContentArb,
        itemTypeArb,
        nativeDocAvailableArb,
        totalSectionsArb,
        currentSectionArb,
        closingStateArb,
        isSelfReviewArb,
        timeLimitArb,
        messageArb,
        (itemName, itemDescription, itemContent, itemType, nativeDocumentAvailable, totalSections, currentSection, closingState, isSelfReview, timeLimitMinutes, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemDescription,
            itemContent,
            itemType,
            totalSections,
            currentSection: Math.min(currentSection, totalSections),
            closingState,
            isSelfReview,
            timeLimitMinutes,
            message,
            nativeDocumentAvailable,
          }))

          // The prompt MUST contain the invisible transition guardrail
          expect(prompt).toContain('Never say "I haven\'t seen the document yet,"')
          expect(prompt).toContain('reveals progressive context loading')
          expect(prompt).toContain('continuous and natural at all times')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('all system prompts contain natural conversation progression framing', () => {
    // **Validates: Requirements 10.2**
    fc.assert(
      fc.property(
        itemTypeArb,
        nativeDocAvailableArb,
        isSelfReviewArb,
        messageArb,
        (itemType, nativeDocumentAvailable, isSelfReview, message) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemType,
            nativeDocumentAvailable,
            isSelfReview,
            message,
          }))

          // The prompt MUST frame the progression as natural conversation
          expect(prompt).toContain('Early turns naturally focus on content and messaging')
          expect(prompt).toContain('normal conversation progression, not a system transition')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('no system prompt contains language encouraging the model to reveal phased loading', () => {
    // **Validates: Requirements 3.5, 10.1**
    fc.assert(
      fc.property(
        itemTypeArb,
        nativeDocAvailableArb,
        itemContentArb,
        isSelfReviewArb,
        (itemType, nativeDocumentAvailable, itemContent, isSelfReview) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemType,
            nativeDocumentAvailable,
            itemContent,
            isSelfReview,
          }))

          const lowerPrompt = prompt.toLowerCase()

          // The prompt should NOT contain language that encourages revealing the phased loading
          for (const phrase of REVEALING_ENCOURAGEMENTS) {
            expect(lowerPrompt).not.toContain(phrase.toLowerCase())
          }

          // The prompt should NOT instruct the model to acknowledge a transition
          expect(lowerPrompt).not.toContain('acknowledge the transition')
          expect(lowerPrompt).not.toContain('let the reviewer know that you now')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('guardrails are present in the BEHAVIORAL GUARDRAILS section (top of prompt)', () => {
    // **Validates: Requirements 10.1**
    fc.assert(
      fc.property(
        itemTypeArb,
        nativeDocAvailableArb,
        (itemType, nativeDocumentAvailable) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemType,
            nativeDocumentAvailable,
          }))

          // The guardrails section should be at the top
          const guardrailsStart = prompt.indexOf('BEHAVIORAL GUARDRAILS')
          expect(guardrailsStart).toBe(0)

          // The invisible transition guardrail should be within the guardrails section
          // (before the agent identity section)
          const agentIdentityIdx = prompt.indexOf('You are Pulse')
          const transitionGuardrailIdx = prompt.indexOf('reveals progressive context loading')

          expect(transitionGuardrailIdx).toBeGreaterThan(guardrailsStart)
          expect(transitionGuardrailIdx).toBeLessThan(agentIdentityIdx)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('text-only phase prompts contain visual redirect instructions (turns 1-2 guardrail)', () => {
    // **Validates: Requirements 10.4**
    fc.assert(
      fc.property(
        itemNameArb,
        fc.string({ minLength: 10, maxLength: 300 }).filter(s => s.trim().length > 0),
        (itemName, itemContent) => {
          const prompt = buildSystemPrompt(makePromptParams({
            itemName,
            itemContent,
            itemType: 'document',
            nativeDocumentAvailable: false,
          }))

          // When in text-only phase, the prompt should redirect visual questions
          expect(prompt).toContain('redirect to content-level observations')
          expect(prompt).toContain('what the text says rather than how it looks')
        },
      ),
      { numRuns: 100 },
    )
  })
})
