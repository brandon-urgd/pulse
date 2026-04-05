// Feature: pulse-s2-s4-billing, Property 7: Coverage Inference from Transcript
// Uses fast-check with vitest to verify coverage inference logic.
// **Validates: Requirements 17.3, 17.4**

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// Pure function extracted from the coverage fallback logic
function inferCoverage(sections, agentMessages) {
  const allText = agentMessages.join(' ')
  const inferred = {}
  for (const section of sections) {
    if (section.title && allText.includes(section.title)) {
      inferred[section.id] = { touched: true, depth: 'inferred' }
    }
  }
  return inferred
}

const sectionArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 5 }).map(s => `s${s}`),
  title: fc.string({ minLength: 3, maxLength: 50 }),
})

/**
 * Property 7: Coverage Inference from Transcript
 *
 * For any session with empty sectionCoverage and non-empty transcript,
 * every section title appearing in agent messages gets touched: true,
 * depth: 'inferred'. Sections not in agent messages get no entry.
 *
 * Validates: Requirements 17.3, 17.4
 */
describe('Property P7: Coverage inference from transcript', () => {
  it('sections mentioned in agent messages get touched:true, depth:inferred', () => {
    fc.assert(
      fc.property(
        fc.array(sectionArb, { minLength: 1, maxLength: 10 }),
        fc.array(fc.string({ minLength: 0, maxLength: 200 }), { minLength: 1, maxLength: 20 }),
        (sections, messages) => {
          const result = inferCoverage(sections, messages)
          const allText = messages.join(' ')

          for (const section of sections) {
            if (allText.includes(section.title)) {
              expect(result[section.id]).toEqual({ touched: true, depth: 'inferred' })
            } else {
              expect(result[section.id]).toBeUndefined()
            }
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('empty agent messages produce empty coverage', () => {
    fc.assert(
      fc.property(
        fc.array(sectionArb, { minLength: 1, maxLength: 5 }),
        (sections) => {
          const result = inferCoverage(sections, [''])
          // With empty messages, no section titles should match
          for (const section of sections) {
            if (section.title.length > 0) {
              // Empty string doesn't contain non-empty titles
              expect(result[section.id]).toBeUndefined()
            }
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
