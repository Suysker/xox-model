import { parseJson } from '../db/database.js'
import type { Row } from '../db/schema.js'
import type { AgentMemoryCandidate } from './memory-consolidator.js'

const WORKING_MEMORY_TTL_MS = 6 * 60 * 60 * 1000

function compactValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 420)
}

function ttlFromNow(ms: number) {
  return new Date(Date.now() + ms).toISOString()
}

export function memoryCandidatesFromExecutedActions(input: {
  runId: string
  actionRows: Row<'agent_action_requests'>[]
}): AgentMemoryCandidate[] {
  const candidates: AgentMemoryCandidate[] = []
  for (const action of input.actionRows) {
    if (action.status !== 'executed') continue
    const payload = parseJson<any>(action.payload_json, {})
    if (action.kind === 'workspace.update_draft') {
      const config = payload?.config
      const memberCount = Array.isArray(config?.teamMembers) ? config.teamMembers.length : null
      const monthCount = Array.isArray(config?.months) ? config.months.length : null
      const shareholderCount = Array.isArray(config?.shareholders) ? config.shareholders.length : null
      const workspaceName = typeof payload?.workspaceName === 'string' ? payload.workspaceName : action.target_label
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `workspace.episode.${action.id}`,
        value: compactValue(`已通过 Agent 更新草稿：${workspaceName}，成员 ${memberCount ?? '未知'} 个，股东 ${shareholderCount ?? '未知'} 个，预测 ${monthCount ?? '未知'} 个月。`),
        confidence: 0.78,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (payload?.source === 'workspace_configure_operating_model' && memberCount && monthCount) {
        candidates.push({
          kind: 'workflow',
          scopeType: 'procedural',
          memoryType: 'procedural',
          lane: 'procedural',
          status: 'promoted',
          injectable: true,
          sourceKind: 'confirmed_action',
          key: 'agent.workflow.operating_model_configured_by_high_level_tool',
          value: '完整经营简报应优先使用 workspace_configure_operating_model 生成一张可编辑草稿确认卡，再由 evaluator 检查成员、股东、成本和月份节奏。',
          confidence: 0.82,
          evidenceScore: 0.86,
          evidence: { runId: input.runId, actionRequestId: action.id, memberCount, monthCount },
        })
      }
      continue
    }

    if (action.kind.startsWith('ledger.')) {
      const relatedName = typeof payload?.relatedEntityName === 'string' ? payload.relatedEntityName : null
      const monthLabel = typeof payload?.monthLabel === 'string' ? payload.monthLabel : null
      const amount = typeof payload?.amount === 'number' ? payload.amount : null
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `ledger.episode.${action.id}`,
        value: compactValue(`已通过 Agent 执行账本动作：${action.title}${monthLabel ? `，账期 ${monthLabel}` : ''}${relatedName ? `，对象 ${relatedName}` : ''}${amount ? `，金额 ${amount}` : ''}。`),
        confidence: 0.72,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (relatedName) {
        candidates.push({
          kind: 'fact',
          scopeType: 'thread',
          memoryType: 'working',
          lane: 'working',
          status: 'active',
          injectable: true,
          sourceKind: 'working_context',
          key: `workspace.recent_related_entity.${relatedName}`,
          value: compactValue(`最近一次 Agent 账本动作关联对象是 ${relatedName}。这只是短期情节记忆，不等于默认成员。`),
          confidence: 0.58,
          evidenceScore: 0.5,
          expiresAt: ttlFromNow(WORKING_MEMORY_TTL_MS),
          evidence: { runId: input.runId, actionRequestId: action.id, relatedName },
        })
      }
      continue
    }

    if (action.kind.startsWith('workspace.') || action.kind.startsWith('share.')) {
      candidates.push({
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        lane: 'episodic',
        status: 'archived',
        injectable: false,
        sourceKind: 'confirmed_action',
        key: `workspace.episode.${action.id}`,
        value: compactValue(`已通过 Agent 执行业务动作：${action.title}。`),
        confidence: 0.7,
        evidenceScore: 0.75,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
    }
  }
  return candidates
}

export function memoryCandidateFromEditedAction(input: {
  runId: string
  action: Row<'agent_action_requests'>
}): AgentMemoryCandidate {
  return {
    kind: 'correction',
    scopeType: 'workspace',
    memoryType: 'procedural',
    lane: 'procedural',
    status: 'candidate',
    injectable: false,
    sourceKind: 'edited_confirmation',
    key: `agent.correction.action_edit.${input.action.id}`,
    value: compactValue(`用户编辑了 Agent 确认卡：${input.action.title}。后续相似动作应参考用户编辑后的确认卡内容，并继续通过确认卡执行。`),
    confidence: 0.68,
    evidenceScore: 0.72,
    evidence: { runId: input.runId, actionRequestId: input.action.id, actionKind: input.action.kind, lifecycle: 'edited' },
  }
}

export function memoryCandidateFromCancelledAction(input: {
  runId: string
  action: Row<'agent_action_requests'>
}): AgentMemoryCandidate {
  return {
    kind: 'correction',
    scopeType: 'workspace',
    memoryType: 'episodic',
    lane: 'diagnostic',
    status: 'active',
    injectable: false,
    sourceKind: 'cancelled_confirmation',
    key: `agent.correction.action_cancel.${input.action.id}`,
    value: compactValue(`用户取消了 Agent 确认卡：${input.action.title}。这表示该动作在当时上下文中不应继续自动推进。`),
    confidence: 0.62,
    evidenceScore: 0.62,
    evidence: { runId: input.runId, actionRequestId: input.action.id, actionKind: input.action.kind, lifecycle: 'cancelled' },
  }
}

export function memoryCandidateFromEvaluatorFinding(input: {
  runId: string
  evaluation: Row<'agent_evaluations'>
}): AgentMemoryCandidate | null {
  if (input.evaluation.status === 'pass') return null
  const unsatisfied = parseJson<Array<{ message?: string }>>(input.evaluation.unsatisfied_json, [])
  const firstFinding = unsatisfied.map((item) => item.message).find((message): message is string => Boolean(message))
  if (!firstFinding) return null
  return {
    kind: 'diagnostic',
    scopeType: 'procedural',
    memoryType: 'episodic',
    lane: 'diagnostic',
    status: 'active',
    injectable: false,
    sourceKind: 'evaluator_result',
    key: `agent.evaluator.finding.${input.evaluation.id}`,
    value: compactValue(`Loop Readiness Check 诊断：${firstFinding}`),
    confidence: 0.7,
    evidenceScore: 0.45,
    evidence: {
      runId: input.runId,
      evaluationId: input.evaluation.id,
      evaluationStatus: input.evaluation.status,
      iteration: input.evaluation.iteration_no,
    },
  }
}

export function memoryCandidateFromCompletedGoal(input: {
  goal: Row<'agent_goals'>
}): AgentMemoryCandidate | null {
  void input
  return null
}
