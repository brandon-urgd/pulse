// Feature: feature-flag-system
// Centralized feature resolution module for Pulse.
// All enforcement Lambdas call resolveFeature() instead of ad-hoc tier logic.

import { getTierDefaults, VALID_FLAGS } from './tiers.mjs'

/**
 * Resolves a feature for a tenant, checking circuit breakers then tier gates.
 *
 * Resolution order:
 *   1. Unknown feature guard → unknown_feature
 *   2. System-level circuit breaker (maintenance) → maintenance
 *   3. Tenant-level circuit breaker (maintenance) → maintenance
 *   4. Tenant features map override → tier default fallback
 *   5. Boolean true → allowed, Boolean false → tier_limit, Number → allowed + limit
 *
 * @param {object|null} tenantRecord - Unmarshalled tenant DynamoDB record
 *   { tier?: string, features?: object, serviceFlags?: object }
 * @param {string} featureName - The flag name to resolve
 * @param {object|null} [systemRecord] - Optional unmarshalled SYSTEM record
 *   { serviceFlags?: object }
 * @returns {{ allowed: boolean, reason: string, limit: number|null }}
 */
export function resolveFeature(tenantRecord, featureName, systemRecord = null) {
  // 1. Unknown feature guard
  if (!VALID_FLAGS.includes(featureName)) {
    return { allowed: false, reason: 'unknown_feature', limit: null }
  }

  // 2. Circuit breaker: system-level takes priority
  if (systemRecord?.serviceFlags?.[featureName]?.status === 'maintenance') {
    return { allowed: false, reason: 'maintenance', limit: null }
  }

  // 3. Circuit breaker: tenant-level
  if (tenantRecord?.serviceFlags?.[featureName]?.status === 'maintenance') {
    return { allowed: false, reason: 'maintenance', limit: null }
  }

  // 4. Resolve value: tenant override → tier default fallback
  const tierDefaults = getTierDefaults(tenantRecord?.tier)
  const tenantFeatures = tenantRecord?.features ?? {}
  const value = tenantFeatures[featureName] ?? tierDefaults[featureName]

  // 5. Return based on value type
  if (typeof value === 'boolean') {
    return value
      ? { allowed: true, reason: 'allowed', limit: null }
      : { allowed: false, reason: 'tier_limit', limit: null }
  }

  if (typeof value === 'number') {
    return { allowed: true, reason: 'allowed', limit: value }
  }

  // Fallback — should not be reached for valid flags with well-formed tier data
  return { allowed: false, reason: 'unknown_feature', limit: null }
}

/**
 * Resolves all features for a tenant. Used by getSettings to build the
 * enriched features map with reason codes for every flag.
 *
 * @param {object|null} tenantRecord - Unmarshalled tenant DynamoDB record
 * @param {object|null} [systemRecord] - Optional unmarshalled SYSTEM record
 * @returns {object} Map of featureName → { allowed, reason, limit }
 */
export function resolveAllFeatures(tenantRecord, systemRecord = null) {
  const result = {}
  for (const flag of VALID_FLAGS) {
    result[flag] = resolveFeature(tenantRecord, flag, systemRecord)
  }
  return result
}
