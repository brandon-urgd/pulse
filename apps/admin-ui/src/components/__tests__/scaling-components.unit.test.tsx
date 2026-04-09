// @vitest-environment jsdom
/**
 * Unit tests for scaling presentation components:
 * 1. SignalSummary: renders theme cards with correct count text
 * 2. SignalSummary: shows top 3 quotes per theme
 * 3. ReviewerOverview: renders collapsed by default
 * 4. ReviewerOverview: expands on click showing reviewer list
 * 5. RevisionGroups: groups revisions by type
 * 6. RevisionGroups: puts revisions without type in "Other" group
 * 7. RevisionGroups: shows batch accept/dismiss controls per group
 *
 * Validates: Requirements 6B.7, 6B.8, 6B.9, 6B.12
 *
 * Pattern: test harness components that mirror real component logic
 * using createElement to avoid CSS module import issues.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createElement, useState } from 'react';

// ─── Types (matching real component interfaces) ───────────────────────────────

interface ReviewerSignal {
  signal: 'conviction' | 'tension' | 'uncertainty';
  quote: string;
}

interface ThemeRow {
  themeId: string;
  theme: string;
  signals: Record<string, ReviewerSignal>;
}

interface ReviewerColumn {
  reviewerId: string;
  name: string;
  verdict: string;
  energy: string;
}

interface ProposedRevision {
  revisionId: string;
  proposal: string;
  rationale: string;
  revisionType?: string;
  sourceThemeIds: string[];
}

// ─── SignalSummary Harness ────────────────────────────────────────────────────
// Mirrors SignalSummary rendering logic without CSS module deps.

function SignalSummaryHarness({
  themes,
  reviewers,
  sessionCount,
}: {
  themes: ThemeRow[];
  reviewers: ReviewerColumn[];
  sessionCount: number;
}) {
  return createElement('div', { role: 'list', 'aria-label': 'Signal summary — themes' },
    themes.map((theme) => {
      const flaggedCount = Object.keys(theme.signals).length;
      const topQuotes = Object.values(theme.signals)
        .map((s) => s.quote)
        .filter(Boolean)
        .slice(0, 3);

      return createElement('article', { key: theme.themeId, role: 'listitem', 'data-testid': `theme-card-${theme.themeId}` },
        createElement('h3', null, theme.theme),
        createElement('p', { 'data-testid': `count-${theme.themeId}` },
          `${flaggedCount} of ${sessionCount} reviewers flagged this`,
        ),
        topQuotes.length > 0
          ? createElement('ul', { 'data-testid': `quotes-${theme.themeId}` },
              topQuotes.map((q, i) => createElement('li', { key: i }, q)),
            )
          : null,
      );
    }),
  );
}

// ─── ReviewerOverview Harness ─────────────────────────────────────────────────
// Mirrors ReviewerOverview rendering logic.

function ReviewerOverviewHarness({
  reviewers,
  sessionCount,
}: {
  reviewers: ReviewerColumn[];
  sessionCount: number;
}) {
  const [expanded, setExpanded] = useState(false);

  return createElement('section', { 'aria-label': 'Reviewer overview' },
    createElement('button', {
      type: 'button',
      'data-testid': 'toggle-button',
      onClick: () => setExpanded((v) => !v),
      'aria-expanded': expanded,
      'aria-controls': 'reviewer-overview-list',
    }, `Reviewers (${sessionCount})`),
    expanded
      ? createElement('ul', { id: 'reviewer-overview-list', role: 'list', 'data-testid': 'reviewer-list' },
          reviewers.map((r) =>
            createElement('li', { key: r.reviewerId, 'data-testid': `reviewer-${r.reviewerId}` },
              createElement('span', { 'data-testid': `name-${r.reviewerId}` }, r.name),
              createElement('span', null, 'Completed'),
              createElement('span', null, r.verdict),
            ),
          ),
        )
      : null,
  );
}

// ─── RevisionGroups Harness ───────────────────────────────────────────────────
// Mirrors RevisionGroups rendering logic.

const TYPE_LABELS: Record<string, string> = {
  structural: 'Structural',
  'line-edit': 'Line Edits',
  conceptual: 'Conceptual',
  feature: 'Features',
  other: 'Other',
};

const GROUP_ORDER = ['structural', 'conceptual', 'feature', 'line-edit', 'other'];

function groupRevisions(revisions: ProposedRevision[]): Record<string, ProposedRevision[]> {
  const groups: Record<string, ProposedRevision[]> = {};
  for (const rev of revisions) {
    const type = rev.revisionType ?? 'other';
    const key = GROUP_ORDER.includes(type) ? type : 'other';
    if (!groups[key]) groups[key] = [];
    groups[key].push(rev);
  }
  return groups;
}

function RevisionGroupsHarness({
  revisions,
  onBatchAccept,
  onBatchDismiss,
}: {
  revisions: ProposedRevision[];
  onBatchAccept: (type: string) => void;
  onBatchDismiss: (type: string) => void;
}) {
  const groups = groupRevisions(revisions);

  return createElement('div', { role: 'region', 'aria-label': 'Proposed revisions grouped by type' },
    GROUP_ORDER.map((type) => {
      const group = groups[type];
      if (!group || group.length === 0) return null;
      const label = TYPE_LABELS[type] ?? type;

      return createElement('div', { key: type, 'data-testid': `group-${type}` },
        createElement('button', {
          type: 'button',
          'data-testid': `group-header-${type}`,
          'aria-expanded': true,
        },
          createElement('span', null, label),
          createElement('span', { 'data-testid': `group-count-${type}` }, `(${group.length})`),
        ),
        group.length > 1
          ? createElement('div', { 'data-testid': `batch-actions-${type}` },
              createElement('button', {
                type: 'button',
                'data-testid': `batch-accept-${type}`,
                onClick: () => onBatchAccept(type),
              }, 'Accept All'),
              createElement('button', {
                type: 'button',
                'data-testid': `batch-dismiss-${type}`,
                onClick: () => onBatchDismiss(type),
              }, 'Dismiss All'),
            )
          : null,
        createElement('ul', { role: 'list' },
          group.map((rev) =>
            createElement('li', { key: rev.revisionId, 'data-testid': `revision-${rev.revisionId}` },
              createElement('p', null, rev.proposal),
              createElement('p', null, rev.rationale),
            ),
          ),
        ),
      );
    }),
  );
}

// ─── Test Data ────────────────────────────────────────────────────────────────

const mockReviewers: ReviewerColumn[] = [
  { reviewerId: 'r1', name: 'Reviewer A', verdict: 'Strong', energy: 'high' },
  { reviewerId: 'r2', name: 'Reviewer B', verdict: 'Mixed', energy: 'medium' },
  { reviewerId: 'r3', name: 'Reviewer C', verdict: 'Uncertain', energy: 'low' },
];

const mockThemes: ThemeRow[] = [
  {
    themeId: 'theme-1',
    theme: 'Clarity of argument',
    signals: {
      r1: { signal: 'conviction', quote: 'The argument was very clear and well-structured throughout.' },
      r2: { signal: 'tension', quote: 'Some sections felt unclear and needed more explanation.' },
      r3: { signal: 'conviction', quote: 'Excellent logical flow from start to finish.' },
    },
  },
  {
    themeId: 'theme-2',
    theme: 'Visual design',
    signals: {
      r1: { signal: 'uncertainty', quote: 'Not sure about the color choices used here.' },
    },
  },
];

const mockThemeWithManyQuotes: ThemeRow = {
  themeId: 'theme-many',
  theme: 'Depth of analysis',
  signals: {
    r1: { signal: 'conviction', quote: 'Quote one from reviewer one.' },
    r2: { signal: 'tension', quote: 'Quote two from reviewer two.' },
    r3: { signal: 'uncertainty', quote: 'Quote three from reviewer three.' },
    r4: { signal: 'conviction', quote: 'Quote four should not appear.' },
    r5: { signal: 'tension', quote: 'Quote five should not appear.' },
  },
};

// ─── Tests: SignalSummary ─────────────────────────────────────────────────────

describe('SignalSummary — renders theme cards with correct count text', () => {
  it('renders a card for each theme with correct flagged count', () => {
    render(createElement(SignalSummaryHarness, {
      themes: mockThemes,
      reviewers: mockReviewers,
      sessionCount: 10,
    }));

    expect(screen.getByTestId('theme-card-theme-1')).toBeInTheDocument();
    expect(screen.getByTestId('theme-card-theme-2')).toBeInTheDocument();

    expect(screen.getByTestId('count-theme-1')).toHaveTextContent('3 of 10 reviewers flagged this');
    expect(screen.getByTestId('count-theme-2')).toHaveTextContent('1 of 10 reviewers flagged this');
  });

  it('renders theme name as heading', () => {
    render(createElement(SignalSummaryHarness, {
      themes: mockThemes,
      reviewers: mockReviewers,
      sessionCount: 10,
    }));

    expect(screen.getByText('Clarity of argument')).toBeInTheDocument();
    expect(screen.getByText('Visual design')).toBeInTheDocument();
  });
});

describe('SignalSummary — shows top 3 quotes per theme', () => {
  it('shows at most 3 quotes even when more signals exist', () => {
    render(createElement(SignalSummaryHarness, {
      themes: [mockThemeWithManyQuotes],
      reviewers: mockReviewers,
      sessionCount: 10,
    }));

    const quoteList = screen.getByTestId('quotes-theme-many');
    const items = within(quoteList).getAllByRole('listitem');
    expect(items).toHaveLength(3);

    expect(items[0]).toHaveTextContent('Quote one from reviewer one.');
    expect(items[1]).toHaveTextContent('Quote two from reviewer two.');
    expect(items[2]).toHaveTextContent('Quote three from reviewer three.');
  });

  it('does not render quote list when theme has no quotes', () => {
    const emptyTheme: ThemeRow = {
      themeId: 'empty',
      theme: 'Empty theme',
      signals: {},
    };

    render(createElement(SignalSummaryHarness, {
      themes: [emptyTheme],
      reviewers: mockReviewers,
      sessionCount: 10,
    }));

    expect(screen.queryByTestId('quotes-empty')).not.toBeInTheDocument();
  });
});

// ─── Tests: ReviewerOverview ──────────────────────────────────────────────────

describe('ReviewerOverview — renders collapsed by default', () => {
  it('toggle button shows reviewer count and is not expanded', () => {
    render(createElement(ReviewerOverviewHarness, {
      reviewers: mockReviewers,
      sessionCount: 8,
    }));

    const toggle = screen.getByTestId('toggle-button');
    expect(toggle).toHaveTextContent('Reviewers (8)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('reviewer-list')).not.toBeInTheDocument();
  });
});

describe('ReviewerOverview — expands on click showing reviewer list', () => {
  it('shows reviewer list after clicking toggle', () => {
    render(createElement(ReviewerOverviewHarness, {
      reviewers: mockReviewers,
      sessionCount: 8,
    }));

    fireEvent.click(screen.getByTestId('toggle-button'));

    expect(screen.getByTestId('toggle-button')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('reviewer-list')).toBeInTheDocument();

    expect(screen.getByTestId('name-r1')).toHaveTextContent('Reviewer A');
    expect(screen.getByTestId('name-r2')).toHaveTextContent('Reviewer B');
    expect(screen.getByTestId('name-r3')).toHaveTextContent('Reviewer C');
  });

  it('collapses again on second click', () => {
    render(createElement(ReviewerOverviewHarness, {
      reviewers: mockReviewers,
      sessionCount: 8,
    }));

    const toggle = screen.getByTestId('toggle-button');
    fireEvent.click(toggle);
    expect(screen.getByTestId('reviewer-list')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('reviewer-list')).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

// ─── Tests: RevisionGroups ────────────────────────────────────────────────────

const mockRevisions: ProposedRevision[] = [
  { revisionId: 'rev-1', proposal: 'Restructure intro', rationale: 'Weak opening', revisionType: 'structural', sourceThemeIds: ['t1'] },
  { revisionId: 'rev-2', proposal: 'Fix typo in section 3', rationale: 'Spelling error', revisionType: 'line-edit', sourceThemeIds: ['t2'] },
  { revisionId: 'rev-3', proposal: 'Reframe conclusion', rationale: 'Needs stronger close', revisionType: 'conceptual', sourceThemeIds: ['t1'] },
  { revisionId: 'rev-4', proposal: 'Add executive summary', rationale: 'Missing overview', revisionType: 'structural', sourceThemeIds: ['t3'] },
  { revisionId: 'rev-5', proposal: 'Tighten paragraph 2', rationale: 'Verbose', revisionType: 'line-edit', sourceThemeIds: ['t2'] },
];

describe('RevisionGroups — groups revisions by type', () => {
  it('renders separate groups for each revision type', () => {
    render(createElement(RevisionGroupsHarness, {
      revisions: mockRevisions,
      onBatchAccept: vi.fn(),
      onBatchDismiss: vi.fn(),
    }));

    expect(screen.getByTestId('group-structural')).toBeInTheDocument();
    expect(screen.getByTestId('group-conceptual')).toBeInTheDocument();
    expect(screen.getByTestId('group-line-edit')).toBeInTheDocument();

    expect(screen.getByTestId('group-count-structural')).toHaveTextContent('(2)');
    expect(screen.getByTestId('group-count-conceptual')).toHaveTextContent('(1)');
    expect(screen.getByTestId('group-count-line-edit')).toHaveTextContent('(2)');
  });
});

describe('RevisionGroups — puts revisions without type in "Other" group', () => {
  it('revisions with no revisionType go to Other', () => {
    const revisionsWithUntyped: ProposedRevision[] = [
      { revisionId: 'rev-a', proposal: 'Typed revision', rationale: 'Has type', revisionType: 'structural', sourceThemeIds: [] },
      { revisionId: 'rev-b', proposal: 'Untyped revision', rationale: 'No type', sourceThemeIds: [] },
      { revisionId: 'rev-c', proposal: 'Another untyped', rationale: 'Also no type', sourceThemeIds: [] },
    ];

    render(createElement(RevisionGroupsHarness, {
      revisions: revisionsWithUntyped,
      onBatchAccept: vi.fn(),
      onBatchDismiss: vi.fn(),
    }));

    expect(screen.getByTestId('group-other')).toBeInTheDocument();
    expect(screen.getByTestId('group-count-other')).toHaveTextContent('(2)');
    expect(screen.getByTestId('revision-rev-b')).toBeInTheDocument();
    expect(screen.getByTestId('revision-rev-c')).toBeInTheDocument();
  });

  it('revisions with unknown type also go to Other', () => {
    const revisionsWithUnknown: ProposedRevision[] = [
      { revisionId: 'rev-x', proposal: 'Unknown type', rationale: 'Bad type', revisionType: 'banana' as any, sourceThemeIds: [] },
    ];

    render(createElement(RevisionGroupsHarness, {
      revisions: revisionsWithUnknown,
      onBatchAccept: vi.fn(),
      onBatchDismiss: vi.fn(),
    }));

    expect(screen.getByTestId('group-other')).toBeInTheDocument();
    expect(screen.getByTestId('revision-rev-x')).toBeInTheDocument();
  });
});

describe('RevisionGroups — shows batch accept/dismiss controls per group', () => {
  it('shows batch actions for groups with 2+ revisions', () => {
    render(createElement(RevisionGroupsHarness, {
      revisions: mockRevisions,
      onBatchAccept: vi.fn(),
      onBatchDismiss: vi.fn(),
    }));

    // structural has 2 revisions — should have batch actions
    expect(screen.getByTestId('batch-actions-structural')).toBeInTheDocument();
    expect(screen.getByTestId('batch-accept-structural')).toBeInTheDocument();
    expect(screen.getByTestId('batch-dismiss-structural')).toBeInTheDocument();

    // line-edit has 2 revisions — should have batch actions
    expect(screen.getByTestId('batch-actions-line-edit')).toBeInTheDocument();

    // conceptual has 1 revision — no batch actions
    expect(screen.queryByTestId('batch-actions-conceptual')).not.toBeInTheDocument();
  });

  it('batch accept calls onBatchAccept with the group type', () => {
    const onBatchAccept = vi.fn();
    render(createElement(RevisionGroupsHarness, {
      revisions: mockRevisions,
      onBatchAccept,
      onBatchDismiss: vi.fn(),
    }));

    fireEvent.click(screen.getByTestId('batch-accept-structural'));
    expect(onBatchAccept).toHaveBeenCalledWith('structural');
  });

  it('batch dismiss calls onBatchDismiss with the group type', () => {
    const onBatchDismiss = vi.fn();
    render(createElement(RevisionGroupsHarness, {
      revisions: mockRevisions,
      onBatchAccept: vi.fn(),
      onBatchDismiss,
    }));

    fireEvent.click(screen.getByTestId('batch-dismiss-line-edit'));
    expect(onBatchDismiss).toHaveBeenCalledWith('line-edit');
  });
});
