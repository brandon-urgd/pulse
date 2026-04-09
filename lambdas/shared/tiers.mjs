// Feature: feature-flag-system
// Canonical tier definitions for Pulse feature flags.
// Spec 2: 5 tiers × 17 flags. pulseCheckGroupMode removed. individual tier added.
// selfReview free tier changed from true → false.

export const TIERS = {
  admin: {
    maxActiveItems: 999,
    maxSessionsPerItem: 999,
    sessionTimeLimitMinutes: 120,
    maxUploadSizeMb: 50,
    maxPhotoSizeMb: 25,
    maxDocumentPages: 999,
    publicSessions: true,
    selfReview: true,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: true,
    emailReminders: true,
    organizationsEnabled: true,
    maxOrgMembers: 999,
    monthlySessionsTotal: 9999,
    monthlyPublicSessionsTotal: 9999,
    monthlyItemsCreated: 9999,
  },
  free: {
    maxActiveItems: 1,
    maxSessionsPerItem: 5,
    sessionTimeLimitMinutes: 15,
    maxUploadSizeMb: 10,
    maxPhotoSizeMb: 5,
    maxDocumentPages: 10,
    publicSessions: false,
    selfReview: false,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: false,
    emailReminders: true,
    organizationsEnabled: false,
    maxOrgMembers: 0,
    monthlySessionsTotal: 5,
    monthlyPublicSessionsTotal: 0,
    monthlyItemsCreated: 2,
  },
  individual: {
    maxActiveItems: 3,
    maxSessionsPerItem: 10,
    sessionTimeLimitMinutes: 20,
    maxUploadSizeMb: 15,
    maxPhotoSizeMb: 10,
    maxDocumentPages: 20,
    publicSessions: true,
    selfReview: true,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: false,
    emailReminders: true,
    organizationsEnabled: false,
    maxOrgMembers: 0,
    monthlySessionsTotal: 15,
    monthlyPublicSessionsTotal: 5,
    monthlyItemsCreated: 5,
  },
  pro: {
    maxActiveItems: 10,
    maxSessionsPerItem: 20,
    sessionTimeLimitMinutes: 45,
    maxUploadSizeMb: 25,
    maxPhotoSizeMb: 15,
    maxDocumentPages: 50,
    publicSessions: true,
    selfReview: true,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: true,
    emailReminders: true,
    organizationsEnabled: false,
    maxOrgMembers: 0,
    monthlySessionsTotal: 50,
    monthlyPublicSessionsTotal: 20,
    monthlyItemsCreated: 20,
  },
  enterprise: {
    maxActiveItems: 100,
    maxSessionsPerItem: 20,
    sessionTimeLimitMinutes: 60,
    maxUploadSizeMb: 50,
    maxPhotoSizeMb: 25,
    maxDocumentPages: 200,
    publicSessions: true,
    selfReview: true,
    pulseCheck: true,
    aiReports: true,
    itemRevisionLoop: true,
    emailReminders: true,
    organizationsEnabled: true,
    maxOrgMembers: 10,
    monthlySessionsTotal: 500,
    monthlyPublicSessionsTotal: 200,
    monthlyItemsCreated: 100,
  },
}

/** All valid feature flag names (derived from free tier keys). */
export const VALID_FLAGS = Object.keys(TIERS.free)

/** All valid tier names. */
export const VALID_TIERS = Object.keys(TIERS)

/**
 * Returns the default flag values for a tier.
 * Falls back to free tier for unknown tier names.
 *
 * @param {string} tierName
 * @returns {object}
 */
export function getTierDefaults(tierName) {
  return Object.hasOwn(TIERS, tierName) ? TIERS[tierName] : TIERS.free
}
