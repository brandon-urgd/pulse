/**
 * Feature: pulse
 * Property 10: Onboarding Routing Property
 *
 * For any tenant with onboardingComplete: false, first authenticated navigation
 * routes to /admin/welcome. For any tenant with onboardingComplete: true,
 * navigation routes to /admin/items. These are mutually exclusive.
 *
 * Validates: Requirements 3.16, 3.17
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getPostLoginRoute } from '../utils/routing';

describe('Property 10: Onboarding Routing Property', () => {
  it('routes to /admin/welcome when onboardingComplete is false', () => {
    fc.assert(
      fc.property(
        fc.constant(false),
        (onboardingComplete) => {
          const route = getPostLoginRoute(onboardingComplete);
          expect(route).toBe('/admin/welcome');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes to /admin/items when onboardingComplete is true', () => {
    fc.assert(
      fc.property(
        fc.constant(true),
        (onboardingComplete) => {
          const route = getPostLoginRoute(onboardingComplete);
          expect(route).toBe('/admin/items');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('routes are mutually exclusive — false always gives welcome, true always gives items', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        (onboardingComplete) => {
          const route = getPostLoginRoute(onboardingComplete);
          if (onboardingComplete) {
            expect(route).toBe('/admin/items');
            expect(route).not.toBe('/admin/welcome');
          } else {
            expect(route).toBe('/admin/welcome');
            expect(route).not.toBe('/admin/items');
          }
          // Exhaustive: exactly one of the two routes is returned
          expect(['/admin/welcome', '/admin/items']).toContain(route);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the two cases are exhaustive — no other route is ever returned', () => {
    const VALID_ROUTES = new Set(['/admin/welcome', '/admin/items']);
    fc.assert(
      fc.property(
        fc.boolean(),
        (onboardingComplete) => {
          const route = getPostLoginRoute(onboardingComplete);
          expect(VALID_ROUTES.has(route)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
