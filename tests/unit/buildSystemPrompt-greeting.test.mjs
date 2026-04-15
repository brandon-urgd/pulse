// Unit tests for buildSystemPrompt — templateGreeting parameter
// Validates: Requirements 10.1, 10.2
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
    templateGreeting: null,
    ...overrides,
  }
}

describe('buildSystemPrompt — templateGreeting', () => {
  describe('greeting context block included when templateGreeting is provided (R10.1)', () => {
    it('includes the greeting text in the system prompt', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide built by ur/gd Studios. I'm here to walk you through Test Document."
      const prompt = buildSystemPrompt(baseParams({ templateGreeting: greeting }))

      expect(prompt).toContain(greeting)
      expect(prompt).toContain('GREETING CONTEXT')
    })
  })

  describe('greeting context block absent when templateGreeting is null/undefined (R10.1)', () => {
    it('does not include GREETING CONTEXT when templateGreeting is null', async () => {
      const prompt = buildSystemPrompt(baseParams({ templateGreeting: null }))
      expect(prompt).not.toContain('GREETING CONTEXT')
    })

    it('does not include GREETING CONTEXT when templateGreeting is undefined', async () => {
      const prompt = buildSystemPrompt(baseParams({ templateGreeting: undefined }))
      expect(prompt).not.toContain('GREETING CONTEXT')
    })

    it('does not include GREETING CONTEXT when templateGreeting is empty string', async () => {
      const prompt = buildSystemPrompt(baseParams({ templateGreeting: '' }))
      expect(prompt).not.toContain('GREETING CONTEXT')
    })
  })

  describe('no-repeat instruction present in greeting context block (R10.2)', () => {
    it('instructs the model not to re-introduce or repeat the greeting', async () => {
      const greeting = "Hey! I'm Pulse — an AI feedback guide."
      const prompt = buildSystemPrompt(baseParams({ templateGreeting: greeting }))

      expect(prompt).toContain('Do NOT re-introduce yourself')
      expect(prompt).toContain('repeat the greeting')
    })
  })
})
