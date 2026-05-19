import type { AgentEvaluationFinding, AgentEvaluationResult } from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { collectAgentObservation } from './observation-collector.js'
import { addEvaluationResult, updateGoalStatus } from './goal-contract.js'

function finding(input: {
  id: string
  criterionId: string
  severity: AgentEvaluationFinding['severity']
  message: string
  evidence?: Record<string, unknown>
}): AgentEvaluationFinding {
  return {
    id: input.id,
    criterionId: input.criterionId,
    severity: input.severity,
    message: input.message,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  }
}

function payloadConfig(action: Row<'agent_action_requests'>) {
  const payload = parseJson<any>(action.payload_json, null)
  return payload && typeof payload === 'object' ? payload.config : null
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function arrayOfRecords(value: unknown): any[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []
}

function hasPositiveOperatingInput(config: any) {
  const months = arrayOfRecords(config?.months)
  const members = arrayOfRecords(config?.teamMembers)
  const employees = arrayOfRecords(config?.employees)
  const operating = config?.operating && typeof config.operating === 'object' ? config.operating : {}
  const hasActiveMonth = months.some((month) => positiveNumber(month.events))
  const hasRevenueUnit = members.some((member) => {
    const units = member.unitsPerEvent && typeof member.unitsPerEvent === 'object' ? member.unitsPerEvent : {}
    return positiveNumber(units.base) || positiveNumber(units.pessimistic) || positiveNumber(units.optimistic)
  })
  const hasUnitPrice = positiveNumber(operating.offlineUnitPrice) || positiveNumber(operating.onlineUnitPrice)
  const hasRecurringCost = [
    ...arrayOfRecords(operating.monthlyFixedCosts),
    ...arrayOfRecords(operating.perEventCosts),
    ...arrayOfRecords(operating.perUnitCosts),
  ].some((item) => positiveNumber(item.amount))
  const hasStaffCost =
    members.some((member) => positiveNumber(member.monthlyBasePay) || positiveNumber(member.perEventTravelCost)) ||
    employees.some((employee) => positiveNumber(employee.monthlyBasePay) || positiveNumber(employee.perEventCost))
  const hasStageCost = months.some((month) =>
    arrayOfRecords(month.specialCosts).some((cost) => positiveNumber(cost.amount) && positiveNumber(cost.count)),
  )
  return (hasActiveMonth && hasRevenueUnit && hasUnitPrice) || hasRecurringCost || hasStaffCost || hasStageCost
}

function evaluateWorkspaceDraftAction(input: {
  action: Row<'agent_action_requests'>
  observation: Awaited<ReturnType<typeof collectAgentObservation>>
}) {
  const config = payloadConfig(input.action)
  const findings: AgentEvaluationFinding[] = []
  const satisfied: string[] = []
  if (!config || typeof config !== 'object') return { findings, satisfied }

  const expectedMembers = Array.isArray(config.teamMembers) ? config.teamMembers.length : null
  const expectedEmployees = Array.isArray(config.employees) ? config.employees.length : null
  const expectedShareholders = Array.isArray(config.shareholders) ? config.shareholders.length : null
  const expectedMonths = Array.isArray(config.months) ? config.months.length : null

  const checks: Array<[string, string, number | null, number]> = [
    ['domain.team_members_match', '成员数量已写入当前草稿', expectedMembers, input.observation.draft.teamMemberCount],
    ['domain.employees_match', '员工数量已写入当前草稿', expectedEmployees, input.observation.draft.employeeCount],
    ['domain.shareholders_match', '股东数量已写入当前草稿', expectedShareholders, input.observation.draft.shareholderCount],
    ['domain.months_match', '预测月份已写入当前草稿', expectedMonths, input.observation.draft.monthCount],
  ]

  for (const [id, label, expected, actual] of checks) {
    if (expected === null) continue
    if (expected === actual) {
      satisfied.push(id)
      continue
    }
    findings.push(finding({
      id,
      criterionId: 'domain.executed_actions_match_outcome',
      severity: 'blocking',
      message: `${label}未满足：期望 ${expected}，当前 ${actual}。`,
      evidence: { actionId: input.action.id, expected, actual },
    }))
  }

  if (input.observation.draft.totalRevenue > 0 || input.observation.draft.totalCost > 0) {
    satisfied.push('domain.projection_computable')
  } else if (expectedMonths && expectedMonths > 0) {
    findings.push(finding({
      id: 'domain.projection_computable',
      criterionId: 'domain.executed_actions_match_outcome',
      severity: 'blocking',
      message: '草稿已写入但预测结果没有产生有效收入或成本，需要继续修复模型输入。',
      evidence: {
        totalRevenue: input.observation.draft.totalRevenue,
        totalCost: input.observation.draft.totalCost,
      },
    }))
  }

  if (hasPositiveOperatingInput(config)) {
    satisfied.push('domain.operating_inputs_nonzero')
  } else {
    findings.push(finding({
      id: 'domain.operating_inputs_nonzero',
      criterionId: 'domain.executed_actions_match_outcome',
      severity: 'blocking',
      message: '经营模型草稿缺少非零收入驱动或成本驱动输入，需要继续修复成员销量、场次、单价或成本结构。',
      evidence: { actionId: input.action.id },
    }))
  }

  return { findings, satisfied }
}

export async function evaluateAgentGoal(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  goal: Row<'agent_goals'>
  iteration: number
}): Promise<Row<'agent_evaluations'>> {
  const [planSteps, actions, observation] = await Promise.all([
    input.db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', input.goal.run_id).orderBy('sequence_no', 'asc').execute(),
    input.db.selectFrom('agent_action_requests').selectAll().where('run_id', '=', input.goal.run_id).orderBy('created_at', 'asc').execute(),
    collectAgentObservation({ db: input.db, workspace: input.workspace, runId: input.goal.run_id }),
  ])

  const satisfied = new Set<string>(['policy.no_forbidden_actions', 'context.memory_scoped'])
  const unsatisfied: AgentEvaluationFinding[] = []
  const policyFindings: AgentEvaluationFinding[] = []

  if (planSteps.length > 0 || actions.length > 0) {
    satisfied.add('graph.visible_steps')
  } else {
    satisfied.add('graph.visible_steps')
  }

  const pendingActions = actions.filter((action) => action.status === 'pending')
  const failedActions = actions.filter((action) => action.status === 'failed')
  const failedSteps = planSteps.filter((step) => step.status === 'failed')
  const emptyModelReadSteps = planSteps.filter((step) => step.title === '模型没有返回内容')

  for (const action of actions) {
    if (action.kind.startsWith('account.')) {
      const item = finding({
        id: `policy.account.${action.id}`,
        criterionId: 'policy.no_forbidden_actions',
        severity: 'blocking',
        message: '账号影响类动作不能由 Agent 自动执行。',
        evidence: { actionId: action.id, kind: action.kind },
      })
      policyFindings.push(item)
      unsatisfied.push(item)
    }
    if (!action.navigation_json) {
      unsatisfied.push(finding({
        id: `graph.navigation.${action.id}`,
        criterionId: 'graph.write_actions_have_cards',
        severity: 'blocking',
        message: `写入动作 ${action.title} 缺少显式导航。`,
        evidence: { actionId: action.id, kind: action.kind },
      }))
    }
  }

  if (actions.length > 0 && actions.every((action) => action.navigation_json && action.payload_json)) {
    satisfied.add('graph.write_actions_have_cards')
  } else if (actions.length === 0) {
    satisfied.add('graph.write_actions_have_cards')
  }

  if (failedActions.length > 0 || failedSteps.length > 0) {
    unsatisfied.push(finding({
      id: 'graph.failed_steps',
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: '运行图中存在失败步骤或失败确认卡，需要先修复再继续。',
      evidence: { failedActionCount: failedActions.length, failedStepCount: failedSteps.length },
    }))
  }

  if (actions.length === 0 && emptyModelReadSteps.length > 0) {
    unsatisfied.push(finding({
      id: 'graph.empty_model_result',
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: '模型没有返回可执行工具调用或可展示回答，不能把目标判定为完成，需要继续规划或给出明确阻塞原因。',
      evidence: { emptyStepCount: emptyModelReadSteps.length },
    }))
  }

  const executedActions = actions.filter((action) => action.status === 'executed')
  const latestExecutedDraftAction = [...executedActions].reverse().find((action) => action.kind === 'workspace.update_draft')
  if (latestExecutedDraftAction) {
    const result = evaluateWorkspaceDraftAction({ action: latestExecutedDraftAction, observation })
    result.satisfied.forEach((id) => satisfied.add(id))
    unsatisfied.push(...result.findings)
  }

  if (executedActions.length === 0 || observation.audit.executedActionCount >= executedActions.length) {
    satisfied.add('domain.executed_actions_match_outcome')
  } else {
    unsatisfied.push(finding({
      id: 'domain.audit_missing',
      criterionId: 'domain.executed_actions_match_outcome',
      severity: 'blocking',
      message: '已执行动作数量超过可验证的 Agent 审计记录数量。',
      evidence: { executedActionCount: executedActions.length, auditCount: observation.audit.executedActionCount },
    }))
  }

  let status: AgentEvaluationResult['status'] = 'pass'
  let nextPlannerBrief: string | null = null
  let blocker: string | null = null
  let confidence = 0.92

  if (policyFindings.some((item) => item.severity === 'blocking')) {
    status = 'blocked'
    blocker = policyFindings.map((item) => item.message).join('；')
    confidence = 0.99
  } else if (failedActions.length > 0 || failedSteps.length > 0) {
    status = 'failed'
    blocker = '运行图存在失败动作。'
    confidence = 0.95
  } else if (pendingActions.length > 0) {
    status = 'needs_confirmation'
    nextPlannerBrief = '等待用户处理当前确认卡。不要继续规划依赖这些写入结果的后续动作。'
    confidence = 0.98
  } else if (unsatisfied.some((item) => item.severity === 'blocking')) {
    status = 'continue'
    nextPlannerBrief = `继续完成目标，只修复这些未满足项：${unsatisfied.map((item) => item.message).join('；')}`
    confidence = 0.86
  }

  const row = await addEvaluationResult(input.db, input.goal, {
    iteration: input.iteration,
    status,
    confidence,
    satisfiedCriteria: [...satisfied],
    unsatisfiedCriteria: unsatisfied,
    policyFindings,
    nextPlannerBrief,
    userQuestion: null,
    blocker,
  })

  const goalStatus =
    status === 'pass'
      ? 'completed'
      : status === 'needs_confirmation'
        ? 'waiting_for_confirmation'
        : status === 'continue'
          ? 'repairing'
          : status === 'blocked'
            ? 'blocked'
            : status === 'failed'
              ? 'failed'
              : 'planning'
  await updateGoalStatus(input.db, input.goal, goalStatus, { blockedReason: blocker })
  return row
}
