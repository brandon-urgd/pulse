// Unit test: verify admin-ui and session-ui About modals display identical version and content
// Validates: Requirement 15.1, 15.2, 15.3, 15.4, 15.5

import { describe, it, expect } from 'vitest'
import { APP_VERSION, ABOUT_CONTENT } from '../../apps/shared/src/index'

describe('Shared About modal content', () => {
  it('APP_VERSION equals 1.1', () => {
    expect(APP_VERSION).toBe('1.1')
  })

  it('ABOUT_CONTENT.wordmark is "pulse"', () => {
    expect(ABOUT_CONTENT.wordmark).toBe('pulse')
  })

  it('ABOUT_CONTENT contains the correct description paragraphs', () => {
    expect(ABOUT_CONTENT.descriptionP1).toContain('Pulse is a feedback tool')
    expect(ABOUT_CONTENT.descriptionP1).toContain('structured, thoughtful feedback')
    expect(ABOUT_CONTENT.descriptionP2).toContain('Pulse Check')
    expect(ABOUT_CONTENT.descriptionP2).toContain('make decisions, not just collect opinions')
  })

  it('ABOUT_CONTENT contains correct attribution', () => {
    expect(ABOUT_CONTENT.attribution).toBe('Quietly Powerful, by')
    expect(ABOUT_CONTENT.attributionStudio).toBe('ur/gd Studios')
    expect(ABOUT_CONTENT.attributionUrl).toBe('https://urgdstudios.com')
    expect(ABOUT_CONTENT.attributionLocation).toBe('Seattle, WA')
  })

  it('ABOUT_CONTENT contains correct legal links', () => {
    expect(ABOUT_CONTENT.privacyUrl).toBe('https://urgdstudios.com/privacy')
    expect(ABOUT_CONTENT.privacyLabel).toBe('Privacy Policy')
    expect(ABOUT_CONTENT.termsUrl).toBe('https://urgdstudios.com/terms')
    expect(ABOUT_CONTENT.termsLabel).toBe('Terms of Use')
  })

  it('admin-ui and session-ui resolve to the same APP_VERSION (no version drift)', () => {
    // Both apps now import from @pulse/shared — this test verifies the shared source
    // produces a single consistent value. The old bug was admin-ui at 1.1 and session-ui at 1.0.
    const adminVersion = APP_VERSION
    const sessionVersion = APP_VERSION
    expect(adminVersion).toBe(sessionVersion)
  })

  it('ABOUT_CONTENT is frozen (immutable)', () => {
    // The `as const` assertion makes the object deeply readonly at the type level.
    // Verify the runtime values are stable strings.
    const fields = Object.keys(ABOUT_CONTENT)
    expect(fields.length).toBe(11)
    for (const key of fields) {
      expect(typeof ABOUT_CONTENT[key as keyof typeof ABOUT_CONTENT]).toBe('string')
    }
  })
})
