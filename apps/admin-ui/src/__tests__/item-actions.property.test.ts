/**
 * Property 9: getItemActions returns correct actions for any item state
 * Property 10: Maximum two primary actions per item state
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { getItemActions, type ItemActionInput } from '../utils/itemActions'

// --- Generators ---

const statusArb = fc.constantFrom<ItemActionInput['status']>('draft', 'active', 'closed', 'revised')

const itemArb: fc.Arbitrary<ItemActionInput> = fc.record({
  status: statusArb,
  hasPulseCheck: fc.boolean(),
  hasCompletedRevision: fc.boolean(),
})

// --- Property 9 ---

describe('Feature: async-revision-generation, Property 9: getItemActions correctness', () => {
  /**
   * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5
   *
   * For any item with a valid status, hasPulseCheck, and hasCompletedRevision,
   * getItemActions returns the correct action array per the specification.
   */

  it('returns correct actions for every valid item state combination', () => {
    fc.assert(
      fc.property(itemArb, (item) => {
        const actions = getItemActions(item)

        if (item.status === 'draft' || item.status === 'active') {
          expect(actions).toEqual(['getFeedback'])
          return
        }

        if (item.status === 'revised') {
          expect(actions).toEqual(['pulseCheck', 'revisions'])
          return
        }

        if (item.status === 'closed') {
          if (item.hasPulseCheck && item.hasCompletedRevision) {
            expect(actions).toEqual(['pulseCheck', 'revisions'])
          } else if (item.hasPulseCheck) {
            expect(actions).toEqual(['pulseCheck'])
          } else {
            expect(actions).toEqual(['runPulseCheck'])
          }
          return
        }

        // Unknown status — should return empty
        expect(actions).toEqual([])
      }),
      { numRuns: 200 }
    )
  })

  it('draft items always get getFeedback only (Req 12.1)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasPulseCheck, hasCompletedRevision) => {
        const actions = getItemActions({ status: 'draft', hasPulseCheck, hasCompletedRevision })
        expect(actions).toEqual(['getFeedback'])
        expect(actions).not.toContain('pulseCheck')
        expect(actions).not.toContain('revisions')
      }),
      { numRuns: 100 }
    )
  })

  it('active items always get getFeedback only (Req 12.1)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasPulseCheck, hasCompletedRevision) => {
        const actions = getItemActions({ status: 'active', hasPulseCheck, hasCompletedRevision })
        expect(actions).toEqual(['getFeedback'])
        expect(actions).not.toContain('pulseCheck')
        expect(actions).not.toContain('revisions')
      }),
      { numRuns: 100 }
    )
  })

  it('revised items always get pulseCheck and revisions (Req 12.5)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasPulseCheck, hasCompletedRevision) => {
        const actions = getItemActions({ status: 'revised', hasPulseCheck, hasCompletedRevision })
        expect(actions).toEqual(['pulseCheck', 'revisions'])
        expect(actions).not.toContain('getFeedback')
      }),
      { numRuns: 100 }
    )
  })

  it('closed items with hasPulseCheck and hasCompletedRevision get pulseCheck + revisions (Req 12.2)', () => {
    const actions = getItemActions({ status: 'closed', hasPulseCheck: true, hasCompletedRevision: true })
    expect(actions).toEqual(['pulseCheck', 'revisions'])
    expect(actions).not.toContain('getFeedback')
  })

  it('closed items with hasPulseCheck but no completed revision get pulseCheck only (Req 12.3)', () => {
    const actions = getItemActions({ status: 'closed', hasPulseCheck: true, hasCompletedRevision: false })
    expect(actions).toEqual(['pulseCheck'])
    expect(actions).not.toContain('revisions')
    expect(actions).not.toContain('getFeedback')
  })

  it('closed items without hasPulseCheck get runPulseCheck only (Req 12.4)', () => {
    fc.assert(
      fc.property(fc.boolean(), (hasCompletedRevision) => {
        const actions = getItemActions({ status: 'closed', hasPulseCheck: false, hasCompletedRevision })
        expect(actions).toEqual(['runPulseCheck'])
        expect(actions).not.toContain('getFeedback')
        expect(actions).not.toContain('revisions')
        expect(actions).not.toContain('pulseCheck')
      }),
      { numRuns: 100 }
    )
  })
})

// --- Property 10 ---

describe('Feature: async-revision-generation, Property 10: Max two actions', () => {
  /**
   * Validates: Requirements 12.6
   *
   * For any valid combination of item state fields,
   * getItemActions returns at most 2 actions.
   */

  it('never returns more than 2 actions for any item state', () => {
    fc.assert(
      fc.property(itemArb, (item) => {
        const actions = getItemActions(item)
        expect(actions.length).toBeLessThanOrEqual(2)
      }),
      { numRuns: 200 }
    )
  })

  it('action count is at most 2 even with exhaustive status combinations', () => {
    const statuses: ItemActionInput['status'][] = ['draft', 'active', 'closed', 'revised']
    const booleans = [true, false]

    for (const status of statuses) {
      for (const hasPulseCheck of booleans) {
        for (const hasCompletedRevision of booleans) {
          const actions = getItemActions({ status, hasPulseCheck, hasCompletedRevision })
          expect(actions.length).toBeLessThanOrEqual(2)
        }
      }
    }
  })
})
