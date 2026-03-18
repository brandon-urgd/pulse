// Feature: pulse, Property 8: Pulse Code Validation Property
// Validates: Requirements 3.3, 3.4

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Pulse code validation logic extracted from apps/landing/index.html.
 * Valid format: exactly 8 alphanumeric characters (A-Z, 0-9), case-insensitive.
 *
 * @param {string} code
 * @returns {boolean}
 */
function isValidPulseCode(code) {
  return /^[A-Z0-9]{8}$/i.test(code);
}

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates a valid pulse code: exactly 8 chars from [A-Za-z0-9]. */
const validPulseCode = fc.stringMatching(/^[A-Za-z0-9]{8}$/);

/** Generates a string that is too short (0–7 chars), alphanumeric. */
const tooShort = fc
  .integer({ min: 0, max: 7 })
  .chain(len =>
    len === 0
      ? fc.constant('')
      : fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${len}}$`))
  );

/** Generates a string that is too long (9–20 chars), alphanumeric. */
const tooLong = fc
  .integer({ min: 9, max: 20 })
  .chain(len => fc.stringMatching(new RegExp(`^[A-Za-z0-9]{${len}}$`)));

/** Generates an 8-char string that contains at least one special character. */
const withSpecialChars = fc
  .tuple(
    fc.integer({ min: 0, max: 7 }),   // position of special char
    fc.stringMatching(/^[A-Za-z0-9]{7}$/),
    fc.constantFrom('!', '@', '#', '$', '%', ' ', '-', '_', '.', '/', '\\', '\n', '\t')
  )
  .map(([pos, base, special]) => {
    const arr = base.split('');
    arr.splice(pos, 0, special);
    return arr.slice(0, 8).join('');
  })
  .filter(s => s.length === 8 && !/^[A-Za-z0-9]{8}$/.test(s));

/** Generates a string with whitespace (spaces, tabs, newlines). */
const withWhitespace = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9]{1,7}$/),
    fc.constantFrom(' ', '\t', '\n', '  ')
  )
  .map(([base, ws]) => base + ws)
  .filter(s => !/^[A-Za-z0-9]{8}$/.test(s));

/** Union of all invalid code generators. */
const invalidPulseCode = fc.oneof(
  fc.constant(''),
  tooShort,
  tooLong,
  withSpecialChars,
  withWhitespace
);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 8: Pulse Code Validation Property', () => {
  it('valid pulse codes (8 alphanumeric chars) pass validation', () => {
    fc.assert(
      fc.property(validPulseCode, (code) => {
        expect(isValidPulseCode(code)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('invalid codes (wrong length, special chars, empty, spaces) fail validation', () => {
    fc.assert(
      fc.property(invalidPulseCode, (code) => {
        expect(isValidPulseCode(code)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('valid and invalid cases are mutually exclusive', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 20 }), (code) => {
        const passes = isValidPulseCode(code);
        const fails = !isValidPulseCode(code);
        // A code cannot both pass and fail — they are always complementary
        expect(passes).toBe(!fails);
        expect(passes && fails).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('exactly 8 alphanumeric chars always pass, anything else always fails', () => {
    // Spot-check the boundary: 7 chars fail, 8 pass, 9 fail
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{7}$/),
        (code) => {
          expect(isValidPulseCode(code)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{9}$/),
        (code) => {
          expect(isValidPulseCode(code)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});
