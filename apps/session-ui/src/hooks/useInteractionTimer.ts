// useInteractionTimer — engagement-aware session pacing

export interface TimerEvent {
  timestamp: number // ms since epoch
  type: 'interaction' | 'visibility_hidden' | 'visibility_visible'
}

/**
 * Pure function that computes cumulative interaction time from a sequence of
 * timer events. Time is accumulated between consecutive events only when:
 *   1. The gap is ≤ idleThresholdMs (user is not idle)
 *   2. The tab is visible (not hidden)
 *
 * Returns a non-negative value in milliseconds, guaranteed ≤ wall-clock
 * duration (last timestamp − first timestamp).
 */
export function computeCumulativeTime(
  events: TimerEvent[],
  idleThresholdMs: number
): number {
  if (events.length < 2) return 0

  // Sort by timestamp (stable — preserves insertion order for equal timestamps)
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)

  let cumulative = 0
  let hidden = false

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]

    // If the previous event hid the tab, mark hidden
    if (prev.type === 'visibility_hidden') {
      hidden = true
    }

    // If the previous event made the tab visible again, mark visible
    if (prev.type === 'visibility_visible') {
      hidden = false
    }

    // Only accumulate when visible and gap is within idle threshold
    if (!hidden) {
      const gap = curr.timestamp - prev.timestamp
      if (gap <= idleThresholdMs) {
        cumulative += gap
      }
    }
  }

  // Clamp: non-negative and ≤ wall-clock duration
  const wallClock = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
  return Math.max(0, Math.min(cumulative, wallClock))
}

// ─── useInteractionTimer React hook ──────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react'

export interface UseInteractionTimerConfig {
  idleThresholdMs?: number        // default 60_000
  onThresholdReached?: () => void
  thresholdMs?: number
}

export interface UseInteractionTimerReturn {
  cumulativeMs: number
  wallClockMs: number
  isIdle: boolean
  reset: () => void
}

/**
 * React hook that tracks cumulative user interaction time by listening to
 * DOM events and delegating accumulation to the pure `computeCumulativeTime`.
 *
 * - Listens to: click, keypress, scroll, touchstart, visibilitychange
 * - Pauses accumulation when the tab is hidden or user is idle
 * - Fires `onThresholdReached` exactly once when cumulative time crosses `thresholdMs`
 * - `reset()` clears all tracked events and resets the wall-clock origin
 */
export function useInteractionTimer(
  config: UseInteractionTimerConfig = {}
): UseInteractionTimerReturn {
  const {
    idleThresholdMs = 60_000,
    onThresholdReached,
    thresholdMs,
  } = config

  // ── Mutable refs (no re-renders) ──────────────────────────────────────
  const eventsRef = useRef<TimerEvent[]>([])
  const startTimeRef = useRef<number>(Date.now())
  const thresholdFiredRef = useRef(false)

  // Keep latest callback in a ref so the effect closure never goes stale
  const onThresholdReachedRef = useRef(onThresholdReached)
  onThresholdReachedRef.current = onThresholdReached

  const thresholdMsRef = useRef(thresholdMs)
  thresholdMsRef.current = thresholdMs

  const idleThresholdMsRef = useRef(idleThresholdMs)
  idleThresholdMsRef.current = idleThresholdMs

  // ── Reactive state (drives re-renders) ────────────────────────────────
  const [cumulativeMs, setCumulativeMs] = useState(0)
  const [wallClockMs, setWallClockMs] = useState(0)
  const [isIdle, setIsIdle] = useState(false)

  // ── Recompute helper ──────────────────────────────────────────────────
  const recompute = useCallback(() => {
    const now = Date.now()
    const events = eventsRef.current
    const cumulative = computeCumulativeTime(events, idleThresholdMsRef.current)
    const wall = now - startTimeRef.current

    setCumulativeMs(cumulative)
    setWallClockMs(wall)

    // Idle = time since last interaction event exceeds threshold
    const lastInteraction = [...events]
      .reverse()
      .find((e) => e.type === 'interaction')
    setIsIdle(
      lastInteraction ? now - lastInteraction.timestamp > idleThresholdMsRef.current : false
    )

    // Fire threshold callback exactly once
    if (
      !thresholdFiredRef.current &&
      thresholdMsRef.current != null &&
      cumulative >= thresholdMsRef.current &&
      onThresholdReachedRef.current
    ) {
      thresholdFiredRef.current = true
      onThresholdReachedRef.current()
    }
  }, [])

  // ── Reset ─────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    eventsRef.current = []
    startTimeRef.current = Date.now()
    thresholdFiredRef.current = false
    setCumulativeMs(0)
    setWallClockMs(0)
    setIsIdle(false)
  }, [])

  // ── DOM event wiring ──────────────────────────────────────────────────
  useEffect(() => {
    function pushInteraction() {
      eventsRef.current.push({ timestamp: Date.now(), type: 'interaction' })
      recompute()
    }

    function handleVisibility() {
      const type: TimerEvent['type'] = document.hidden
        ? 'visibility_hidden'
        : 'visibility_visible'
      eventsRef.current.push({ timestamp: Date.now(), type })
      recompute()
    }

    // Interaction events
    window.addEventListener('click', pushInteraction)
    window.addEventListener('keypress', pushInteraction)
    window.addEventListener('scroll', pushInteraction, { passive: true })
    window.addEventListener('touchstart', pushInteraction, { passive: true })

    // Visibility
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('click', pushInteraction)
      window.removeEventListener('keypress', pushInteraction)
      window.removeEventListener('scroll', pushInteraction)
      window.removeEventListener('touchstart', pushInteraction)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [recompute])

  // ── Periodic wall-clock + idle refresh (1 s tick) ─────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      setWallClockMs(Date.now() - startTimeRef.current)

      // Re-evaluate idle status even without new events
      const lastInteraction = [...eventsRef.current]
        .reverse()
        .find((e) => e.type === 'interaction')
      setIsIdle(
        lastInteraction
          ? Date.now() - lastInteraction.timestamp > idleThresholdMsRef.current
          : false
      )
    }, 1_000)

    return () => clearInterval(id)
  }, [])

  return { cumulativeMs, wallClockMs, isIdle, reset }
}
