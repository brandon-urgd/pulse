/**
 * Pure function that computes the next polling state given a sequence of
 * poll outcomes (success/failure). Used by ItemRevision.tsx polling logic.
 *
 * The consecutive failure threshold is 10: polling stops after exactly
 * 10 consecutive network failures. Any successful poll resets the counter.
 */

export const CONSECUTIVE_FAILURE_THRESHOLD = 10;

export type PollOutcome = 'success' | 'failure';

export interface PollingState {
  /** Current consecutive failure count */
  consecutiveFailures: number;
  /** Whether polling should continue */
  shouldContinuePolling: boolean;
  /** Whether polling was stopped due to failure threshold */
  stoppedByFailures: boolean;
}

/**
 * Compute the polling state after processing a sequence of poll outcomes.
 * Processes outcomes left-to-right, stopping early if the failure threshold is reached.
 */
export function computePollingState(outcomes: PollOutcome[]): PollingState {
  let consecutiveFailures = 0;

  for (const outcome of outcomes) {
    if (outcome === 'success') {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
        return {
          consecutiveFailures,
          shouldContinuePolling: false,
          stoppedByFailures: true,
        };
      }
    }
  }

  return {
    consecutiveFailures,
    shouldContinuePolling: true,
    stoppedByFailures: false,
  };
}
