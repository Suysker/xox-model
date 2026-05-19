import { parseJson } from '../db/database.js'
import type { Row } from '../db/schema.js'
import type { AgentMemoryCandidate } from './memory-consolidator.js'

function compactValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 420)
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
        key: `workspace.episode.${action.id}`,
        value: compactValue(`已通过 Agent 更新草稿：${workspaceName}，成员 ${memberCount ?? '未知'} 个，股东 ${shareholderCount ?? '未知'} 个，预测 ${monthCount ?? '未知'} 个月。`),
        confidence: 0.78,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (payload?.source === 'workspace_configure_operating_model' && memberCount && monthCount) {
        candidates.push({
          kind: 'workflow',
          scopeType: 'procedural',
          memoryType: 'procedural',
          key: 'agent.workflow.operating_model_configured_by_high_level_tool',
          value: '完整经营简报应优先使用 workspace_configure_operating_model 生成一张可编辑草稿确认卡，再由 evaluator 检查成员、股东、成本和月份节奏。',
          confidence: 0.82,
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
        key: `ledger.episode.${action.id}`,
        value: compactValue(`已通过 Agent 执行账本动作：${action.title}${monthLabel ? `，账期 ${monthLabel}` : ''}${relatedName ? `，对象 ${relatedName}` : ''}${amount ? `，金额 ${amount}` : ''}。`),
        confidence: 0.72,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
      if (relatedName) {
        candidates.push({
          kind: 'fact',
          scopeType: 'workspace',
          memoryType: 'episodic',
          key: `workspace.recent_related_entity.${relatedName}`,
          value: compactValue(`最近一次 Agent 账本动作关联对象是 ${relatedName}。这只是短期情节记忆，不等于默认成员。`),
          confidence: 0.58,
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
        key: `workspace.episode.${action.id}`,
        value: compactValue(`已通过 Agent 执行业务动作：${action.title}。`),
        confidence: 0.7,
        evidence: { runId: input.runId, actionRequestId: action.id, actionKind: action.kind },
      })
    }
  }
  return candidates
}
