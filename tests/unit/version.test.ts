// Unit test for APP_VERSION constant
// Validates: Requirement 10.1

import { describe, it, expect } from 'vitest'
import { APP_VERSION } from '../../apps/admin-ui/src/config/version'

describe('APP_VERSION', () => {
  it('equals 1.1', () => {
    expect(APP_VERSION).toBe('1.1')
  })
})
