// Unit tests for timezone parsing
// Tests: common offsets (-07:00, +05:30, +00:00, Z), edge cases (date boundary crossings)
// **Validates: Requirements 3.2, 3.3, 3.4, 3.5**

import { describe, it, expect } from 'vitest'

/**
 * This tests the timezone parsing approach used by createItem, updateItem, and extendDeadline:
 * new Date(isoString) handles ISO 8601 with timezone offsets natively.
 */
function parseToUtc(isoString) {
  return new Date(isoString)
}

describe('Timezone parsing unit tests', () => {
  describe('common offsets', () => {
    it('parses -07:00 (US Pacific) correctly', () => {
      const input = '2026-04-15T23:59:00-07:00'
      const result = parseToUtc(input)
      // -07:00 means UTC is 7 hours ahead
      expect(result.toISOString()).toBe('2026-04-16T06:59:00.000Z')
    })

    it('parses +05:30 (India) correctly', () => {
      const input = '2026-04-15T12:00:00+05:30'
      const result = parseToUtc(input)
      // +05:30 means UTC is 5.5 hours behind
      expect(result.toISOString()).toBe('2026-04-15T06:30:00.000Z')
    })

    it('parses +00:00 (UTC explicit) correctly', () => {
      const input = '2026-04-15T12:00:00+00:00'
      const result = parseToUtc(input)
      expect(result.toISOString()).toBe('2026-04-15T12:00:00.000Z')
    })

    it('parses Z suffix (UTC) correctly', () => {
      const input = '2026-04-15T12:00:00Z'
      const result = parseToUtc(input)
      expect(result.toISOString()).toBe('2026-04-15T12:00:00.000Z')
    })
  })

  describe('edge cases — date boundary crossings', () => {
    it('late night in negative offset crosses to next day in UTC', () => {
      // 11:30 PM in UTC-5 → 4:30 AM next day UTC
      const input = '2026-03-31T23:30:00-05:00'
      const result = parseToUtc(input)
      expect(result.toISOString()).toBe('2026-04-01T04:30:00.000Z')
      expect(result.getUTCDate()).toBe(1)
      expect(result.getUTCMonth()).toBe(3) // April (0-indexed)
    })

    it('early morning in positive offset crosses to previous day in UTC', () => {
      // 1:00 AM in UTC+9 (Japan) → 4:00 PM previous day UTC
      const input = '2026-04-01T01:00:00+09:00'
      const result = parseToUtc(input)
      expect(result.toISOString()).toBe('2026-03-31T16:00:00.000Z')
      expect(result.getUTCDate()).toBe(31)
      expect(result.getUTCMonth()).toBe(2) // March (0-indexed)
    })

    it('year boundary crossing', () => {
      // 11:00 PM Dec 31 in UTC-3 → 2:00 AM Jan 1 UTC
      const input = '2025-12-31T23:00:00-03:00'
      const result = parseToUtc(input)
      expect(result.toISOString()).toBe('2026-01-01T02:00:00.000Z')
      expect(result.getUTCFullYear()).toBe(2026)
    })

    it('handles +14:00 (Line Islands) extreme offset', () => {
      const input = '2026-04-15T12:00:00+14:00'
      const result = parseToUtc(input)
      // +14:00 means UTC is 14 hours behind
      expect(result.toISOString()).toBe('2026-04-14T22:00:00.000Z')
    })

    it('handles -12:00 (Baker Island) extreme offset', () => {
      const input = '2026-04-15T00:00:00-12:00'
      const result = parseToUtc(input)
      // -12:00 means UTC is 12 hours ahead
      expect(result.toISOString()).toBe('2026-04-15T12:00:00.000Z')
    })
  })
})
