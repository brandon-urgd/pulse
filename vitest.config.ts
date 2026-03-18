// Root vitest config — covers Lambda unit tests and property tests
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'lambdas/**/*.test.mjs',
      'lambdas/**/*.test.ts',
      'apps/landing/__tests__/**/*.test.mjs',
      'apps/landing/__tests__/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'lambdas/urgd-pulse-register/**/*.mjs',
        'lambdas/urgd-pulse-createTenant/**/*.mjs',
        'lambdas/urgd-pulse-getSettings/**/*.mjs',
        'lambdas/urgd-pulse-updateSettings/**/*.mjs',
        'lambdas/urgd-pulse-getItems/**/*.mjs',
      ],
      exclude: ['lambdas/**/*.test.mjs'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
})
