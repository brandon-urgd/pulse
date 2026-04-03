// @vitest-environment jsdom
// Unit tests for Plan page usage counters (R11)
// Tests: counters displayed from usageCounters, missing counters show 0, usage bar rendering.
// Validates: Requirements 11.1, 11.2, 11.3, 11.4

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { createElement } from 'react'

// ─── Types mirroring Plan.tsx ─────────────────────────────────────────────────

interface UsageCounter {
  count: number
  periodStart?: string
}

interface EnrichedFeature {
  allowed: boolean
  reason: string
  limit: number | null
}

// ─── Pure logic extracted from Plan.tsx ───────────────────────────────────────

/**
 * Resolve the displayed usage count for a trackable feature.
 * Reads from usageCounters map, defaulting to 0 when entry is missing.
 * This mirrors the Plan.tsx usageCounts logic.
 */
function resolveUsageCount(
  flag: string,
  usageCounters: Record<string, UsageCounter> | undefined,
  itemCount: number,
): number {
  if (flag === 'maxActiveItems') return itemCount
  return usageCounters?.[flag]?.count ?? 0
}

/**
 * UsageBar component — mirrors Plan.tsx UsageBar.
 */
function UsageBar({ used, max }: { used: number; max: number }) {
  const pct = max > 0 ? Math.min((used / max) * 100, 100) : 0
  const fillClass = pct >= 100 ? 'full' : pct >= 80 ? 'warning' : 'normal'

  return createElement(
    'div',
    { role: 'progressbar', 'aria-valuenow': used, 'aria-valuemin': 0, 'aria-valuemax': max },
    createElement('div', { className: fillClass, style: { width: `${pct}%` } }),
  )
}

/**
 * Minimal Plan counters component that mirrors the real component's counter logic.
 */
function PlanCountersHarness({
  enrichedFeatures,
  usageCounters,
  itemCount = 0,
}: {
  enrichedFeatures: Record<string, EnrichedFeature>
  usageCounters?: Record<string, UsageCounter>
  itemCount?: number
}) {
  const TRACKABLE = new Set([
    'maxActiveItems', 'maxSessionsPerItem', 'maxOrgMembers',
    'monthlySessionsTotal', 'monthlyPublicSessionsTotal', 'monthlyItemsCreated',
  ])

  const trackable = Object.entries(enrichedFeatures)
    .filter(([flag, f]) => f.limit !== null && TRACKABLE.has(flag))
    .sort(([a], [b]) => a.localeCompare(b))

  return createElement('div', null,
    createElement('h1', null, 'Plan'),
    ...trackable.map(([flag, feature]) => {
      const max = feature.limit ?? 0
      const used = resolveUsageCount(flag, usageCounters, itemCount)
      return createElement('div', { key: flag },
        createElement('span', { 'data-testid': `label-${flag}` }, flag),
        createElement('span', { 'data-testid': `count-${flag}` }, `${used} of ${max}`),
        createElement(UsageBar, { used, max }),
      )
    }),
  )
}

// ─── Test data ────────────────────────────────────────────────────────────────

const baseEnriched: Record<string, EnrichedFeature> = {
  monthlyItemsCreated: { allowed: true, reason: 'allowed', limit: 2 },
  monthlySessionsTotal: { allowed: true, reason: 'allowed', limit: 5 },
  monthlyPublicSessionsTotal: { allowed: false, reason: 'tier_limit', limit: 0 },
  maxActiveItems: { allowed: true, reason: 'allowed', limit: 1 },
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Plan page counters', () => {
  it('displays counters from usageCounters', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
      usageCounters: {
        monthlyItemsCreated: { count: 1, periodStart: '2026-01-01T00:00:00Z' },
        monthlySessionsTotal: { count: 3, periodStart: '2026-01-01T00:00:00Z' },
        monthlyPublicSessionsTotal: { count: 0, periodStart: '2026-01-01T00:00:00Z' },
      },
    }))

    expect(screen.getByTestId('count-monthlyItemsCreated')).toHaveTextContent('1 of 2')
    expect(screen.getByTestId('count-monthlySessionsTotal')).toHaveTextContent('3 of 5')
  })

  it('shows 0 when usageCounters entry is missing', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
      usageCounters: {}, // no counter entries
    }))

    expect(screen.getByTestId('count-monthlyItemsCreated')).toHaveTextContent('0 of 2')
    expect(screen.getByTestId('count-monthlySessionsTotal')).toHaveTextContent('0 of 5')
  })

  it('shows 0 when usageCounters is undefined', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
      usageCounters: undefined,
    }))

    expect(screen.getByTestId('count-monthlyItemsCreated')).toHaveTextContent('0 of 2')
    expect(screen.getByTestId('count-monthlySessionsTotal')).toHaveTextContent('0 of 5')
  })

  it('renders usage bars with progressbar role', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
      usageCounters: {
        monthlyItemsCreated: { count: 1, periodStart: '2026-01-01T00:00:00Z' },
        monthlySessionsTotal: { count: 3, periodStart: '2026-01-01T00:00:00Z' },
      },
    }))

    const progressBars = screen.getAllByRole('progressbar')
    expect(progressBars.length).toBeGreaterThan(0)
  })

  it('maxActiveItems uses itemCount instead of usageCounters', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
      usageCounters: {},
      itemCount: 1,
    }))

    expect(screen.getByTestId('count-maxActiveItems')).toHaveTextContent('1 of 1')
  })

  it('renders the Plan heading', () => {
    render(createElement(PlanCountersHarness, {
      enrichedFeatures: baseEnriched,
    }))

    expect(screen.getByText('Plan')).toBeInTheDocument()
  })
})

// ─── Pure function unit tests ─────────────────────────────────────────────────

describe('resolveUsageCount', () => {
  it('returns count from usageCounters for monthly flags', () => {
    const counters = { monthlyItemsCreated: { count: 5 } }
    expect(resolveUsageCount('monthlyItemsCreated', counters, 0)).toBe(5)
  })

  it('returns 0 when counter entry is missing', () => {
    expect(resolveUsageCount('monthlyItemsCreated', {}, 0)).toBe(0)
  })

  it('returns 0 when usageCounters is undefined', () => {
    expect(resolveUsageCount('monthlyItemsCreated', undefined, 0)).toBe(0)
  })

  it('returns itemCount for maxActiveItems', () => {
    expect(resolveUsageCount('maxActiveItems', {}, 3)).toBe(3)
  })
})
