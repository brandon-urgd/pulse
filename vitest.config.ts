// Root vitest config — covers Lambda unit tests and property tests
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: [
      // Map ./shared/utils.mjs (relative import inside any lambda) to the shared utils
      {
        find: /^\.\/shared\/utils\.mjs$/,
        replacement: path.resolve(__dirname, 'lambdas/shared/utils.mjs'),
      },
    ],
  },
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
        'lambdas/urgd-pulse-createItem/**/*.mjs',
        'lambdas/urgd-pulse-getItem/**/*.mjs',
        'lambdas/urgd-pulse-updateItem/**/*.mjs',
        'lambdas/urgd-pulse-deleteItem/**/*.mjs',
        'lambdas/urgd-pulse-sendReminder/**/*.mjs',
        'lambdas/urgd-pulse-expireSessions/**/*.mjs',
      ],
      exclude: ['lambdas/**/*.test.mjs', 'lambdas/**/*.property.test.mjs'],
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
