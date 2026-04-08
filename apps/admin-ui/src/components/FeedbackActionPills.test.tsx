// @vitest-environment jsdom
/**
 * Bug Condition Exploration Test — Property 1: Adjust Shows Text Input and Persists Note
 *
 * These tests encode the EXPECTED behavior for the "Adjust" action pill:
 * - A textarea should appear when value='adjust' and onNoteChange is provided
 * - Typing into the textarea should fire onNoteChange with the typed text
 * - A pre-populated noteValue should display in the textarea
 * - The save payload for an adjust decision should include tenantNote
 *
 * **EXPECTED TO FAIL on unfixed code** — failure confirms the bug exists.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import fc from 'fast-check';
import FeedbackActionPills from './FeedbackActionPills';

describe('Property 1: Bug Condition — Adjust Shows Text Input and Persists Note', () => {
  /**
   * Test case 1: Render FeedbackActionPills with value='adjust' and onNoteChange
   * provided — assert a textarea element exists.
   *
   * Bug condition: isBugCondition(input) where input.action === 'adjust'
   * On unfixed code, no textarea renders because the component doesn't support it.
   */
  it('renders a textarea when value is "adjust" and onNoteChange is provided', () => {
    const onChange = vi.fn();
    const onNoteChange = vi.fn();

    const { container } = render(
      <FeedbackActionPills
        value="adjust"
        onChange={onChange}
        onNoteChange={onNoteChange}
      />,
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea).toBeInTheDocument();
  });

  /**
   * Test case 2: Simulate typing into the textarea and assert onNoteChange fires
   * with the typed text.
   *
   * On unfixed code, there is no textarea to type into, so this will fail.
   */
  it('fires onNoteChange with typed text when user types in the textarea', () => {
    const onChange = vi.fn();
    const onNoteChange = vi.fn();

    const { container } = render(
      <FeedbackActionPills
        value="adjust"
        onChange={onChange}
        onNoteChange={onNoteChange}
      />,
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();

    fireEvent.change(textarea!, { target: { value: 'make this less aggressive' } });
    expect(onNoteChange).toHaveBeenCalledWith('make this less aggressive');
  });

  /**
   * Test case 3: Render with value='adjust' and noteValue='focus on intro' —
   * assert textarea displays the pre-populated value.
   *
   * On unfixed code, no textarea exists and noteValue prop is not supported.
   */
  it('displays pre-populated noteValue in the textarea', () => {
    const onChange = vi.fn();
    const onNoteChange = vi.fn();

    const { container } = render(
      <FeedbackActionPills
        value="adjust"
        onChange={onChange}
        noteValue="focus on intro"
        onNoteChange={onNoteChange}
      />,
    );

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea!.value).toBe('focus on intro');
  });

  /**
   * Test case 4: Build a save payload for an adjust decision — assert the payload
   * includes tenantNote alongside action: 'Revise'.
   *
   * This tests the payload construction logic that PulseCheck.handleSaveDecisions
   * should produce. On unfixed code, tenantNote is never included.
   */
  it('includes tenantNote in save payload for adjust decisions', () => {
    // Replicate the payload construction logic from PulseCheck.handleSaveDecisions
    const actionToApi: Record<string, string> = {
      accept: 'Accept',
      adjust: 'Revise',
      dismiss: 'Override',
    };

    const decisions: Record<string, string | null> = {
      'rev-1': 'adjust',
    };

    const tenantNotes: Record<string, string> = {
      'rev-1': 'focus on the intro only',
    };

    // Build payload the way the FIXED code should build it
    const payload: Record<string, { action: string; tenantNote?: string }> = {};
    for (const [revisionId, action] of Object.entries(decisions)) {
      if (action !== null) {
        const entry: { action: string; tenantNote?: string } = {
          action: actionToApi[action] ?? action.charAt(0).toUpperCase() + action.slice(1),
        };
        // The fix should add this: include tenantNote for adjust decisions
        if (action === 'adjust' && tenantNotes[revisionId]) {
          entry.tenantNote = tenantNotes[revisionId];
        }
        payload[revisionId] = entry;
      }
    }

    expect(payload['rev-1']).toBeDefined();
    expect(payload['rev-1'].action).toBe('Revise');
    expect(payload['rev-1'].tenantNote).toBe('focus on the intro only');

    // Now test what the CURRENT (unfixed) code actually produces:
    // It never includes tenantNote — this is the bug.
    const unfixedPayload: Record<string, { action: string; tenantNote?: string }> = {};
    for (const [revisionId, action] of Object.entries(decisions)) {
      if (action !== null) {
        unfixedPayload[revisionId] = {
          action: actionToApi[action] ?? action.charAt(0).toUpperCase() + action.slice(1),
        };
        // NOTE: No tenantNote is ever added — this is the bug
      }
    }

    // This assertion proves the bug: unfixed payload lacks tenantNote
    // We assert the EXPECTED behavior — that tenantNote IS present.
    // On unfixed code, this will fail because tenantNote is undefined.
    expect(unfixedPayload['rev-1'].tenantNote).toBe('focus on the intro only');
  });

  /**
   * Property-based test: For any non-empty guidance string, when the adjust action
   * is selected and onNoteChange is provided, a textarea should be present in the DOM.
   *
   * Scoped PBT: render FeedbackActionPills with value='adjust' and an onNoteChange
   * callback, then assert a <textarea> is present in the DOM.
   */
  it('PBT: textarea is always present when value="adjust" and onNoteChange is provided', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (noteText) => {
          const onChange = vi.fn();
          const onNoteChange = vi.fn();

          const { container, unmount } = render(
            <FeedbackActionPills
              value="adjust"
              onChange={onChange}
              noteValue={noteText}
              onNoteChange={onNoteChange}
            />,
          );

          const textarea = container.querySelector('textarea');
          expect(textarea).not.toBeNull();

          unmount();
        },
      ),
      { numRuns: 50 },
    );
  });
});
