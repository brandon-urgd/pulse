// Property-based tests for verdict validation and sentiment color mapping
// Properties P3, P4

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Verdict validation logic mirroring ProcessPulseCheck Lambda ──
const VALID_VERDICTS = [
  'Strong consensus — move forward',
  'Mixed perspectives — review the gaps',
  'Not enough to go on — gather more input',
]
const NEUTRAL_FALLBACK = 'Mixed perspectives — review the gaps'

function validateVerdict(input) {
  return VALID_VERDICTS.includes(input) ? input : NEUTRAL_FALLBACK
}

// ── Sentiment color mapping logic mirroring PulseCheck.tsx ──
function getVerdictSentimentClass(verdict) {
  const v = verdict.toLowerCase()
  const isPositive = v.includes('strong consensus') || v.includes('move forward')
  const isNegative = v.includes('not enough') || v.includes('gather more')
  if (isNegative) return 'verdictBlockNegative'
  if (isPositive) return 'verdictBlockPositive'
  return 'verdictBlockNeutral'
}

/**
 * Feature: pulse-check-polish, Property 3: Verdict validation always returns an approved label
 *
 * For any string input, the verdict validation function SHALL return a value from the
 * approved verdict label set. When the input matches an approved label, it SHALL return
 * the input unchanged. When the input does not match, it SHALL return the neutral fallback.
 *
 * Validates: Requirements 4.2
 */
describe('Feature: pulse-check-polish, Property 3: Verdict validation always returns an approved label', () => {
  it('for any random string, validateVerdict always returns a value from VALID_VERDICTS', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }),
        (input) => {
          const result = validateVerdict(input)
          expect(VALID_VERDICTS).toContain(result)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any approved label, validateVerdict returns it unchanged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_VERDICTS),
        (approvedLabel) => {
          const result = validateVerdict(approvedLabel)
          expect(result).toBe(approvedLabel)
        },
      ),
      { numRuns: 100 },
    )
  })

  it('for any string NOT in the approved set, validateVerdict returns the neutral fallback', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }).filter(s => !VALID_VERDICTS.includes(s)),
        (nonApproved) => {
          const result = validateVerdict(nonApproved)
          expect(result).toBe(NEUTRAL_FALLBACK)
        },
      ),
      { numRuns: 100 },
    )
  })
})


/**
 * Feature: pulse-check-polish, Property 4: Verdict sentiment color mapping
 *
 * For any verdict string from the approved label set, the sentiment mapping function SHALL
 * return the correct CSS class: positive class for "Strong consensus — move forward",
 * negative class for "Not enough to go on — gather more input", and neutral class for
 * "Mixed perspectives — review the gaps". For any string not in the approved set, it SHALL
 * return the neutral class.
 *
 * Validates: Requirements 4.3, 4.4
 */
describe('Feature: pulse-check-polish, Property 4: Verdict sentiment color mapping', () => {
  it('"Strong consensus — move forward" → verdictBlockPositive', () => {
    const result = getVerdictSentimentClass('Strong consensus — move forward')
    expect(result).toBe('verdictBlockPositive')
  })

  it('"Not enough to go on — gather more input" → verdictBlockNegative', () => {
    const result = getVerdictSentimentClass('Not enough to go on — gather more input')
    expect(result).toBe('verdictBlockNegative')
  })

  it('"Mixed perspectives — review the gaps" → verdictBlockNeutral', () => {
    const result = getVerdictSentimentClass('Mixed perspectives — review the gaps')
    expect(result).toBe('verdictBlockNeutral')
  })

  it('for any random string not containing sentiment keywords, returns verdictBlockNeutral', () => {
    // Generate strings that don't contain any of the sentiment trigger phrases
    const neutralStringArb = fc.string({ minLength: 0, maxLength: 100 }).filter(s => {
      const lower = s.toLowerCase()
      return (
        !lower.includes('strong consensus') &&
        !lower.includes('move forward') &&
        !lower.includes('not enough') &&
        !lower.includes('gather more')
      )
    })

    fc.assert(
      fc.property(
        neutralStringArb,
        (input) => {
          const result = getVerdictSentimentClass(input)
          expect(result).toBe('verdictBlockNeutral')
        },
      ),
      { numRuns: 100 },
    )
  })

  it('approved verdicts always map to their expected sentiment class', () => {
    const verdictToClass = {
      'Strong consensus — move forward': 'verdictBlockPositive',
      'Mixed perspectives — review the gaps': 'verdictBlockNeutral',
      'Not enough to go on — gather more input': 'verdictBlockNegative',
    }

    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(verdictToClass)),
        (verdict) => {
          const result = getVerdictSentimentClass(verdict)
          expect(result).toBe(verdictToClass[verdict])
        },
      ),
      { numRuns: 100 },
    )
  })
})
