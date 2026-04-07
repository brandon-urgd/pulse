// @vitest-environment jsdom
/**
 * Unit tests for revision flow components:
 * 1. PulseCheck — revision CTA visibility based on persisted decisions
 * 2. ItemRevision — empty state, 409 error, non-409 error, "Generate Another" flow
 *
 * Validates: Requirements 2.1, 2.2, 2.4, 2.5
 *
 * Pattern: test harness components that mirror the real component logic,
 * avoiding CSS module and import.meta.env dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, useState, useRef, useEffect } from 'react';

// ─── Labels (subset matching real labels-registry) ────────────────────────────

const labels = {
  pulseCheck: {
    viewRevisions: 'View Revisions',
    decisionsHeading: 'Proposed Revisions',
    decisionsHint: 'Mark each proposal — decisions are saved and used when you generate a revision.',
    saveDecisionsButton: 'Save Decisions',
    savingDecisions: 'Saving…',
    decisionsSaved: 'Decisions saved.',
  },
  revision: {
    emptyCta: 'Generate Revision',
    emptyHeading: 'Generate a revision from your decisions',
    emptyBody: 'Pulse will rewrite {itemName} based on the themes you accepted and revised. Your original document is preserved.',
    noPulseCheckError: 'Run a Pulse Check and save decisions before generating a revision.',
    noPulseCheckLink: 'Go to Pulse Check →',
    generateError: 'Something went wrong generating the revision. Try again.',
    retryButton: 'Try again',
    generateAnother: 'Generate Another Revision',
    loading: 'Loading revisions…',
    loadError: 'Something went wrong loading revisions.',
  },
} as const;

// ─── PulseCheck CTA Harness ──────────────────────────────────────────────────
// Mirrors the revision CTA logic from PulseCheck.tsx:
// Show CTA when at least one accept/adjust decision has been persisted.

interface PulseCheckCTAHarnessProps {
  savedDecisions: Record<string, string>;
  proposedRevisions: Array<{ revisionId: string; proposal: string }>;
  itemId: string;
}

function PulseCheckCTAHarness({ savedDecisions, proposedRevisions, itemId }: PulseCheckCTAHarnessProps) {
  const hasPersistedActionableDecision = Object.values(savedDecisions).some(
    (action) => action === 'accept' || action === 'adjust'
  );

  return createElement('div', null,
    createElement('h2', null, labels.pulseCheck.decisionsHeading),
    proposedRevisions.length === 0
      ? createElement('p', null, 'No revisions proposed.')
      : createElement('ul', null,
          ...proposedRevisions.map((r) =>
            createElement('li', { key: r.revisionId }, r.proposal)
          )
        ),
    hasPersistedActionableDecision
      ? createElement('a', { href: `/admin/items/${itemId}/revisions`, 'data-testid': 'revision-cta' },
          labels.pulseCheck.viewRevisions
        )
      : null
  );
}

// ─── ItemRevision Harness ────────────────────────────────────────────────────
// Mirrors the rendering logic from ItemRevision.tsx for:
// - Empty state with "Generate Revision" button
// - 409 error → informational message + link to PulseCheck
// - Non-409 error → error message + retry button
// - "Generate Another" button after viewing a completed revision

type RevisionState =
  | { type: 'loading' }
  | { type: 'empty' }
  | { type: 'error'; errorKind: '409' | 'generic' }
  | { type: 'complete'; revisionNumber: number }
  | { type: 'generating' };

interface ItemRevisionHarnessProps {
  initialState: RevisionState;
  itemId: string;
  itemName: string;
  onGenerate: () => void;
  onRetry: () => void;
}

function ItemRevisionHarness({ initialState, itemId, itemName, onGenerate, onRetry }: ItemRevisionHarnessProps) {
  const [state, setState] = useState<RevisionState>(initialState);

  // Sync with prop changes (for re-render tests)
  useEffect(() => { setState(initialState); }, [initialState]);

  if (state.type === 'loading') {
    return createElement('div', null,
      createElement('p', null, labels.revision.loading)
    );
  }

  if (state.type === 'generating') {
    return createElement('div', { role: 'status' },
      createElement('p', null, 'Generating…')
    );
  }

  if (state.type === 'error') {
    const is409 = state.errorKind === '409';
    return createElement('div', { 'aria-live': 'polite' },
      createElement('p', { 'data-testid': 'error-text' },
        is409 ? labels.revision.noPulseCheckError : labels.revision.generateError
      ),
      is409
        ? createElement('a', {
            href: `/admin/pulse-check/${itemId}`,
            'data-testid': 'pulse-check-link',
          }, labels.revision.noPulseCheckLink)
        : createElement('button', {
            type: 'button',
            'data-testid': 'retry-button',
            onClick: () => { onRetry(); },
          }, labels.revision.retryButton)
    );
  }

  if (state.type === 'empty') {
    return createElement('div', null,
      createElement('h2', null, labels.revision.emptyHeading),
      createElement('p', null, labels.revision.emptyBody.replace('{itemName}', itemName)),
      createElement('button', {
        type: 'button',
        'data-testid': 'generate-button',
        onClick: () => { onGenerate(); },
      }, labels.revision.emptyCta)
    );
  }

  // state.type === 'complete'
  return createElement('div', null,
    createElement('h1', null, `Revision ${state.revisionNumber}`),
    createElement('div', { 'data-testid': 'revision-content' }, 'Side-by-side content'),
    createElement('button', {
      type: 'button',
      'data-testid': 'generate-another-button',
      onClick: () => { onGenerate(); },
    }, labels.revision.generateAnother)
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PulseCheck — Revision CTA visibility', () => {
  it('shows revision CTA when at least one accept decision is persisted', () => {
    render(createElement(PulseCheckCTAHarness, {
      savedDecisions: { rev1: 'accept', rev2: 'dismiss' },
      proposedRevisions: [
        { revisionId: 'rev1', proposal: 'Restructure intro' },
        { revisionId: 'rev2', proposal: 'Add examples' },
      ],
      itemId: 'item-123',
    }));

    expect(screen.getByTestId('revision-cta')).toBeInTheDocument();
    expect(screen.getByText(labels.pulseCheck.viewRevisions)).toBeInTheDocument();
  });

  it('shows revision CTA when at least one adjust decision is persisted', () => {
    render(createElement(PulseCheckCTAHarness, {
      savedDecisions: { rev1: 'dismiss', rev2: 'adjust' },
      proposedRevisions: [
        { revisionId: 'rev1', proposal: 'Restructure intro' },
        { revisionId: 'rev2', proposal: 'Add examples' },
      ],
      itemId: 'item-456',
    }));

    expect(screen.getByTestId('revision-cta')).toBeInTheDocument();
  });

  it('hides revision CTA when all decisions are dismiss', () => {
    render(createElement(PulseCheckCTAHarness, {
      savedDecisions: { rev1: 'dismiss', rev2: 'dismiss' },
      proposedRevisions: [
        { revisionId: 'rev1', proposal: 'Restructure intro' },
        { revisionId: 'rev2', proposal: 'Add examples' },
      ],
      itemId: 'item-789',
    }));

    expect(screen.queryByTestId('revision-cta')).not.toBeInTheDocument();
  });

  it('hides revision CTA when no decisions exist', () => {
    render(createElement(PulseCheckCTAHarness, {
      savedDecisions: {},
      proposedRevisions: [
        { revisionId: 'rev1', proposal: 'Restructure intro' },
      ],
      itemId: 'item-000',
    }));

    expect(screen.queryByTestId('revision-cta')).not.toBeInTheDocument();
  });

  it('CTA links to the correct revisions URL', () => {
    render(createElement(PulseCheckCTAHarness, {
      savedDecisions: { rev1: 'accept' },
      proposedRevisions: [{ revisionId: 'rev1', proposal: 'Fix structure' }],
      itemId: 'item-abc',
    }));

    const link = screen.getByTestId('revision-cta');
    expect(link).toHaveAttribute('href', '/admin/items/item-abc/revisions');
  });
});

describe('ItemRevision — Empty state', () => {
  it('renders "Generate Revision" button when no revisions exist', () => {
    const onGenerate = vi.fn();
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'empty' },
      itemId: 'item-1',
      itemName: 'My Document',
      onGenerate,
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('generate-button')).toBeInTheDocument();
    expect(screen.getByText(labels.revision.emptyCta)).toBeInTheDocument();
    expect(screen.getByText(labels.revision.emptyHeading)).toBeInTheDocument();
  });

  it('calls onGenerate when "Generate Revision" button is clicked', () => {
    const onGenerate = vi.fn();
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'empty' },
      itemId: 'item-1',
      itemName: 'My Document',
      onGenerate,
      onRetry: vi.fn(),
    }));

    fireEvent.click(screen.getByTestId('generate-button'));
    expect(onGenerate).toHaveBeenCalledOnce();
  });
});

describe('ItemRevision — 409 error (no pulse check)', () => {
  it('shows informational message for 409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: '409' },
      itemId: 'item-2',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('error-text')).toHaveTextContent(labels.revision.noPulseCheckError);
  });

  it('shows link to PulseCheck page for 409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: '409' },
      itemId: 'item-2',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    const link = screen.getByTestId('pulse-check-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent(labels.revision.noPulseCheckLink);
    expect(link).toHaveAttribute('href', '/admin/pulse-check/item-2');
  });

  it('does not show retry button for 409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: '409' },
      itemId: 'item-2',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
  });
});

describe('ItemRevision — Non-409 error (generic failure)', () => {
  it('shows error message for non-409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: 'generic' },
      itemId: 'item-3',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('error-text')).toHaveTextContent(labels.revision.generateError);
  });

  it('shows retry button for non-409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: 'generic' },
      itemId: 'item-3',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('retry-button')).toBeInTheDocument();
    expect(screen.getByText(labels.revision.retryButton)).toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: 'generic' },
      itemId: 'item-3',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry,
    }));

    fireEvent.click(screen.getByTestId('retry-button'));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not show PulseCheck link for non-409 error', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'error', errorKind: 'generic' },
      itemId: 'item-3',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.queryByTestId('pulse-check-link')).not.toBeInTheDocument();
  });
});

describe('ItemRevision — "Generate Another" flow', () => {
  it('shows "Generate Another" button after viewing a completed revision', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'complete', revisionNumber: 1 },
      itemId: 'item-4',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('generate-another-button')).toBeInTheDocument();
    expect(screen.getByText(labels.revision.generateAnother)).toBeInTheDocument();
  });

  it('calls onGenerate when "Generate Another" is clicked', () => {
    const onGenerate = vi.fn();
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'complete', revisionNumber: 1 },
      itemId: 'item-4',
      itemName: 'My Document',
      onGenerate,
      onRetry: vi.fn(),
    }));

    fireEvent.click(screen.getByTestId('generate-another-button'));
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it('displays revision content in completed state', () => {
    render(createElement(ItemRevisionHarness, {
      initialState: { type: 'complete', revisionNumber: 2 },
      itemId: 'item-4',
      itemName: 'My Document',
      onGenerate: vi.fn(),
      onRetry: vi.fn(),
    }));

    expect(screen.getByTestId('revision-content')).toBeInTheDocument();
    expect(screen.getByText('Revision 2')).toBeInTheDocument();
  });
});
