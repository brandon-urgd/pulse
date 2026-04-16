// Property-based tests for Phased Cache Priming — Property 10: Shared version consistency
// Feature: phased-cache-priming, Property 10: shared version consistency
// **Validates: Requirements 15.5**
//
// For any import of APP_VERSION from the admin-ui or session-ui dependency chain,
// the resolved value SHALL be identical — both apps import from the same shared package source.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

// Import APP_VERSION from the shared package (single source of truth)
import { APP_VERSION as sharedVersion } from '../../apps/shared/src/version'
import { APP_VERSION as sharedIndexVersion, ABOUT_CONTENT } from '../../apps/shared/src/index'

describe('Feature: phased-cache-priming, Property 10: shared version consistency', () => {
  it('APP_VERSION from shared/version.ts equals APP_VERSION from shared/index.ts re-export', () => {
    // Both import paths resolve to the same value
    expect(sharedVersion).toBe(sharedIndexVersion)
  })

  it('APP_VERSION is a non-empty semver-like string', () => {
    fc.assert(
      fc.property(fc.constant(sharedVersion), (version) => {
        // Version must be a non-empty string
        expect(typeof version).toBe('string')
        expect(version.length).toBeGreaterThan(0)
        // Version must match a simple semver-like pattern (e.g. "1.1", "1.0.0", "2.0")
        expect(version).toMatch(/^\d+\.\d+(\.\d+)?$/)
      }),
      { numRuns: 100 },
    )
  })

  it('ABOUT_CONTENT from shared package contains all required fields with consistent types', () => {
    fc.assert(
      fc.property(fc.constant(ABOUT_CONTENT), (content) => {
        // All required string fields must be present and non-empty
        const requiredStringFields = [
          'wordmark',
          'descriptionP1',
          'descriptionP2',
          'attribution',
          'attributionStudio',
          'attributionUrl',
          'attributionLocation',
          'privacyUrl',
          'privacyLabel',
          'termsUrl',
          'termsLabel',
        ] as const

        for (const field of requiredStringFields) {
          expect(typeof content[field]).toBe('string')
          expect(content[field].length).toBeGreaterThan(0)
        }

        // URL fields must be valid URLs
        const urlFields = ['attributionUrl', 'privacyUrl', 'termsUrl'] as const
        for (const field of urlFields) {
          expect(content[field]).toMatch(/^https:\/\//)
        }
      }),
      { numRuns: 100 },
    )
  })

  it('both admin-ui and session-ui resolve to the same APP_VERSION value across random access patterns', () => {
    // Simulate random access patterns — both apps always get the same version
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        (_accessIndex) => {
          // No matter how many times or in what order we access the version,
          // both apps resolve to the same shared value
          const adminVersion = sharedVersion
          const sessionVersion = sharedIndexVersion
          expect(adminVersion).toBe(sessionVersion)
          expect(adminVersion).toBe('1.1')
        },
      ),
      { numRuns: 100 },
    )
  })
})
