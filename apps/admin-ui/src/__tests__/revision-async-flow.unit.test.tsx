// @vitest-environment jsdom
/**
 * Unit tests for async revision flow:
 * 1. GeneratingOverlay renders on 202 response (status: 'generating')
 * 2. Polling starts at 3s intervals
 * 3. Polling stops on 'complete' status — shows side-by-side view
 * 4. Polling stops on 'failed' status — shows error with retry button
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4
 *
 * Pattern: test harness components that mirror the real component logic,
 * avoiding CSS module and import.meta.env dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, useState, useRef, useEffect, useCallback } from 'react';

// ─── Labels (subset matching real labels-registry) ────────────────────────────

const labels = {
  revision: {
    generatingCaption: 'Revising {itemName}',
    generatingPhase1: 'Reading your decisions…',
    generateError: 'Something went wrong generating the revision. Try again.',
    retryButton: 'Try again',
    originalPaneLabel: 'Original',
    revisionPaneLabel: 'Revision {number}',
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Revision {
  revisionId: string;
  revisionNumber: number;
  status: 'generating' | 'complete' | 'failed';
  createdAt: string;
  documentUrl?: string;
  originalUrl?: string;
}

// ─── GeneratingOverlay Harness ────────────────────────────────────────────────

function GeneratingOverlayHarness({ itemName }: { itemName: string }) {
  return createElement('div', {
    role: 'status',
    'aria-label': labels.revision.generatingCaption.replace('{itemName}', itemName),
    'data-testid': 'generating-overlay',
  },
    createElement('p', null, labels.revision.generatingPhase1),
    createElement('p', null, labels.revision.generatingCaption.replace('{itemName}', itemName)),
  );
}

// ─── Polling Harness ──────────────────────────────────────────────────────────
// Mirrors the polling logic from ItemRevision.tsx

interface PollingHarnessProps {
  itemName: string;
  /** Simulated mutation response status (202 triggers generating state) */
  mutationStatus: number;
  /** Function that simulates polling — returns latest revision on each call */
  pollFn: () => Promise<Revision | null>;
  /** Called when retry button is clicked */
  onRetry: () => void;
}

function PollingHarness({ itemName, mutationStatus, pollFn, onRetry }: PollingHarnessProps) {
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [completedRevision, setCompletedRevision] = useState<Revision | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failureCountRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    failureCountRef.current = 0;
    pollingRef.current = setInterval(async () => {
      try {
        const latest = await pollFn();
        failureCountRef.current = 0;
        if (latest?.status === 'complete') {
          stopPolling();
          setGenerating(false);
          setCompletedRevision(latest);
        } else if (latest?.status === 'failed') {
          stopPolling();
          setGenerating(false);
          setGenerateError(labels.revision.generateError);
        }
      } catch {
        failureCountRef.current += 1;
        if (failureCountRef.current >= 10) {
          stopPolling();
          setGenerating(false);
          setGenerateError(labels.revision.generateError);
        }
      }
    }, 3000);
  }, [pollFn, stopPolling]);

  // Simulate mutation success triggering generating state
  useEffect(() => {
    if (mutationStatus === 202) {
      setGenerating(true);
      setGenerateError('');
      startPolling();
    }
    return () => stopPolling();
  }, [mutationStatus, startPolling, stopPolling]);

  if (generating) {
    return createElement(GeneratingOverlayHarness, { itemName });
  }

  if (generateError) {
    return createElement('div', { 'aria-live': 'polite', 'data-testid': 'error-region' },
      createElement('p', { 'data-testid': 'error-text' }, generateError),
      createElement('button', {
        type: 'button',
        'data-testid': 'retry-button',
        onClick: onRetry,
      }, labels.revision.retryButton),
    );
  }

  if (completedRevision) {
    return createElement('div', { 'data-testid': 'side-by-side-view' },
      createElement('div', { 'data-testid': 'original-pane' }, labels.revision.originalPaneLabel),
      createElement('div', { 'data-testid': 'revision-pane' },
        labels.revision.revisionPaneLabel.replace('{number}', String(completedRevision.revisionNumber)),
      ),
    );
  }

  return createElement('div', { 'data-testid': 'idle-state' }, 'No revision in progress');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GeneratingOverlay renders on 202 response', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows GeneratingOverlay when mutation returns 202', () => {
    const pollFn = vi.fn().mockResolvedValue({ revisionId: 'rev-1', status: 'generating', revisionNumber: 1, createdAt: new Date().toISOString() });

    const { unmount } = render(createElement(PollingHarness, {
      itemName: 'Test Document',
      mutationStatus: 202,
      pollFn,
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('generating-overlay')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(labels.revision.generatingCaption.replace('{itemName}', 'Test Document'))).toBeInTheDocument();

    unmount();
  });

  it('does not show overlay when mutation status is not 202', () => {
    const { unmount } = render(createElement(PollingHarness, {
      itemName: 'Test Document',
      mutationStatus: 0,
      pollFn: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.queryByTestId('generating-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('idle-state')).toBeInTheDocument();

    unmount();
  });
});

describe('Polling starts at 3s intervals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at 3-second intervals after 202 response', async () => {
    const pollFn = vi.fn().mockResolvedValue({
      revisionId: 'rev-1', status: 'generating', revisionNumber: 1, createdAt: new Date().toISOString(),
    });

    const { unmount } = render(createElement(PollingHarness, {
      itemName: 'Test Document',
      mutationStatus: 202,
      pollFn,
      onRetry: vi.fn(),
    }));

    // No poll yet at t=0
    expect(pollFn).not.toHaveBeenCalled();

    // Advance 3 seconds — first poll
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pollFn).toHaveBeenCalledTimes(1);

    // Advance another 3 seconds — second poll
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pollFn).toHaveBeenCalledTimes(2);

    // Advance another 3 seconds — third poll
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pollFn).toHaveBeenCalledTimes(3);

    unmount();
  });
});

describe('Polling stops on complete status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling and shows side-by-side view when status is complete', async () => {
    const pollFn = vi.fn()
      .mockResolvedValueOnce({ revisionId: 'rev-1', status: 'generating', revisionNumber: 1, createdAt: new Date().toISOString() })
      .mockResolvedValueOnce({ revisionId: 'rev-1', status: 'complete', revisionNumber: 1, createdAt: new Date().toISOString(), documentUrl: 'https://example.com/doc', originalUrl: 'https://example.com/orig' });

    const { unmount } = render(createElement(PollingHarness, {
      itemName: 'Test Document',
      mutationStatus: 202,
      pollFn,
      onRetry: vi.fn(),
    }));

    // Initially showing overlay
    expect(screen.getByTestId('generating-overlay')).toBeInTheDocument();

    // First poll — still generating
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('generating-overlay')).toBeInTheDocument();

    // Second poll — complete
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByTestId('generating-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('side-by-side-view')).toBeInTheDocument();
    expect(screen.getByTestId('original-pane')).toBeInTheDocument();
    expect(screen.getByTestId('revision-pane')).toBeInTheDocument();

    // No more polls after completion
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pollFn).toHaveBeenCalledTimes(2);

    unmount();
  });
});

describe('Polling stops on failed status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling and shows error with retry button when status is failed', async () => {
    const pollFn = vi.fn()
      .mockResolvedValueOnce({ revisionId: 'rev-1', status: 'generating', revisionNumber: 1, createdAt: new Date().toISOString() })
      .mockResolvedValueOnce({ revisionId: 'rev-1', status: 'failed', revisionNumber: 1, createdAt: new Date().toISOString() });

    const onRetry = vi.fn();

    const { unmount } = render(createElement(PollingHarness, {
      itemName: 'Test Document',
      mutationStatus: 202,
      pollFn,
      onRetry,
    }));

    // Initially showing overlay
    expect(screen.getByTestId('generating-overlay')).toBeInTheDocument();

    // First poll — still generating
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('generating-overlay')).toBeInTheDocument();

    // Second poll — failed
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByTestId('generating-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('error-region')).toBeInTheDocument();
    expect(screen.getByTestId('error-text')).toHaveTextContent(labels.revision.generateError);
    expect(screen.getByTestId('retry-button')).toBeInTheDocument();

    // No more polls after failure
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(pollFn).toHaveBeenCalledTimes(2);

    unmount();
  });
});
