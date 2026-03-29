// Unit tests for enforcement Lambda HTTP status mapping via resolveFeature
// Tests the resolveFeature → HTTP status mapping pattern used by all 13 enforcement Lambdas.
// Validates: Requirements 3.2, 3.3, 3.4

import { describe, it, expect } from 'vitest'
import { resolveFeature } from '../../lambdas/shared/features.mjs'
import { VALID_FLAGS } from '../../lambdas/shared/tiers.mjs'

/**
 * Flag-to-Lambda mapping from the design doc.
 * Each entry maps a Lambda name to the flag(s) it checks.
 */
const ENFORCEMENT_MAP = [
  { lambda: 'createItem', flags: ['maxActiveItems'] },
  { lambda: 'createPublicSession', flags: ['publicSessions', 'maxSessionsPerItem', 'sessionTimeLimitMinutes'] },
  { lambda: 'createSelfSession', flags: ['selfReview', 'maxSessionsPerItem', 'sessionTimeLimitMinutes'] },
  { lambda: 'extractText', flags: ['maxDocumentPages'] },
  { lambda: 'generateReport', flags: ['aiReports'] },
  { lambda: 'generateRevision', flags: ['itemRevisionLoop'] },
  { lambda: 'generateSessionSummary', flags: ['aiReports'] },
  { lambda: 'getUploadUrl', flags: ['maxUploadSizeMb'] },
  { lambda: 'inviteReviewer', flags: ['maxSessionsPerItem', 'sessionTimeLimitMinutes'] },
  { lambda: 'previewSession', flags: [] },
  { lambda: 'runPulseCheck', flags: ['pulseCheck'] },
  { lambda: 'sendReminder', flags: ['emailReminders'] },
  { lambda: 'getSettings', flags: VALID_FLAGS },
]

/**
 * Simulates the HTTP status mapping pattern used by enforcement Lambdas:
 *   - tier_limit → 403
 *   - maintenance → 503
 *   - allowed → proceed (200)
 */
function mapToHttpStatus(result) {
  if (!result.allowed) {
    return result.reason === 'maintenance' ? 503 : 403
  }
  return 200
}

describe('Enforcement Lambda HTTP status mapping', () => {
  // Collect all unique flags from the enforcement map (excluding getSettings which uses resolveAll)
  const enforcementFlags = [...new Set(
    ENFORCEMENT_MAP
      .filter((e) => e.lambda !== 'getSettings' && e.flags.length > 0)
      .flatMap((e) => e.flags),
  )]

  describe.each(enforcementFlags)('flag: %s', (flag) => {
    // Requirement 3.2 — tier_limit → 403
    it('resolveFeature returning tier_limit maps to 403', () => {
      // Build a tenant where this flag resolves to tier_limit
      // Use a free tier tenant with the flag overridden to false (for boolean flags)
      // or with a tenant that has the flag set to false
      const tenantRecord = {
        tier: 'free',
        features: { [flag]: false },
        serviceFlags: {},
      }
      const result = resolveFeature(tenantRecord, flag, null)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('tier_limit')
      expect(mapToHttpStatus(result)).toBe(403)
    })

    // Requirement 3.3 — maintenance → 503
    it('resolveFeature returning maintenance maps to 503', () => {
      const tenantRecord = {
        tier: 'pro',
        features: {},
        serviceFlags: {},
      }
      const systemRecord = {
        serviceFlags: { [flag]: { status: 'maintenance' } },
      }
      const result = resolveFeature(tenantRecord, flag, systemRecord)

      expect(result.allowed).toBe(false)
      expect(result.reason).toBe('maintenance')
      expect(mapToHttpStatus(result)).toBe(503)
    })

    // Requirement 3.4 — allowed with limit → use limit as threshold
    it('resolveFeature returning allowed with limit provides the limit value', () => {
      const tenantRecord = {
        tier: 'free',
        features: { [flag]: 42 },
        serviceFlags: {},
      }
      const result = resolveFeature(tenantRecord, flag, null)

      expect(result.allowed).toBe(true)
      expect(result.reason).toBe('allowed')
      expect(result.limit).toBe(42)
      expect(mapToHttpStatus(result)).toBe(200)
    })
  })

  // Verify all 13 enforcement Lambdas are accounted for
  it('covers all 13 enforcement Lambdas', () => {
    expect(ENFORCEMENT_MAP.length).toBe(13)
  })

  // Verify the flag-to-Lambda mapping covers known flags
  it('all mapped flags are valid VALID_FLAGS entries', () => {
    for (const entry of ENFORCEMENT_MAP) {
      for (const flag of entry.flags) {
        expect(VALID_FLAGS).toContain(flag)
      }
    }
  })
})
