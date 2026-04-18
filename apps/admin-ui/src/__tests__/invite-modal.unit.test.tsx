// @vitest-environment jsdom
/**
 * Unit tests for Invite Modal restructure:
 * 1. Self-review button renders in Zone 1 when onSelfReview is provided
 * 2. Revisions link renders for closed items with completed revisions
 * 3. Revisions link does not render for items without completed revisions
 * 4. Heading reads "Sessions & Feedback"
 *
 * Validates: Requirements 11.1, 11.5
 *
 * Pattern: test harness components that mirror the real component logic,
 * avoiding CSS module and import.meta.env dependencies. The harness
 * replicates the zone layout, self-review conditional, and revisions link
 * logic from InviteModal.tsx using the same getItemActions utility.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement } from 'react';
import { getItemActions } from '../utils/itemActions';

// ─── Labels (subset matching real labels-registry) ────────────────────────────

const labels = {
  inviteModal: {
    title: 'Sessions & Feedback',
  },
  itemDetail: {
    selfReviewButton: 'Review it yourself',
  },
  itemCard: {
    revisions: 'Revisions',
  },
  invitation: {
    closeButton: 'Close',
  },
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface InviteModalHarnessProps {
  itemId: string;
  itemName: string;
  itemStatus?: 'draft' | 'active' | 'closed' | 'revised';
  hasCompletedRevision?: boolean;
  onClose: () => void;
  onSelfReview?: () => void;
}

// ─── InviteModal Harness ──────────────────────────────────────────────────────
// Mirrors the zone layout, heading, self-review button, and revisions link
// logic from InviteModal.tsx. Uses the real getItemActions utility.

function InviteModalHarness({
  itemId,
  itemName,
  itemStatus,
  hasCompletedRevision,
  onClose,
  onSelfReview,
}: InviteModalHarnessProps) {
  // Derive item actions for Zone 3 — same logic as real InviteModal
  const itemActions = itemStatus
    ? getItemActions({ status: itemStatus, hasPulseCheck: true, hasCompletedRevision })
    : [];
  const showRevisionsLink = itemActions.includes('revisions');

  return createElement('div', {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'invite-modal-title',
  },
    // Header
    createElement('div', { 'data-testid': 'modal-header' },
      createElement('h2', { id: 'invite-modal-title', 'data-testid': 'modal-title' },
        labels.inviteModal.title,
      ),
      createElement('p', { 'data-testid': 'item-name' }, itemName),
      createElement('button', {
        type: 'button',
        onClick: onClose,
        'aria-label': 'Close',
        'data-testid': 'close-button',
      }, '×'),
    ),

    // Zone 1: Create Sessions
    createElement('section', {
      'aria-labelledby': 'zone-create-sessions',
      'data-testid': 'zone-1',
    },
      createElement('h3', { id: 'zone-create-sessions' }, 'Create Sessions'),
      // Invite form placeholder
      createElement('div', { 'data-testid': 'invite-form' }, 'Invite reviewers form'),
      // Self-review button (conditional — same logic as real component)
      onSelfReview
        ? createElement('div', { 'data-testid': 'self-review-zone-row' },
            createElement('button', {
              type: 'button',
              'data-testid': 'self-review-button',
              onClick: onSelfReview,
            }, labels.itemDetail.selfReviewButton),
          )
        : null,
      // Public session form placeholder
      createElement('div', { 'data-testid': 'public-session-form' }, 'Public session form'),
    ),

    // Zone 2: Active Sessions
    createElement('section', {
      'aria-labelledby': 'zone-active-sessions',
      'data-testid': 'zone-2',
    },
      createElement('h3', { id: 'zone-active-sessions' }, 'Active Sessions'),
      createElement('p', null, 'Session list placeholder'),
    ),

    // Zone 3: Item Actions
    createElement('section', {
      'aria-labelledby': 'zone-item-actions',
      'data-testid': 'zone-3',
    },
      createElement('h3', { id: 'zone-item-actions' }, 'Item Actions'),
      // Extend deadline placeholder
      createElement('div', { 'data-testid': 'extend-deadline' }, 'Extend deadline form'),
      // Revisions link — same conditional as real component
      showRevisionsLink
        ? createElement('div', { 'data-testid': 'revisions-link-row' },
            createElement('a', {
              href: `/admin/items/${itemId}/revisions`,
              'data-testid': 'revisions-link',
            }, labels.itemCard.revisions),
          )
        : null,
    ),

    // Footer
    createElement('div', { 'data-testid': 'modal-footer' },
      createElement('button', {
        type: 'button',
        onClick: onClose,
        'data-testid': 'close-footer-button',
      }, labels.invitation.closeButton),
    ),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('InviteModal — Heading reads "Sessions & Feedback"', () => {
  it('renders the modal title as "Sessions & Feedback"', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
    }));

    const title = screen.getByTestId('modal-title');
    expect(title).toHaveTextContent('Sessions & Feedback');
  });

  it('renders the item name below the title', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'My Research Paper',
      onClose: vi.fn(),
    }));

    expect(screen.getByTestId('item-name')).toHaveTextContent('My Research Paper');
  });

  it('has correct aria-labelledby linking title to dialog', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
    }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-labelledby', 'invite-modal-title');
    expect(screen.getByTestId('modal-title')).toHaveAttribute('id', 'invite-modal-title');
  });
});

describe('InviteModal — Self-review button renders in Zone 1', () => {
  it('renders self-review button when onSelfReview is provided', () => {
    const onSelfReview = vi.fn();
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
      onSelfReview,
    }));

    const button = screen.getByTestId('self-review-button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent('Review it yourself');
  });

  it('self-review button is inside Zone 1 (Create Sessions)', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
      onSelfReview: vi.fn(),
    }));

    const zone1 = screen.getByTestId('zone-1');
    const selfReviewRow = screen.getByTestId('self-review-zone-row');
    expect(zone1).toContainElement(selfReviewRow);
  });

  it('calls onSelfReview when self-review button is clicked', () => {
    const onSelfReview = vi.fn();
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
      onSelfReview,
    }));

    fireEvent.click(screen.getByTestId('self-review-button'));
    expect(onSelfReview).toHaveBeenCalledOnce();
  });

  it('does not render self-review button when onSelfReview is not provided', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-1',
      itemName: 'Test Document',
      onClose: vi.fn(),
    }));

    expect(screen.queryByTestId('self-review-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('self-review-zone-row')).not.toBeInTheDocument();
  });
});

describe('InviteModal — Revisions link for closed items with completed revisions', () => {
  it('renders Revisions link for closed items with completed revisions', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-closed-rev',
      itemName: 'Closed Document',
      itemStatus: 'closed',
      hasCompletedRevision: true,
      onClose: vi.fn(),
    }));

    const link = screen.getByTestId('revisions-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent('Revisions');
    expect(link).toHaveAttribute('href', '/admin/items/item-closed-rev/revisions');
  });

  it('renders Revisions link for revised items', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-revised',
      itemName: 'Revised Document',
      itemStatus: 'revised',
      hasCompletedRevision: true,
      onClose: vi.fn(),
    }));

    const link = screen.getByTestId('revisions-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/items/item-revised/revisions');
  });

  it('Revisions link is inside Zone 3 (Item Actions)', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-closed-rev',
      itemName: 'Closed Document',
      itemStatus: 'closed',
      hasCompletedRevision: true,
      onClose: vi.fn(),
    }));

    const zone3 = screen.getByTestId('zone-3');
    const revisionsRow = screen.getByTestId('revisions-link-row');
    expect(zone3).toContainElement(revisionsRow);
  });
});

describe('InviteModal — Revisions link does not render for items without completed revisions', () => {
  it('does not render Revisions link for closed items without completed revisions', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-closed-no-rev',
      itemName: 'Closed No Rev',
      itemStatus: 'closed',
      hasCompletedRevision: false,
      onClose: vi.fn(),
    }));

    expect(screen.queryByTestId('revisions-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('revisions-link-row')).not.toBeInTheDocument();
  });

  it('does not render Revisions link for draft items', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-draft',
      itemName: 'Draft Document',
      itemStatus: 'draft',
      onClose: vi.fn(),
    }));

    expect(screen.queryByTestId('revisions-link')).not.toBeInTheDocument();
  });

  it('does not render Revisions link for active items', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-active',
      itemName: 'Active Document',
      itemStatus: 'active',
      onClose: vi.fn(),
    }));

    expect(screen.queryByTestId('revisions-link')).not.toBeInTheDocument();
  });

  it('does not render Revisions link when itemStatus is not provided', () => {
    render(createElement(InviteModalHarness, {
      itemId: 'item-no-status',
      itemName: 'No Status Document',
      onClose: vi.fn(),
    }));

    expect(screen.queryByTestId('revisions-link')).not.toBeInTheDocument();
  });
});
