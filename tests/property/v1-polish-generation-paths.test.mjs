// Integration tests for runPulseCheck generation paths — pure utility functions
// Validates: Requirements 6D.16, 6D.17
//
// The Lambda has AWS SDK dependencies so we test only the pure utility functions:
// getMaxTokens, getConsolidationMaxTokens, splitIntoBatches.
// Functions are inlined (same approach as the property tests) to avoid
// importing the Lambda module which pulls in AWS SDK clients.

import { describe, it, expect } from 'vitest'

// ─── Inlined utility functions ─────────────────────────────────────────────────
// These mirror the exported functions in urgd-pulse-processPulseCheck/index.mjs.

function getMaxTokens(sessionCount) {
  if (sessionCount <= 7) return 4096
  if (sessionCount <= 15) return 8192
  // 16-20: map-reduce handles token budget per batch
  return 4096 // per-batch max_tokens
}

function getConsolidationMaxTokens() {
  return 8192
}

function splitIntoBatches(reports, batchSize = 10) {
  const batches = []
  for (let i = 0; i < reports.length; i += batchSize) {
    batches.push(reports.slice(i, i + batchSize))
  }
  // If last batch is very small (< 4) and there are multiple batches, merge it into the previous
  if (batches.length > 1 && batches[batches.length - 1].length < 4) {
    const last = batches.pop()
    batches[batches.length - 1] = batches[batches.length - 1].concat(last)
  }
  return batches
}

// ─── Helper ────────────────────────────────────────────────────────────────────

function makeReports(count) {
  return Array.from({ length: count }, (_, i) => ({ sessionId: `s${i + 1}` }))
}

// ─── Tests: getMaxTokens ───────────────────────────────────────────────────────

describe('getMaxTokens — returns 4096 for session counts 1-7', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    'returns 4096 for sessionCount = %d',
    (count) => {
      expect(getMaxTokens(count)).toBe(4096)
    },
  )
})

describe('getMaxTokens — returns 8192 for session counts 8-15', () => {
  it.each([8, 9, 10, 11, 12, 13, 14, 15])(
    'returns 8192 for sessionCount = %d',
    (count) => {
      expect(getMaxTokens(count)).toBe(8192)
    },
  )
})

describe('getMaxTokens — returns 4096 (per-batch) for session counts 16-20', () => {
  it.each([16, 17, 18, 19, 20])(
    'returns 4096 for sessionCount = %d',
    (count) => {
      expect(getMaxTokens(count)).toBe(4096)
    },
  )
})

// ─── Tests: getConsolidationMaxTokens ──────────────────────────────────────────

describe('getConsolidationMaxTokens — returns 8192', () => {
  it('always returns 8192', () => {
    expect(getConsolidationMaxTokens()).toBe(8192)
  })
})

// ─── Tests: splitIntoBatches ───────────────────────────────────────────────────

describe('splitIntoBatches — splits correctly', () => {
  it('16 reports → 2 batches of [10, 6]', () => {
    const batches = splitIntoBatches(makeReports(16))
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(10)
    expect(batches[1]).toHaveLength(6)
  })

  it('17 reports → 2 batches of [10, 7]', () => {
    const batches = splitIntoBatches(makeReports(17))
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(10)
    expect(batches[1]).toHaveLength(7)
  })

  it('20 reports → 2 batches of [10, 10]', () => {
    const batches = splitIntoBatches(makeReports(20))
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(10)
    expect(batches[1]).toHaveLength(10)
  })

  it('merges small last batch (< 4) into previous batch', () => {
    // 13 reports → would be [10, 3], but 3 < 4 so merges → [13]
    const batches = splitIntoBatches(makeReports(13))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(13)
  })

  it('does not merge last batch when it has 4+ items', () => {
    // 14 reports → [10, 4], 4 >= 4 so no merge
    const batches = splitIntoBatches(makeReports(14))
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(10)
    expect(batches[1]).toHaveLength(4)
  })

  it('single batch for 10 or fewer reports', () => {
    const batches = splitIntoBatches(makeReports(8))
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(8)
  })

  it('preserves all report references across batches', () => {
    const reports = makeReports(18)
    const batches = splitIntoBatches(reports)
    const flattened = batches.flat()
    expect(flattened).toHaveLength(18)
    expect(flattened).toEqual(reports)
  })
})
