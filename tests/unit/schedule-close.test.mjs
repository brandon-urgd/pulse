// Unit tests for scheduleClose.mjs shared module
// Tests: create new, update existing, delete existing, delete non-existent
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockSend = vi.fn()

vi.mock('@aws-sdk/client-scheduler', () => {
  class SchedulerClient { send(cmd) { return mockSend(cmd) } }
  class GetScheduleCommand { constructor(input) { this.input = input; this.name = 'GetScheduleCommand' } }
  class CreateScheduleCommand { constructor(input) { this.input = input; this.name = 'CreateScheduleCommand' } }
  class UpdateScheduleCommand { constructor(input) { this.input = input; this.name = 'UpdateScheduleCommand' } }
  class DeleteScheduleCommand { constructor(input) { this.input = input; this.name = 'DeleteScheduleCommand' } }
  return { SchedulerClient, GetScheduleCommand, CreateScheduleCommand, UpdateScheduleCommand, DeleteScheduleCommand }
})

vi.mock('./shared/utils.mjs', () => ({
  log: vi.fn(),
  requireEnv: vi.fn(),
}))

beforeEach(() => {
  mockSend.mockReset()
  process.env.CLOSE_EXPIRED_ITEMS_FUNCTION_ARN = 'arn:aws:lambda:us-west-2:123:function:closeExpiredItems'
  process.env.SCHEDULER_ROLE_ARN = 'arn:aws:iam::123:role/scheduler-role'
  process.env.SCHEDULE_GROUP_NAME = 'pulse-item-close'
})

describe('scheduleClose unit tests', () => {
  it('creates a new schedule when none exists', async () => {
    const { upsertCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    const notFound = new Error('not found')
    notFound.name = 'ResourceNotFoundException'

    mockSend
      .mockRejectedValueOnce(notFound) // GetSchedule → not found
      .mockResolvedValueOnce({})       // CreateSchedule → success

    await upsertCloseSchedule('item-1', 'tenant-1', '2026-06-15T12:00:00Z')

    expect(mockSend).toHaveBeenCalledTimes(2)
    const createCmd = mockSend.mock.calls[1][0]
    expect(createCmd.name).toBe('CreateScheduleCommand')
    expect(createCmd.input.Name).toBe('pulse-close-item-1')
  })

  it('updates an existing schedule', async () => {
    const { upsertCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    mockSend
      .mockResolvedValueOnce({ Name: 'pulse-close-item-1' }) // GetSchedule → found
      .mockResolvedValueOnce({})                              // UpdateSchedule → success

    await upsertCloseSchedule('item-1', 'tenant-1', '2026-07-01T18:00:00Z')

    expect(mockSend).toHaveBeenCalledTimes(2)
    const updateCmd = mockSend.mock.calls[1][0]
    expect(updateCmd.name).toBe('UpdateScheduleCommand')
    expect(updateCmd.input.Name).toBe('pulse-close-item-1')
  })

  it('deletes an existing schedule', async () => {
    const { deleteCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    mockSend.mockResolvedValueOnce({}) // DeleteSchedule → success

    await deleteCloseSchedule('item-1')

    expect(mockSend).toHaveBeenCalledTimes(1)
    const deleteCmd = mockSend.mock.calls[0][0]
    expect(deleteCmd.name).toBe('DeleteScheduleCommand')
    expect(deleteCmd.input.Name).toBe('pulse-close-item-1')
  })

  it('handles delete of non-existent schedule without error', async () => {
    const { deleteCloseSchedule } = await import('../../lambdas/shared/scheduleClose.mjs')

    const notFound = new Error('not found')
    notFound.name = 'ResourceNotFoundException'
    mockSend.mockRejectedValueOnce(notFound)

    // Should not throw
    await expect(deleteCloseSchedule('item-nonexistent')).resolves.not.toThrow()
  })
})
