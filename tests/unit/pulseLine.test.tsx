// @vitest-environment jsdom
// Unit tests for PulseLine component and computeWeights
// Requirements: 4.3, 4.4, 4.5

import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import '@testing-library/jest-dom'

import PulseLine, {
  computeWeights,
  type SectionEntry,
} from '../../apps/session-ui/src/components/PulseLine.tsx'

// Stub window.matchMedia for jsdom (PulseLine uses it for reduced-motion)
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

// ─── computeWeights unit tests ────────────────────────────────────────────────

describe('computeWeights', () => {
  it('returns word-count-proportional weights when all sections have wordCount', () => {
    const sections: SectionEntry[] = [
      { id: 's1', wordCount: 300 },
      { id: 's2', wordCount: 700 },
    ]
    const weights = computeWeights(sections)
    expect(weights[0]).toBeCloseTo(0.3, 4)
    expect(weights[1]).toBeCloseTo(0.7, 4)
  })

  it('returns equal weights when any section lacks wordCount', () => {
    const sections: SectionEntry[] = [
      { id: 's1', wordCount: 500 },
      { id: 's2' },
    ]
    const weights = computeWeights(sections)
    expect(weights[0]).toBeCloseTo(0.5, 4)
    expect(weights[1]).toBeCloseTo(0.5, 4)
  })

  it('returns equal weights when all wordCounts are 0', () => {
    const sections: SectionEntry[] = [
      { id: 's1', wordCount: 0 },
      { id: 's2', wordCount: 0 },
      { id: 's3', wordCount: 0 },
    ]
    const weights = computeWeights(sections)
    for (const w of weights) {
      expect(w).toBeCloseTo(1 / 3, 4)
    }
  })

  it('handles a single section', () => {
    const sections: SectionEntry[] = [{ id: 's1', wordCount: 100 }]
    const weights = computeWeights(sections)
    expect(weights).toEqual([1])
  })
})

// ─── PulseLine rendering tests ────────────────────────────────────────────────

describe('PulseLine — renders for total === 1', () => {
  it('renders a progressbar element when total === 1 (caller hides, not the component)', () => {
    const { container } = render(<PulseLine current={1} total={1} />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).toBeInTheDocument()
  })
})

describe('PulseLine — progress is 100% when current >= total', () => {
  it('aria-valuenow is 100 when current equals total', () => {
    const { container } = render(<PulseLine current={3} total={3} />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
  })

  it('aria-valuenow is 100 when current exceeds total', () => {
    const { container } = render(<PulseLine current={5} total={3} />)
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).toHaveAttribute('aria-valuenow', '100')
  })
})

describe('PulseLine — progress is monotonically non-decreasing', () => {
  it('progress increases as current advances through sections (equal weights)', () => {
    const total = 5
    let prevPct = -1

    for (let current = 1; current <= total; current++) {
      const { container } = render(<PulseLine current={current} total={total} />)
      const bar = container.querySelector('[role="progressbar"]')
      const pct = Number(bar!.getAttribute('aria-valuenow'))
      expect(pct).toBeGreaterThanOrEqual(prevPct)
      prevPct = pct
    }
  })

  it('progress increases as current advances through sections (word-count weights)', () => {
    const sections: SectionEntry[] = [
      { id: 's1', wordCount: 100 },
      { id: 's2', wordCount: 400 },
      { id: 's3', wordCount: 500 },
    ]
    const total = sections.length
    let prevPct = -1

    for (let current = 1; current <= total; current++) {
      const { container } = render(
        <PulseLine current={current} total={total} sections={sections} />,
      )
      const bar = container.querySelector('[role="progressbar"]')
      const pct = Number(bar!.getAttribute('aria-valuenow'))
      expect(pct).toBeGreaterThanOrEqual(prevPct)
      prevPct = pct
    }
  })
})
