// @vitest-environment jsdom
// Unit tests for PulseCheckOverlay patience messages
// Requirements: 7.1, 7.2, 7.3, 7.4

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import '@testing-library/jest-dom'

import PulseCheckOverlay from '../../apps/admin-ui/src/components/PulseCheckOverlay.tsx'
import { labels } from '../../apps/admin-ui/src/config/labels-registry.ts'

// ─── Global mocks ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  // Mock requestAnimationFrame — the component uses it for progress bar animation
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    return setTimeout(() => cb(performance.now()), 0) as unknown as number
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    clearTimeout(id)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const noop = () => {}

// ─── Patience message threshold tests ─────────────────────────────────────────

describe('PulseCheckOverlay — patience messages', () => {
  it('shows no patience message before 45s', () => {
    render(<PulseCheckOverlay done={false} onErrorDismiss={noop} />)

    act(() => { vi.advanceTimersByTime(44_000) })

    expect(screen.queryByText(labels.pulseCheck.patience1)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience2)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience3)).not.toBeInTheDocument()
  })

  it('shows first patience message at 45s', () => {
    render(<PulseCheckOverlay done={false} onErrorDismiss={noop} />)

    act(() => { vi.advanceTimersByTime(45_000) })

    expect(screen.getByText(labels.pulseCheck.patience1)).toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience2)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience3)).not.toBeInTheDocument()
  })

  it('replaces first message with second at 90s', () => {
    render(<PulseCheckOverlay done={false} onErrorDismiss={noop} />)

    act(() => { vi.advanceTimersByTime(90_000) })

    expect(screen.queryByText(labels.pulseCheck.patience1)).not.toBeInTheDocument()
    expect(screen.getByText(labels.pulseCheck.patience2)).toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience3)).not.toBeInTheDocument()
  })

  it('replaces second message with third at 150s', () => {
    render(<PulseCheckOverlay done={false} onErrorDismiss={noop} />)

    act(() => { vi.advanceTimersByTime(150_000) })

    expect(screen.queryByText(labels.pulseCheck.patience1)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience2)).not.toBeInTheDocument()
    expect(screen.getByText(labels.pulseCheck.patience3)).toBeInTheDocument()
  })
})

// ─── Timers cleared on done ───────────────────────────────────────────────────

describe('PulseCheckOverlay — timers cleared when done', () => {
  it('shows no patience message when done becomes true before any threshold', () => {
    const { rerender } = render(
      <PulseCheckOverlay done={false} onErrorDismiss={noop} />,
    )

    act(() => { vi.advanceTimersByTime(30_000) })
    rerender(<PulseCheckOverlay done={true} onErrorDismiss={noop} />)

    // Advance past all thresholds — no patience messages should appear
    act(() => { vi.advanceTimersByTime(200_000) })

    expect(screen.queryByText(labels.pulseCheck.patience1)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience2)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience3)).not.toBeInTheDocument()
  })

  it('clears remaining timers when done becomes true after first threshold', () => {
    const { rerender } = render(
      <PulseCheckOverlay done={false} onErrorDismiss={noop} />,
    )

    act(() => { vi.advanceTimersByTime(50_000) }) // past 45s — first message shown
    expect(screen.getByText(labels.pulseCheck.patience1)).toBeInTheDocument()

    rerender(<PulseCheckOverlay done={true} onErrorDismiss={noop} />)

    // Advance past remaining thresholds — no further messages
    act(() => { vi.advanceTimersByTime(200_000) })

    expect(screen.queryByText(labels.pulseCheck.patience2)).not.toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience3)).not.toBeInTheDocument()
  })
})

// ─── Distinct messages per operationType ──────────────────────────────────────

describe('PulseCheckOverlay — operationType produces distinct messages', () => {
  it('pulseCheck and revision patience messages are different strings', () => {
    expect(labels.pulseCheck.patience1).not.toBe(labels.revision.patience1)
    expect(labels.pulseCheck.patience2).not.toBe(labels.revision.patience2)
    expect(labels.pulseCheck.patience3).not.toBe(labels.revision.patience3)
  })

  it('renders pulseCheck patience messages for operationType="pulseCheck"', () => {
    render(
      <PulseCheckOverlay done={false} onErrorDismiss={noop} operationType="pulseCheck" />,
    )

    act(() => { vi.advanceTimersByTime(45_000) })
    expect(screen.getByText(labels.pulseCheck.patience1)).toBeInTheDocument()
  })

  it('renders revision patience messages for operationType="revision"', () => {
    render(
      <PulseCheckOverlay done={false} onErrorDismiss={noop} operationType="revision" />,
    )

    act(() => { vi.advanceTimersByTime(45_000) })
    expect(screen.getByText(labels.revision.patience1)).toBeInTheDocument()
    expect(screen.queryByText(labels.pulseCheck.patience1)).not.toBeInTheDocument()
  })

  it('defaults to pulseCheck messages when operationType is omitted', () => {
    render(<PulseCheckOverlay done={false} onErrorDismiss={noop} />)

    act(() => { vi.advanceTimersByTime(45_000) })
    expect(screen.getByText(labels.pulseCheck.patience1)).toBeInTheDocument()
  })
})
