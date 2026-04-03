// ur/gd pulse — Shared EventBridge Scheduler utilities for item close scheduling
// Used by createItem, updateItem, extendDeadline (upsert) and closeItem (delete)
// Import convention: import { upsertCloseSchedule, deleteCloseSchedule } from './shared/scheduleClose.mjs'

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  GetScheduleCommand,
  DeleteScheduleCommand,
} from '@aws-sdk/client-scheduler'
import { log } from './utils.mjs'

const scheduler = new SchedulerClient({ region: process.env.AWS_REGION || 'us-west-2' })

const SCHEDULE_GROUP = process.env.SCHEDULE_GROUP_NAME || `pulse-item-close-${process.env.ENVIRONMENT || 'dev'}`

/**
 * Builds the schedule name for a given item.
 * Pattern: pulse-close-{itemId}
 */
const scheduleName = (itemId) => `pulse-close-${itemId}`

/**
 * Converts a close date to the EventBridge Scheduler `at()` expression.
 * Format: at(YYYY-MM-DDThh:mm:ss) — one-time, UTC.
 */
const toScheduleExpression = (closeDate) => {
  const d = new Date(closeDate)
  // Format: YYYY-MM-DDThh:mm:ss (no trailing Z, no milliseconds)
  const iso = d.toISOString().replace(/\.\d{3}Z$/, '')
  return `at(${iso})`
}

/**
 * Creates or updates an EventBridge Scheduler one-time schedule for an item's close date.
 * Uses GetSchedule to check existence, then Update if exists or Create if not.
 *
 * @param {string} itemId  — the item to schedule
 * @param {string} tenantId — tenant owning the item (passed in the schedule payload)
 * @param {string} closeDate — ISO 8601 datetime (UTC or with offset)
 */
export async function upsertCloseSchedule(itemId, tenantId, closeDate) {
  const name = scheduleName(itemId)
  const expression = toScheduleExpression(closeDate)
  const targetArn = process.env.CLOSE_EXPIRED_ITEMS_FUNCTION_ARN
  const roleArn = process.env.SCHEDULER_ROLE_ARN

  if (!targetArn || !roleArn) {
    log('warn', 'scheduleClose: missing CLOSE_EXPIRED_ITEMS_FUNCTION_ARN or SCHEDULER_ROLE_ARN, skipping schedule upsert', { itemId })
    return
  }

  const scheduleParams = {
    Name: name,
    GroupName: SCHEDULE_GROUP,
    ScheduleExpression: expression,
    ScheduleExpressionTimezone: 'UTC',
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn: targetArn,
      RoleArn: roleArn,
      Input: JSON.stringify({ itemId, tenantId }),
    },
    ActionAfterCompletion: 'DELETE',
  }

  try {
    // Check if schedule already exists
    await scheduler.send(new GetScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP }))

    // Schedule exists — update it
    await scheduler.send(new UpdateScheduleCommand(scheduleParams))
    log('info', 'scheduleClose: schedule updated', { itemId, name, expression })
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      // Schedule does not exist — create it
      try {
        await scheduler.send(new CreateScheduleCommand(scheduleParams))
        log('info', 'scheduleClose: schedule created', { itemId, name, expression })
      } catch (createErr) {
        log('error', 'scheduleClose: failed to create schedule', { itemId, name, errorName: createErr.name, errorMessage: createErr.message })
        throw createErr
      }
    } else {
      log('error', 'scheduleClose: failed to get/update schedule', { itemId, name, errorName: err.name, errorMessage: err.message })
      throw err
    }
  }
}

/**
 * Deletes the EventBridge Scheduler schedule for an item.
 * No-op if the schedule doesn't exist (catches ResourceNotFoundException).
 *
 * @param {string} itemId — the item whose schedule to delete
 */
export async function deleteCloseSchedule(itemId) {
  const name = scheduleName(itemId)

  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP }))
    log('info', 'scheduleClose: schedule deleted', { itemId, name })
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      log('info', 'scheduleClose: schedule not found (already deleted or never created)', { itemId, name })
    } else {
      log('error', 'scheduleClose: failed to delete schedule', { itemId, name, errorName: err.name, errorMessage: err.message })
      throw err
    }
  }
}
