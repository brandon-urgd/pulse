/**
 * backfill-close-schedules.mjs — One-shot script to create EventBridge schedules
 * for active items that have a future closeDate but no existing schedule.
 *
 * Usage:
 *   node scripts/backfill-close-schedules.mjs --env staging [--send]
 *   node scripts/backfill-close-schedules.mjs --env dev [--send]
 *
 * Flags:
 *   --env    Environment: dev or staging (required)
 *   --send   Actually create schedules (default is dry-run)
 */

import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import { SchedulerClient, GetScheduleCommand, CreateScheduleCommand } from '@aws-sdk/client-scheduler'

const REGION = 'us-west-2'

const args = process.argv.slice(2)
function getArg(name) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}
const hasFlag = (name) => args.includes(`--${name}`)

const env = getArg('env')
const isDryRun = !hasFlag('send')

if (!env || !['dev', 'staging'].includes(env)) {
  console.error('\n❌ --env is required (dev or staging)')
  process.exit(1)
}

const ITEMS_TABLE = `urgd-pulse-items-${env}`
const SCHEDULE_GROUP = `pulse-item-close-${env}`
const CLOSE_FUNCTION_ARN = `arn:aws:lambda:${REGION}:198919428218:function:urgd-pulse-closeExpiredItems-${env}`
const SCHEDULER_ROLE_ARN = `arn:aws:iam::198919428218:role/urgd-pulse-scheduler-execution-role-${env}`

const dynamo = new DynamoDBClient({ region: REGION })
const scheduler = new SchedulerClient({ region: REGION })

function scheduleName(itemId) {
  return `pulse-close-${itemId}`
}

function toScheduleExpression(closeDate) {
  const d = new Date(closeDate)
  const iso = d.toISOString().replace(/\.\d{3}Z$/, '')
  return `at(${iso})`
}

async function main() {
  console.log(`\n🔍 Backfill Close Schedules — ${env}`)
  console.log(`   Mode: ${isDryRun ? 'DRY RUN' : '🔴 LIVE'}`)
  console.log(`   Table: ${ITEMS_TABLE}`)
  console.log(`   Schedule Group: ${SCHEDULE_GROUP}`)
  console.log('')

  const now = new Date().toISOString()
  let lastKey
  let totalScanned = 0
  let needsSchedule = 0
  let alreadyHasSchedule = 0
  let created = 0

  do {
    const result = await dynamo.send(new ScanCommand({
      TableName: ITEMS_TABLE,
      FilterExpression: '#status = :active AND closeDate > :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':active': { S: 'active' },
        ':now': { S: now },
      },
      ExclusiveStartKey: lastKey,
    }))

    lastKey = result.LastEvaluatedKey
    const items = (result.Items || []).map(i => ({
      itemId: i.itemId?.S,
      tenantId: i.tenantId?.S,
      itemName: i.itemName?.S || '(unnamed)',
      closeDate: i.closeDate?.S,
    }))
    totalScanned += items.length

    for (const item of items) {
      const { itemId, tenantId, itemName, closeDate } = item
      const name = scheduleName(itemId)

      // Check if schedule already exists
      try {
        await scheduler.send(new GetScheduleCommand({ Name: name, GroupName: SCHEDULE_GROUP }))
        alreadyHasSchedule++
        console.log(`  ⏭  ${itemName} — schedule exists`)
        continue
      } catch (err) {
        if (err.name !== 'ResourceNotFoundException') throw err
      }

      // Schedule doesn't exist — needs creation
      needsSchedule++
      const expression = toScheduleExpression(closeDate)
      console.log(`  📅 ${itemName} — needs schedule (${closeDate} → ${expression})`)

      if (!isDryRun) {
        await scheduler.send(new CreateScheduleCommand({
          Name: name,
          GroupName: SCHEDULE_GROUP,
          ScheduleExpression: expression,
          ScheduleExpressionTimezone: 'UTC',
          ActionAfterCompletion: 'DELETE',
          FlexibleTimeWindow: { Mode: 'OFF' },
          Target: {
            Arn: CLOSE_FUNCTION_ARN,
            RoleArn: SCHEDULER_ROLE_ARN,
            Input: JSON.stringify({ itemId, tenantId }),
          },
        }))
        created++
        console.log(`     ✓ Created`)
      }
    }
  } while (lastKey)

  console.log('')
  console.log(`   Scanned: ${totalScanned} active items with future closeDate`)
  console.log(`   Already has schedule: ${alreadyHasSchedule}`)
  console.log(`   Needs schedule: ${needsSchedule}`)
  if (!isDryRun) {
    console.log(`   Created: ${created}`)
  } else {
    console.log(`   Add --send to create schedules for real.`)
  }
  console.log('')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
