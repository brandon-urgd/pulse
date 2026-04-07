// Root vitest config — covers Lambda unit tests and property tests
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Map ./shared/utils.mjs (relative import inside any lambda) to the shared utils
      {
        find: /^\.\/shared\/utils\.mjs$/,
        replacement: path.resolve(__dirname, 'lambdas/shared/utils.mjs'),
      },
      {
        find: /^\.\/shared\/features\.mjs$/,
        replacement: path.resolve(__dirname, 'lambdas/shared/features.mjs'),
      },
      {
        find: /^\.\/shared\/tiers\.mjs$/,
        replacement: path.resolve(__dirname, 'lambdas/shared/tiers.mjs'),
      },
    ],
  },
  test: {
    environment: 'node',
    globals: true,
    include: [
      'lambdas/**/*.test.mjs',
      'lambdas/**/*.test.ts',
      'tests/**/*.test.mjs',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'apps/landing/__tests__/**/*.test.mjs',
      'apps/landing/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.mjs',
      'apps/session-ui/src/__tests__/**/*.test.ts',
      'apps/session-ui/src/__tests__/**/*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      include: [
        // S0 — Auth, health, infrastructure
        'lambdas/urgd-pulse-cognitoAuth/**/*.mjs',
        'lambdas/urgd-pulse-health/**/*.mjs',
        'lambdas/urgd-pulse-bedrockHealth/**/*.mjs',
        'lambdas/urgd-pulse-sessionAuth/**/*.mjs',
        'lambdas/urgd-pulse-shieldCallback/**/*.mjs',
        // S1 — Registration, tenant management, feature flags
        'lambdas/urgd-pulse-register/**/*.mjs',
        'lambdas/urgd-pulse-createTenant/**/*.mjs',
        'lambdas/urgd-pulse-adminTenants/**/*.mjs',
        'lambdas/urgd-pulse-publicConfig/**/*.mjs',
        'lambdas/urgd-pulse-acceptConfidentiality/**/*.mjs',
        // S1 — Enforcement Lambdas
        'lambdas/urgd-pulse-createItem/**/*.mjs',
        'lambdas/urgd-pulse-createPublicSession/**/*.mjs',
        'lambdas/urgd-pulse-createSelfSession/**/*.mjs',
        'lambdas/urgd-pulse-extractText/**/*.mjs',
        'lambdas/urgd-pulse-generateReport/**/*.mjs',
        'lambdas/urgd-pulse-generateRevision/**/*.mjs',
        'lambdas/urgd-pulse-generateSessionSummary/**/*.mjs',
        'lambdas/urgd-pulse-getSettings/**/*.mjs',
        'lambdas/urgd-pulse-getUploadUrl/**/*.mjs',
        'lambdas/urgd-pulse-inviteReviewer/**/*.mjs',
        'lambdas/urgd-pulse-previewSession/**/*.mjs',
        'lambdas/urgd-pulse-runPulseCheck/**/*.mjs',
        'lambdas/urgd-pulse-sendReminder/**/*.mjs',
        // S1 — Other modified Lambdas
        'lambdas/urgd-pulse-getRevisions/**/*.mjs',
        'lambdas/urgd-pulse-sendPulseCheckReady/**/*.mjs',
        'lambdas/urgd-pulse-submitReport/**/*.mjs',
        // Items, sessions, settings
        'lambdas/urgd-pulse-updateSettings/**/*.mjs',
        'lambdas/urgd-pulse-getItems/**/*.mjs',
        'lambdas/urgd-pulse-getItem/**/*.mjs',
        'lambdas/urgd-pulse-updateItem/**/*.mjs',
        'lambdas/urgd-pulse-deleteItem/**/*.mjs',
        'lambdas/urgd-pulse-closeItem/**/*.mjs',
        'lambdas/urgd-pulse-getItemSessions/**/*.mjs',
        'lambdas/urgd-pulse-cancelSession/**/*.mjs',
        'lambdas/urgd-pulse-resendInvite/**/*.mjs',
        'lambdas/urgd-pulse-extendDeadline/**/*.mjs',
        'lambdas/urgd-pulse-expireSessions/**/*.mjs',
        'lambdas/urgd-pulse-expirePublicSession/**/*.mjs',
        'lambdas/urgd-pulse-validateSession/**/*.mjs',
        'lambdas/urgd-pulse-removeDocument/**/*.mjs',
        'lambdas/urgd-pulse-deleteAccount/**/*.mjs',
        'lambdas/urgd-pulse-getPublicSessionQr/**/*.mjs',
        // S4 — Chat, streaming, sessions
        'lambdas/urgd-pulse-chat/**/*.mjs',
        'lambdas/urgd-pulse-getSessionState/**/*.mjs',
        'lambdas/urgd-pulse-getSessionSummary/**/*.mjs',
        'lambdas/urgd-pulse-deleteSessionTranscript/**/*.mjs',
        'lambdas/urgd-pulse-getSessionFile/**/*.mjs',
        'lambdas/urgd-pulse-getDocumentUrl/**/*.mjs',
        // S5 — Pulse check, reports, usage
        'lambdas/urgd-pulse-getReport/**/*.mjs',
        'lambdas/urgd-pulse-getPulseCheck/**/*.mjs',
        'lambdas/urgd-pulse-savePCDecisions/**/*.mjs',
        'lambdas/urgd-pulse-processPulseCheck/**/*.mjs',
        'lambdas/urgd-pulse-usageReport/**/*.mjs',
      ],
      exclude: [
        'lambdas/**/*.test.mjs',
        'lambdas/**/*.property.test.mjs',
        'lambdas/**/shared/*.mjs',
      ],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 70,
        statements: 90,
      },
    },
  },
})
