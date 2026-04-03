// Property-based tests for scheduleClose.mjs (P1 + P2)
// Uses fast-check with vitest to verify schedule upsert idempotency and manual close removal.
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ── Mock AWS SDK SchedulerClient ─────────────────────────────────────────────
// Track all schedules in a Map keyed by schedule name
let scheduleStore

const mockSend = vi.fn()

vi.mock('@aws-sdk/client-scheduler', () => {
  class SchedulerClient { send(cmd) { return mockSend(cmd) } }
  class GetScheduleCommand { constructor(input) { this.input = input; this.name = 'GetScheduleCommand' } }
  class CreateScheduleCommand { constructor(input) { this.input = input; this.name = 'CreateScheduleCommand' } }
  class UpdateScheduleCommand { constructor(input) { this.input = input; this.name = 'UpdateScheduleCommand' } }
  class DeleteScheduleCommand { constructor(input) { this.input = input; this.name = 'DeleteScheduleCommand' } }
  return { SchedulerClient, GetScheduleCommand, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand }
})

// Suppress log output during tests
vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

// ── Generators ───────────────────────────────────────────────────────────────
const itemIdArb = fc.stringMatching(/^[0-9A-Z]{26}$/)
const tenantIdArb = fc.uuid()
const closeDateArb = fc.integer({
  min: new Date('2024-01-01T00:00:00Z').getTime(),
  max: new Date('2030-12-31T23:59:59Z').getTime(),
}).map(ms => new Date(ms).toISOString())

function setupMockSend() {
  mockSend.mockImplementation((cmd) => {
    const name = cmd.name || cmd.constructor?.name
    if (name === 'GetScheduleCommand') {
      const key = cmd.input.Name
      if (scheduleStore.has(key)) {
        return Promise.resolve(scheduleStore.get(key))
      }
      const err = new Error('not found')
      err.name = 'ResourceNotFoundException'
      return Promise.reject(err)
    }
    if (name === 'CreateScheduleCommand') {
      scheduleStore.set(cmd.input.Name, { ...cmd.input })
      return Promise.resolve({})
    }
    if (name === 'UpdateScheduleCommand') {
      scheduleStore.set(cmd.input.Name, { ...cmd.input })
      return Promise.resolve({})
    }
    if (name === 'DeleteScheduleCommand') {
      const key = cmd.input.Name
      if (scheduleStore.has(key)) {
        scheduleStore.delete(key)
        return Promise.resolve({})
      }
      const err = new Error('not found')
      err.name = 'ResourceNotFoundException'
      return Promise.reject(err)
    }
    return Promise.resolve({})
  })
}


/**
 * Property 1: Schedule Upsert Idempotency
 *
 * For any item with a close date, after any sequence of upsertCloseSchedule calls
 * (create, update, extend), exactly one EventBridge schedule SHALL exist with name
 * pulse-close-{itemId}. The schedule's fire time SHALL equal the most recently
 * provided close date converted to UTC. No duplicate schedules are created.
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */
describe('Property P1: Schedule upsert idempotency', () => {
  beforeEach(() => {
    scheduleStore = new Map()
    mockSend.mockReset()
    setupMockSend()
    process.env.CLOSE_EXPIRED_ITEMS_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123456789:function:closeExpiredItems'
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789:role/scheduler-role'
    process.env.SCHEDULE_GROUP_NAME = 'pulse-item-close'
  })

  it('after N upserts, exactly one schedule exists with the latest close date', async () => {
    const { upsertCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    await fc.assert(
      fc.asyncProperty(
        itemIdArb,
        tenantIdArb,
        fc.array(closeDateArb, { minLength: 1, maxLength: 5 }),
        async (itemId, tenantId, closeDates) => {
          scheduleStore.clear()

          // Call upsert for each close date in sequence
          for (const closeDate of closeDates) {
            await upsertCloseSchedule(itemId, tenantId, closeDate)
          }

          const scheduleName = `pulse-close-${itemId}`
          const lastDate = closeDates[closeDates.length - 1]
          const expectedExpression = `at(${new Date(lastDate).toISOString().replace(/\.\d{3}Z$/, '')})`

          // Exactly one schedule exists
          const matchingSchedules = [...scheduleStore.entries()].filter(([k]) => k === scheduleName)
          expect(matchingSchedules).toHaveLength(1)

          // Schedule expression matches the latest close date
          const stored = scheduleStore.get(scheduleName)
          expect(stored.ScheduleExpression).toBe(expectedExpression)
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 2: Manual Close Removes Schedule
 *
 * For any item that has a pending EventBridge schedule, calling deleteCloseSchedule(itemId)
 * SHALL result in no schedule existing for that item. For any item with no pending schedule,
 * deleteCloseSchedule SHALL complete without error.
 *
 * Validates: Requirements 1.4
 */
describe('Property P2: Manual close removes schedule', () => {
  beforeEach(() => {
    scheduleStore = new Map()
    mockSend.mockReset()
    setupMockSend()
    process.env.CLOSE_EXPIRED_ITEMS_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123456789:function:closeExpiredItems'
    process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123456789:role/scheduler-role'
    process.env.SCHEDULE_GROUP_NAME = 'pulse-item-close'
  })

  it('delete after create leaves no schedule; delete on non-existent does not throw', async () => {
    const { upsertCloseSchedule, deleteCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    await fc.assert(
      fc.asyncProperty(
        itemIdArb,
        tenantIdArb,
        closeDateArb,
        async (itemId, tenantId, closeDate) => {
          scheduleStore.clear()
          const scheduleName = `pulse-close-${itemId}`

          // Create a schedule
          await upsertCloseSchedule(itemId, tenantId, closeDate)
          expect(scheduleStore.has(scheduleName)).toBe(true)

          // Delete it
          await deleteCloseSchedule(itemId)
          expect(scheduleStore.has(scheduleName)).toBe(false)

          // Delete again — should not throw
          await expect(deleteCloseSchedule(itemId)).resolves.not.toThrow()
        },
      ),
      { numRuns: 100 },
    )
  })
})
