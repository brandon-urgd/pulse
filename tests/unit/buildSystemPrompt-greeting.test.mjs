// Unit tests for buildSystemPrompt — templateGreeting parameter removed
// Validates: Requirement 13.3 (Phased Cache Priming — template greeting infrastructure removal)
// Updated: templateGreeting parameter and GREETING CONTEXT section have been removed.
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../lambdas/shared/buildSystemPrompt.mjs'

/** Minimal params to call buildSystemPrompt without errors */
function baseParams(overrides = {}) {
  return {
    itemName: 'Test Document',
    itemDescription: '',
    itemContent: 'Some content here.',
    itemType: 'document',
    totalSections: 3,
    currentSection: 1,
    closingState: 'exploring',
    windingDown: false,
    message: 'Hello',
    isSpecial: false,
    frozenSnapshot: null,
    coverageMap: null,
    imageBase64: null,
    isSelfReview: false,
    timeLimitMinutes: 17,
    nativeDocumentAvailable: false,
    ...overrides,
  }
}

describe('buildSystemPrompt — templateGreeting removed (R13.3)', () => {
  describe('GREETING CONTEXT section is no longer present', () => {
    it('does not include GREETING CONTEXT even if templateGreeting is passed as extra param', () => {
      // templateGreeting is no longer in the function signature, but passing it
      // as an extra property in the destructured object should be harmless and ignored.
      const prompt = buildSystemPrompt({
        ...baseParams(),
        templateGreeting: "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios.",
      })

      expect(prompt).not.toContain('GREETING CONTEXT')
      expect(prompt).not.toContain('You already delivered the following greeting')
    })

    it('does not include GREETING CONTEXT when no templateGreeting is provided', () => {
      const prompt = buildSystemPrompt(baseParams())
      expect(prompt).not.toContain('GREETING CONTEXT')
    })
  })

  describe('system prompt still builds correctly without templateGreeting', () => {
    it('contains behavioral guardrails and item context', () => {
      const prompt = buildSystemPrompt(baseParams())
      expect(prompt).toContain('BEHAVIORAL GUARDRAILS')
      expect(prompt).toContain('Test Document')
      expect(prompt).toContain('Some content here.')
    })

    it('contains invisible transition guardrails', () => {
      const prompt = buildSystemPrompt(baseParams())
      expect(prompt).toContain('Never say "I haven\'t seen the document yet,"')
      expect(prompt).toContain('progressive context loading')
    })
  })
})
