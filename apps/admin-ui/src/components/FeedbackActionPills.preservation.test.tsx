// @vitest-environment jsdom
/**
 * Preservation Property Tests — Property 2: Non-Adjust Actions Unchanged
 *
 * These tests verify that Accept, Dismiss, and null actions continue to behave
 * exactly as they do today — no textarea, no tenantNote in payloads, and batch
 * actions remain unaffected.
 *
 * Written BEFORE implementing the fix. All tests MUST PASS on unfixed code.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.7**
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import fc from 'fast-check';
import FeedbackActionPills, { type FeedbackAction } from './FeedbackActionPills';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Mirrors the actionToApi mapping from PulseCheck.handleSaveDecisions */
const actionToApi: Record<string, string> = {
  accept: 'Accept',
  adjust: 'Revise',
  dismiss: 'Override',
};

/**
 * Builds a save payload the same way PulseCheck.handleSaveDecisions does
 * on UNFIXED code — no tenantNote is ever included.
 */
function buildSavePayload(
  decisions: Record<string, FeedbackAction>,
): Record<string, { action: string; tenantNote?: string }> {
  const payload: Record<string, { action: string; tenantNote?: string }> = {};
  for (const [revisionId, action] of Object.entries(decisions)) {
    if (action !== null) {
      payload[revisionId] = {
        action: actionToApi[action] ?? action.charAt(0).toUpperCase() + action.slice(1),
      };
    }
  }
  return payload;
}

// ── Observation Tests ──────────────────────────────────────────────────────────

describe('Property 2: Preservation — Non-Adjust Actions Unchanged', () => {
  describe('Observation: no textarea for non-adjust actions', () => {
    it('value="accept" — no textarea in DOM', () => {
      const { container } = render(
        <FeedbackActionPills value="accept" onChange={vi.fn()} />,
      );
      expect(container.querySelector('textarea')).toBeNull();
    });

    it('value="dismiss" — no textarea in DOM', () => {
      const { container } = render(
        <FeedbackActionPills value="dismiss" onChange={vi.fn()} />,
      );
      expect(container.querySelector('textarea')).toBeNull();
    });

    it('value=null — no textarea in DOM', () => {
      const { container } = render(
        <FeedbackActionPills value={null} onChange={vi.fn()} />,
      );
      expect(container.querySelector('textarea')).toBeNull();
    });
  });

  describe('Observation: click active pill to deselect calls onChange(null)', () => {
    it('clicking the active Accept pill calls onChange with null', () => {
      const onChange = vi.fn();
      const { container } = render(
        <FeedbackActionPills value="accept" onChange={onChange} />,
      );
      const acceptButton = container.querySelector('button[aria-pressed="true"]');
      expect(acceptButton).not.toBeNull();
      fireEvent.click(acceptButton!);
      expect(onChange).toHaveBeenCalledWith(null);
    });

    it('clicking the active Dismiss pill calls onChange with null', () => {
      const onChange = vi.fn();
      const { container } = render(
        <FeedbackActionPills value="dismiss" onChange={onChange} />,
      );
      const dismissButton = container.querySelector('button[aria-pressed="true"]');
      expect(dismissButton).not.toBeNull();
      fireEvent.click(dismissButton!);
      expect(onChange).toHaveBeenCalledWith(null);
    });
  });

  // ── Property-Based Tests ───────────────────────────────────────────────────

  describe('PBT: no textarea for any non-adjust action', () => {
    /**
     * Property: for all actions in ['accept', 'dismiss', null], rendering
     * FeedbackActionPills produces no textarea element.
     *
     * **Validates: Requirements 3.1, 3.2, 3.3**
     */
    it('PBT: rendering with any non-adjust action never produces a textarea', () => {
      const nonAdjustActions: FeedbackAction[] = ['accept', 'dismiss', null];

      fc.assert(
        fc.property(
          fc.constantFrom(...nonAdjustActions),
          (action) => {
            const { container, unmount } = render(
              <FeedbackActionPills value={action} onChange={vi.fn()} />,
            );
            const textarea = container.querySelector('textarea');
            expect(textarea).toBeNull();
            unmount();
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe('PBT: save payload for non-adjust actions never includes tenantNote', () => {
    /**
     * Property: for all non-adjust actions across N revisions, the save payload
     * never includes a tenantNote property.
     *
     * **Validates: Requirements 3.4**
     */
    it('PBT: payload for non-adjust decisions never contains tenantNote', () => {
      const nonAdjustActionArb = fc.constantFrom<FeedbackAction>('accept', 'dismiss');

      fc.assert(
        fc.property(
          // Generate 1–10 revisions, each with a non-adjust action
          fc.array(
            fc.tuple(
              fc.uuid(),
              nonAdjustActionArb,
            ),
            { minLength: 1, maxLength: 10 },
          ),
          (revisionEntries) => {
            const decisions: Record<string, FeedbackAction> = {};
            for (const [id, action] of revisionEntries) {
              decisions[id] = action;
            }

            const payload = buildSavePayload(decisions);

            for (const [revisionId, entry] of Object.entries(payload)) {
              expect(entry).not.toHaveProperty('tenantNote');
              // Also verify the action mapping is correct
              const originalAction = decisions[revisionId];
              if (originalAction === 'accept') {
                expect(entry.action).toBe('Accept');
              } else if (originalAction === 'dismiss') {
                expect(entry.action).toBe('Override');
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Batch Accept All / Dismiss All does not introduce tenantNote', () => {
    /**
     * Test: batch Accept All / Dismiss All does not introduce tenantNote fields
     * in the payload.
     *
     * Simulates the batch action logic from PulseCheck.handleBatchAccept and
     * handleBatchDismiss, then builds the save payload and verifies no tenantNote.
     *
     * **Validates: Requirements 3.7**
     */
    it('batch Accept All produces payload without tenantNote', () => {
      const revisionIds = ['rev-1', 'rev-2', 'rev-3', 'rev-4'];

      // Simulate handleBatchAccept: set all revisions to 'accept'
      const decisions: Record<string, FeedbackAction> = {};
      for (const id of revisionIds) {
        decisions[id] = 'accept';
      }

      const payload = buildSavePayload(decisions);

      expect(Object.keys(payload)).toHaveLength(4);
      for (const entry of Object.values(payload)) {
        expect(entry.action).toBe('Accept');
        expect(entry).not.toHaveProperty('tenantNote');
      }
    });

    it('batch Dismiss All produces payload without tenantNote', () => {
      const revisionIds = ['rev-1', 'rev-2', 'rev-3', 'rev-4'];

      // Simulate handleBatchDismiss: set all revisions to 'dismiss'
      const decisions: Record<string, FeedbackAction> = {};
      for (const id of revisionIds) {
        decisions[id] = 'dismiss';
      }

      const payload = buildSavePayload(decisions);

      expect(Object.keys(payload)).toHaveLength(4);
      for (const entry of Object.values(payload)) {
        expect(entry.action).toBe('Override');
        expect(entry).not.toHaveProperty('tenantNote');
      }
    });

    it('PBT: batch actions across random revision sets never produce tenantNote', () => {
      fc.assert(
        fc.property(
          // Random number of revision IDs
          fc.array(fc.uuid(), { minLength: 1, maxLength: 20 }),
          // Batch action is either accept or dismiss
          fc.constantFrom<'accept' | 'dismiss'>('accept', 'dismiss'),
          (revisionIds, batchAction) => {
            // Simulate batch action: set all revisions to the batch action
            const decisions: Record<string, FeedbackAction> = {};
            for (const id of revisionIds) {
              decisions[id] = batchAction;
            }

            const payload = buildSavePayload(decisions);

            const expectedApiAction = batchAction === 'accept' ? 'Accept' : 'Override';
            for (const entry of Object.values(payload)) {
              expect(entry.action).toBe(expectedApiAction);
              expect(entry).not.toHaveProperty('tenantNote');
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
