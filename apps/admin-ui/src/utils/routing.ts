/**
 * Pure routing logic — testable without React.
 * Used by property tests 10 and 11.
 */

/**
 * Determines the post-login redirect destination based on onboarding state.
 * Property 10: Onboarding Routing Property
 * Requirements: 3.16, 3.17
 */
export function getPostLoginRoute(onboardingComplete: boolean): '/admin/welcome' | '/admin/items' {
  return onboardingComplete ? '/admin/items' : '/admin/welcome';
}

/**
 * Determines whether a route under /admin/* requires authentication.
 * All /admin/* routes require auth — there are no public admin routes.
 * Property 11: Protected Route Redirect Property
 * Requirements: 3.25
 */
export const PUBLIC_ADMIN_ROUTES = new Set<string>([]);

export function getProtectedRouteDestination(
  path: string,
  hasValidTokens: boolean
): { redirect: true; to: '/' } | { redirect: false } {
  const isAdminRoute = path.startsWith('/admin/');
  const isPublic = PUBLIC_ADMIN_ROUTES.has(path);

  if (isAdminRoute && !isPublic && !hasValidTokens) {
    return { redirect: true, to: '/' };
  }
  return { redirect: false };
}
