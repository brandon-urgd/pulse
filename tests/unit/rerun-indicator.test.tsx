// @vitest-environment jsdom
// Unit tests for rerun indicator logic
// Tests: dot shown when session completedAt > generatedAt, dot hidden when no newer sessions, no dot when no pulse check.
// Validates: Requirements 7.1, 7.3

import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'

// ─── Pure function extracted from Items.tsx ───────────────────────────────────

interface Session {
  completedAt?: string
}

interface Item {
  hasPulseCheck?: boolean
  pulseCheckGeneratedAt?: string
  sessions?: Session[]
}

/** Show rerun indicator when any session completed after the last pulse check */
function shouldShowRerunDot(item: Item): boolean {
  if (!item.hasPulseCheck || !item.pulseCheckGeneratedAt) return false
  const generatedAt = item.pulseCheckGeneratedAt
  return (item.sessions ?? []).some(
    (s) => s.completedAt && s.completedAt > generatedAt,
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Rerun indicator', () => {
  it('shows dot when session completedAt > generatedAt', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [
        { completedAt: '2026-01-15T12:00:00.000Z' }, // newer
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(true)
  })

  it('shows dot when at least one of multiple sessions is newer', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [
        { completedAt: '2026-01-14T08:00:00.000Z' }, // older
        { completedAt: '2026-01-15T12:00:00.000Z' }, // newer
        { completedAt: '2026-01-15T09:00:00.000Z' }, // older
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(true)
  })

  it('hides dot when no sessions are newer than generatedAt', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [
        { completedAt: '2026-01-14T08:00:00.000Z' },
        { completedAt: '2026-01-15T09:00:00.000Z' },
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('hides dot when sessions have no completedAt', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [
        { completedAt: undefined },
        {},
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('no dot when no pulse check exists', () => {
    const item: Item = {
      hasPulseCheck: false,
      sessions: [
        { completedAt: '2026-01-15T12:00:00.000Z' },
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('no dot when hasPulseCheck is true but pulseCheckGeneratedAt is missing', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: undefined,
      sessions: [
        { completedAt: '2026-01-15T12:00:00.000Z' },
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('no dot when sessions array is empty', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('no dot when sessions is undefined', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })

  it('hides dot when completedAt equals generatedAt exactly (not strictly greater)', () => {
    const item: Item = {
      hasPulseCheck: true,
      pulseCheckGeneratedAt: '2026-01-15T10:00:00.000Z',
      sessions: [
        { completedAt: '2026-01-15T10:00:00.000Z' },
      ],
    }
    expect(shouldShowRerunDot(item)).toBe(false)
  })
})
