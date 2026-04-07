// useInactivityTimer — client-side inactivity detection for session timeout
// Requirements: 4.3, 4.4, 4.8

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Pure function (testable without DOM) ───────────────────────────────

/**
 * Computes the current inactivity state given timestamps and config.
 *
 * @param lastActivityMs  - epoch ms of the most recent user activity
 * @param nowMs           - current epoch ms
 * @param timeoutMs       - total inactivity timeout duration
 * @param warningBeforeMs - how many ms before timeout to enter warning state
 */
export function computeInactivityState(
  lastActivityMs: number,
  nowMs: number,
  timeoutMs: number,
  warningBeforeMs: number
): { remainingMs: number; isWarning: boolean; isTimedOut: boolean } {
  const elapsed = Math.max(0, nowMs - lastActivityMs)
  const remaining = Math.max(0, timeoutMs - elapsed)
  const warningThreshold = timeoutMs - warningBeforeMs

  return {
    remainingMs: remaining,
    isWarning: elapsed >= warningThreshold && elapsed < timeoutMs,
    isTimedOut: elapsed >= timeoutMs,
  }
}

// ─── Default timeout from env or 30 minutes ─────────────────────────────

const DEFAULT_TIMEOUT_MS = (() => {
  const envVal = import.meta.env.VITE_SESSION_TIMEOUT_MS
  if (envVal) {
    const parsed = Number(envVal)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 1_800_000 // 30 minutes
})()

// ─── Hook config & return types ─────────────────────────────────────────

export interface UseInactivityTimerConfig {
  timeoutMs?: number          // default from VITE_SESSION_TIMEOUT_MS or 1_800_000
  warningBeforeMs?: number    // default 60_000
  onWarning: () => void
  onTimeout: () => void
}

export interface UseInactivityTimerReturn {
  reset: () => void
  remainingMs: number
  isWarning: boolean
}

// ─── React hook ─────────────────────────────────────────────────────────

/**
 * Tracks user activity (click, keypress, scroll) on the window and fires
 * callbacks when the user has been inactive long enough.
 *
 * - `onWarning` fires once when elapsed >= timeoutMs - warningBeforeMs
 * - `onTimeout` fires once when elapsed >= timeoutMs
 * - `reset()` resets the activity timestamp and clears warning/timeout flags
 * - A 1-second interval re-evaluates state so `remainingMs` ticks down
 */
export function useInactivityTimer(
  config: UseInactivityTimerConfig
): UseInactivityTimerReturn {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    warningBeforeMs = 60_000,
    onWarning,
    onTimeout,
  } = config

  // Mutable refs — avoid stale closures
  const lastActivityRef = useRef(Date.now())
  const warningFiredRef = useRef(false)
  const timeoutFiredRef = useRef(false)

  const onWarningRef = useRef(onWarning)
  onWarningRef.current = onWarning
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  // Reactive state
  const [remainingMs, setRemainingMs] = useState(timeoutMs)
  const [isWarning, setIsWarning] = useState(false)

  // ── Reset ─────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    lastActivityRef.current = Date.now()
    warningFiredRef.current = false
    timeoutFiredRef.current = false
    setRemainingMs(timeoutMs)
    setIsWarning(false)
  }, [timeoutMs])

  // ── Activity listener ─────────────────────────────────────────────────
  useEffect(() => {
    function handleActivity() {
      lastActivityRef.current = Date.now()
      // If user interacts during warning period, reset everything
      if (warningFiredRef.current && !timeoutFiredRef.current) {
        warningFiredRef.current = false
        timeoutFiredRef.current = false
        setIsWarning(false)
      }
    }

    window.addEventListener('click', handleActivity)
    window.addEventListener('keypress', handleActivity)
    window.addEventListener('scroll', handleActivity, { passive: true })

    return () => {
      window.removeEventListener('click', handleActivity)
      window.removeEventListener('keypress', handleActivity)
      window.removeEventListener('scroll', handleActivity)
    }
  }, [])

  // ── 1-second tick to evaluate state ───────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const state = computeInactivityState(
        lastActivityRef.current,
        Date.now(),
        timeoutMs,
        warningBeforeMs
      )

      setRemainingMs(state.remainingMs)
      setIsWarning(state.isWarning)

      // Fire onWarning exactly once
      if (state.isWarning && !warningFiredRef.current) {
        warningFiredRef.current = true
        onWarningRef.current()
      }

      // Fire onTimeout exactly once
      if (state.isTimedOut && !timeoutFiredRef.current) {
        timeoutFiredRef.current = true
        onTimeoutRef.current()
      }
    }, 1_000)

    return () => clearInterval(id)
  }, [timeoutMs, warningBeforeMs])

  return { reset, remainingMs, isWarning }
}
