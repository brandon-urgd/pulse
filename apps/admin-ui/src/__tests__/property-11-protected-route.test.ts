/**
 * Feature: pulse
 * Property 11: Protected Route Redirect Property
 *
 * For any route under /admin/* accessed without valid tokens, the Admin UI
 * always redirects to /. For any route accessed with valid tokens,
 * the route renders normally. These two cases are mutually exclusive.
 *
 * Validates: Requirements 3.25
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getProtectedRouteDestination, PUBLIC_ADMIN_ROUTES } from '../utils/routing';

// Arbitrary: admin paths that are NOT public (require auth)
const protectedAdminPath = fc
  .stringMatching(/^\/admin\/[a-z][a-z0-9-/]*$/)
  .filter((p) => !PUBLIC_ADMIN_ROUTES.has(p));

describe('Property 11: Protected Route Redirect Property', () => {
  it('redirects to / for any protected route without valid tokens', () => {
    fc.assert(
      fc.property(
        protectedAdminPath,
        (path) => {
          const result = getProtectedRouteDestination(path, false);
          expect(result.redirect).toBe(true);
          if (result.redirect) {
            expect(result.to).toBe('/');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('does not redirect for any protected route with valid tokens', () => {
    fc.assert(
      fc.property(
        protectedAdminPath,
        (path) => {
          const result = getProtectedRouteDestination(path, true);
          expect(result.redirect).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('redirect and no-redirect are mutually exclusive for any path + token combination', () => {
    fc.assert(
      fc.property(
        protectedAdminPath,
        fc.boolean(),
        (path, hasTokens) => {
          const result = getProtectedRouteDestination(path, hasTokens);
          expect(typeof result.redirect).toBe('boolean');
          if (result.redirect) {
            expect(result.to).toBe('/');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('a protected route without tokens always redirects — never renders', () => {
    fc.assert(
      fc.property(
        protectedAdminPath,
        (path) => {
          const withTokens = getProtectedRouteDestination(path, true);
          const withoutTokens = getProtectedRouteDestination(path, false);
          expect(withTokens.redirect).toBe(false);
          expect(withoutTokens.redirect).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
