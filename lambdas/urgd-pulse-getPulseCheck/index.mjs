// ur/gd pulse — Get Pulse Check Lambda
// GET /api/manage/items/{itemId}/pulse-check
// Returns pulse check results including verdict, themes, decisions

import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb'
import { createResponse, errorResponse, log, requireEnv } from './shared/utils.mjs'

requireEnv(['PULSE_CHECKS_TABLE', 'CORS_ALLOWED_ORIGINS'])

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-west-2' })

function deserializeThemes(themesL) {
  return (themesL || []).map(t => {
    const m = t.M || {}
    return {
      themeId: m.themeId?.S || '',
      label: m.label?.S || '',
      reviewerSignals: (m.reviewerSignals?.L || []).map(s => {
        const sm = s.M || {}
        return {
          sessionId: sm.sessionId?.S || '',
          signalType: sm.signalType?.S || '',
          quote: sm.quote?.S || '',
        }
      }),
    }
  })
}

function deserializeReviewerVerdicts(verdictsL) {
  return (verdictsL || []).map(rv => {
    const m = rv.M || {}
    return {
      sessionId: m.sessionId?.S || '',
      verdict: m.verdict?.S || '',
      energy: m.energy?.S || '',
      isSelfReview: m.isSelfReview?.BOOL === true,
    }
  })
}

function deserializeDecisions(decisionsM) {
  if (!decisionsM) return {}
  const result = {}
  for (const [themeId, decisionAttr] of Object.entries(decisionsM)) {
    const dm = decisionAttr.M || {}
    result[themeId] = {
      action: dm.action?.S || '',
      tenantNote: dm.tenantNote?.S || '',
      decidedAt: dm.decidedAt?.S || '',
    }
  }
  return result
}

function deserializeProposedRevisions(revisionsL) {
  return (revisionsL || []).map(r => {
    const m = r.M || {}
    return {
      revisionId: m.revisionId?.S || '',
      proposal: m.proposal?.S || '',
      rationale: m.rationale?.S || '',
      sourceThemeIds: (m.sourceThemeIds?.L || []).map(id => id.S || ''),
    }
  })
}

export const handler = async (event) => {
  const origin = event?.headers?.origin ?? event?.headers?.Origin
  const requestId = event?.requestContext?.requestId
  const tenantId = event?.requestContext?.authorizer?.tenantId
  const itemId = event?.pathParameters?.itemId

  if (!tenantId) {
    return errorResponse(401, 'Unauthorized', {}, origin)
  }

  if (!itemId) {
    return errorResponse(400, 'itemId is required', {}, origin)
  }

  try {
    const result = await dynamo.send(new GetItemCommand({
      TableName: process.env.PULSE_CHECKS_TABLE,
      Key: { tenantId: { S: tenantId }, itemId: { S: itemId } },
    }))

    if (!result.Item) {
      return errorResponse(404, 'Pulse check not found', {}, origin)
    }

    const item = result.Item
    const pulseCheck = {
      itemId: item.itemId?.S,
      verdict: item.verdict?.S,
      narrative: item.narrative?.S ?? '',
      themes: deserializeThemes(item.themes?.L),
      sharedConviction: (item.sharedConviction?.L || []).map(s => s.S),
      repeatedTension: (item.repeatedTension?.L || []).map(s => s.S),
      openQuestions: (item.openQuestions?.L || []).map(s => s.S),
      reviewerVerdicts: deserializeReviewerVerdicts(item.reviewerVerdicts?.L),
      decisions: deserializeDecisions(item.decisions?.M),
      proposedRevisions: deserializeProposedRevisions(item.proposedRevisions?.L),
      sessionCount: item.sessionCount?.N ? parseInt(item.sessionCount.N, 10) : 0,
      incompleteCount: item.incompleteCount?.N ? parseInt(item.incompleteCount.N, 10) : 0,
      generatedAt: item.generatedAt?.S,
      status: item.status?.S,
    }

    log('info', 'GetPulseCheck: success', { requestId, tenantId, itemId })
    return createResponse(200, { data: pulseCheck }, {}, origin)
  } catch (err) {
    log('error', 'GetPulseCheck: unexpected error', { requestId, tenantId, itemId, errorName: err.name })
    return errorResponse(500, 'Failed to retrieve pulse check', {}, origin)
  }
}
