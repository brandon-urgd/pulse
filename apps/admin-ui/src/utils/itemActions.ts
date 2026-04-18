/**
 * Pure item-action logic — testable without React.
 * Maps item lifecycle state to visible action buttons.
 * Used by property tests 9 and 10.
 */

/** Actions available on item cards and detail pages. */
export type ItemAction = 'getFeedback' | 'pulseCheck' | 'runPulseCheck' | 'revisions';

/** Minimal item shape required for action resolution. */
export interface ItemActionInput {
  status: 'draft' | 'active' | 'closed' | 'revised';
  hasPulseCheck?: boolean;
  hasCompletedRevision?: boolean;
}

/**
 * Returns the list of visible actions for an item based on its current state.
 * Max 2 actions at any state.
 *
 * - draft / active → ['getFeedback']
 * - revised → ['pulseCheck', 'revisions']
 * - closed + hasPulseCheck + hasCompletedRevision → ['pulseCheck', 'revisions']
 * - closed + hasPulseCheck → ['pulseCheck']
 * - closed + !hasPulseCheck → ['runPulseCheck']
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
export function getItemActions(item: ItemActionInput): ItemAction[] {
  if (item.status === 'draft' || item.status === 'active') {
    return ['getFeedback'];
  }

  if (item.status === 'revised') {
    return ['pulseCheck', 'revisions'];
  }

  if (item.status === 'closed') {
    if (item.hasPulseCheck && item.hasCompletedRevision) {
      return ['pulseCheck', 'revisions'];
    }
    if (item.hasPulseCheck) {
      return ['pulseCheck'];
    }
    return ['runPulseCheck'];
  }

  return [];
}
