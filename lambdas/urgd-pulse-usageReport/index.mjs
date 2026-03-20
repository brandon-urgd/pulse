// ur/gd pulse — Usage Report Lambda
// Triggered daily by EventBridge
// Scans tenants and sessions tables, publishes usage metrics to CloudWatch

import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { log, requireEnv } from './shared/utils.mjs'

requireEnv(['TENANTS_TABLE', 'SESSIONS_TABLE', 'ALERTS_TOPIC_ARN'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION || 'us-west-2' })
const sns = new SNSClient({ region: process.env.AWS_REGION || 'us-west-2' })

async function scanAll(tableName, projectionExpression, expressionAttributeNames) {
  const items = []
  let lastKey

  do {
    const params = {
      TableName: tableName,
      ProjectionExpression: projectionExpression,
    }
    if (expressionAttributeNames) {
      params.ExpressionAttributeNames = expressionAttributeNames
    }
    if (lastKey) {
      params.ExclusiveStartKey = lastKey
    }

    const result = await dynamo.send(new ScanCommand(params))
    items.push(...(result.Items || []))
    lastKey = result.LastEvaluatedKey
  } while (lastKey)

  return items
}

async function publishAlert(message, context) {
  try {
    await sns.send(new PublishCommand({
      TopicArn: process.env.ALERTS_TOPIC_ARN,
      Subject: 'Pulse Usage Report Error',
      Message: JSON.stringify({ message, ...context }),
    }))
  } catch (err) {
    log('warn', 'UsageReport: failed to publish SNS alert', { errorName: err.name })
  }
}

export const handler = async () => {
  try {
    // 1. Scan tenants table
    const tenants = await scanAll(process.env.TENANTS_TABLE, 'tenantId, tier')
    const activeTenants = tenants.length

    // 2. Scan sessions table
    const sessions = await scanAll(
      process.env.SESSIONS_TABLE,
      '#status',
      { '#status': 'status' }
    )

    const totalSessions = sessions.length
    const sessionsByStatus = sessions.reduce((acc, s) => {
      const status = s.status?.S || 'unknown'
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})

    // 3. Publish metrics to CloudWatch
    const metricData = [
      {
        MetricName: 'ActiveTenants',
        Value: activeTenants,
        Unit: 'Count',
      },
      {
        MetricName: 'TotalSessions',
        Value: totalSessions,
        Unit: 'Count',
      },
    ]

    // Add per-status metrics
    for (const [status, count] of Object.entries(sessionsByStatus)) {
      metricData.push({
        MetricName: 'SessionsByStatus',
        Value: count,
        Unit: 'Count',
        Dimensions: [{ Name: 'Status', Value: status }],
      })
    }

    await cloudwatch.send(new PutMetricDataCommand({
      Namespace: 'Pulse/Usage',
      MetricData: metricData,
    }))

    log('info', 'UsageReport: metrics published', {
      activeTenants,
      totalSessions,
      sessionsByStatus,
    })
  } catch (err) {
    log('error', 'UsageReport: failed', { errorName: err.name })
    await publishAlert('Usage report job failed', { errorName: err.name })
    throw err
  }
}
