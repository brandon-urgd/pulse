// Property-based tests for timezone parsing round-trip (P6)
// Uses fast-check with vitest to verify ISO 8601 timezone offset parsing.
// **Validates: Requirements 3.2, 3.3, 3.4, 3.5**

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// ── Generators ───────────────────────────────────────────────────────────────
// Generate timezone offsets from -12:00 to +14:00 in 30-minute increments
const offsetArb = fc.integer({ min: -12 * 60, max: 14 * 60 }).filter(m => m % 30 === 0).map(totalMinutes => {
  const sign = totalMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(totalMinutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, '0')
  const mins = String(abs % 60).padStart(2, '0')
  return { offsetString: `${sign}${hours}:${mins}`, totalMinutes }
})

const dateArb = fc.record({
  year: fc.integer({ min: 2020, max: 2030 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }), // avoid month-end edge cases
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 59 }),
})

function formatIso(d, offsetStr) {
  const y = String(d.year).padStart(4, '0')
  const m = String(d.month).padStart(2, '0')
  const day = String(d.day).padStart(2, '0')
  const h = String(d.hour).padStart(2, '0')
  const min = String(d.minute).padStart(2, '0')
  const sec = String(d.second).padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}:${sec}${offsetStr}`
}

/**
 * Property 6: Timezone Parsing Round-Trip
 *
 * For any valid ISO 8601 datetime string with a timezone offset (offsets ranging
 * from -12:00 to +14:00), parsing the string and converting to UTC SHALL produce
 * a datetime that, when converted back to the original timezone offset, equals
 * the original datetime.
 *
 * Validates: Requirements 3.2, 3.3, 3.4, 3.5
 */
describe('Property P6: Timezone parsing round-trip', () => {
  it('parse to UTC and convert back equals original datetime', () => {
    fc.assert(
      fc.property(
        dateArb,
        offsetArb,
        (dateComponents, offset) => {
          const isoString = formatIso(dateComponents, offset.offsetString)

          // Parse with new Date() — this is what the Lambda does
          const parsed = new Date(isoString)

          // Verify it parsed to a valid date
          expect(parsed.getTime()).not.toBeNaN()

          // Convert back: add the offset to get local time
          const utcMs = parsed.getTime()
          const localMs = utcMs + offset.totalMinutes * 60 * 1000

          const localDate = new Date(localMs)

          // Compare components (using UTC methods on the shifted date)
          expect(localDate.getUTCFullYear()).toBe(dateComponents.year)
          expect(localDate.getUTCMonth() + 1).toBe(dateComponents.month)
          expect(localDate.getUTCDate()).toBe(dateComponents.day)
          expect(localDate.getUTCHours()).toBe(dateComponents.hour)
          expect(localDate.getUTCMinutes()).toBe(dateComponents.minute)
          expect(localDate.getUTCSeconds()).toBe(dateComponents.second)
        },
      ),
      { numRuns: 100 },
    )
  })
})
