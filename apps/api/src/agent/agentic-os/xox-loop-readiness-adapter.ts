import type { AgentEvaluationFinding, AgentGoalContract, AgentGoalFacts, AgentToolObservationOutcome } from '@xox/contracts'
import { hydrateModelConfig, projectModel } from '@xox/domain'
import {
  classifyToolObservationOutcome,
  decideAgentReadiness,
  isRepairableProviderBoundaryCode,
  type AgentReadinessDecisionCopy,
  type ToolObservationStatus,
} from '@agentic-os/core'
import type { AgentToolCapability } from '../tool-catalog.js'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../../db/schema.js'
import { parseJson } from '../../db/database.js'
import { addEvaluationResult, updateGoalStatus } from './xox-goal-store-adapter.js'
import { goalFactsFromRunEvent, mergeAgentGoalFacts } from '../runtime-goal-facts.js'
import { getWorkspaceDraft, listVersions } from '../../modules/workspace.js'
import { listPeriods } from '../../modules/ledger.js'

const XOX_READINESS_DECISION_COPY = {
  policyBlocker: (messages) => messages.join('；'),
  failedGraphBlocker: '运行图存在失败动作。',
  waitForClarification: '等待用户补充当前澄清问题，不要继续猜测或生成依赖缺失信息的写入动作。',
  continueIndependentFindings: (messages) =>
    `继续完成不依赖该澄清的缺失动作或事实：${messages.join('；')}`,
  continueBlockingFindings: (messages) =>
    `继续完成目标，只修复这些未满足事实或执行结果：${messages.join('；')}`,
  waitForConfirmation: '等待用户处理当前确认卡。不要继续规划依赖这些写入结果的后续动作。',
} satisfies AgentReadinessDecisionCopy

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

function payloadWorkspaceName(action: Row<'agent_action_requests'>) {
  const payload = parseJson<any>(action.payload_json, null)
  return typeof payload?.workspaceName === 'string' ? payload.workspaceName : null
}

function payloadSource(action: Row<'agent_action_requests'>) {
  const payload = parseJson<any>(action.payload_json, null)
  return typeof payload?.source === 'string' ? payload.source : null
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

function goalFactsFromRow(goal: Row<'agent_goals'>): AgentGoalFacts {
  const contract = parseJson<Partial<AgentGoalContract>>(goal.contract_json, {})
  return contract.facts && typeof contract.facts === 'object' ? contract.facts : {}
}

function runtimeGoalFacts(runEvents: Row<'agent_run_events'>[]) {
  return mergeAgentGoalFacts(...runEvents.map(goalFactsFromRunEvent))
}

type AgentDomainObservation = {
  draft: {
    workspaceName: string
    revision: number
    teamMemberCount: number
    employeeCount: number
    shareholderCount: number
    monthCount: number
    startMonth: number
    totalRevenue: number
    totalCost: number
    totalProfit: number
  }
  ledger: {
    periodCount: number
  }
  versions: {
    count: number
    releaseCount: number
  }
  shares: {
    activeCount: number
  }
  audit: {
    executedActionCount: number
  }
}

async function collectAgentObservation(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
}): Promise<AgentDomainObservation> {
  const [currentWorkspace, draft, periods, versions, shares, audits] = await Promise.all([
    input.db.selectFrom('workspaces').select(['id', 'name']).where('id', '=', input.workspace.id).executeTakeFirst(),
    getWorkspaceDraft(input.db, input.workspace),
    listPeriods(input.db, input.workspace),
    listVersions(input.db, input.workspace),
    input.db
      .selectFrom('workspace_version_shares')
      .select('id')
      .where('workspace_id', '=', input.workspace.id)
      .where('revoked_at', 'is', null)
      .execute(),
    input.db
      .selectFrom('audit_logs')
      .select('id')
      .where('workspace_id', '=', input.workspace.id)
      .where('action', '=', 'agent.action_executed')
      .execute(),
  ])
  const config = hydrateModelConfig(parseJson<unknown>(draft.config_json, null))
  const scenario = projectModel(config).scenarios.find((item) => item.key === 'base')
  return {
    draft: {
      workspaceName: currentWorkspace?.name ?? input.workspace.name,
      revision: draft.revision,
      teamMemberCount: config.teamMembers.length,
      employeeCount: config.employees.length,
      shareholderCount: config.shareholders.length,
      monthCount: config.months.length,
      startMonth: config.planning.startMonth,
      totalRevenue: scenario?.grossSales ?? 0,
      totalCost: scenario?.totalCost ?? 0,
      totalProfit: scenario?.totalProfit ?? 0,
    },
    ledger: {
      periodCount: periods.length,
    },
    versions: {
      count: versions.length,
      releaseCount: versions.filter((version) => version.kind === 'release').length,
    },
    shares: {
      activeCount: shares.length,
    },
    audit: {
      executedActionCount: audits.length,
    },
  }
}

const TOOL_OBSERVATION_OUTCOMES = new Set<AgentToolObservationOutcome>([
  'completed_valid',
  'completed_invalid',
  'failed_repairable',
  'failed_terminal',
  'pending_human',
  'policy_blocked',
])

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : null
}

function outcomeValue(value: unknown): AgentToolObservationOutcome | null {
  return typeof value === 'string' && TOOL_OBSERVATION_OUTCOMES.has(value as AgentToolObservationOutcome)
    ? value as AgentToolObservationOutcome
    : null
}

function toolObservationOutcomesByCallId(runEvents: Row<'agent_run_events'>[]) {
  const outcomes = new Map<string, AgentToolObservationOutcome>()
  for (const event of runEvents) {
    const data = parseJson<Record<string, unknown>>(event.data_json, {})
    const runtimeEvent = recordValue(data.runtimeEvent)
    const payload = recordValue(runtimeEvent?.payload)
    const toolCallId = stringValue(runtimeEvent?.toolCallId)
    const outcome = outcomeValue(payload?.outcome)
    if (toolCallId && outcome) outcomes.set(toolCallId, outcome)
  }
  return outcomes
}

function planStepBoundaryOutcome(step: Row<'agent_plan_steps'>): AgentToolObservationOutcome | null {
  const args = parseJson<Record<string, unknown>>(step.tool_arguments_json, {})
  const boundaryCode = stringValue(args.boundaryCode)
  if (!boundaryCode) return null
  return isRepairableProviderBoundaryCode(boundaryCode) ? 'failed_repairable' : 'failed_terminal'
}

function planStepSandboxOutcome(step: Row<'agent_plan_steps'>): AgentToolObservationOutcome | null {
  if (step.tool_name !== 'sandbox_run_code') return null
  const facts = parseJson<Record<string, unknown>>(step.description, {})
  const sandboxStatus = stringValue(facts.status)
  const observationStatus: ToolObservationStatus =
    step.status === 'executed'
      ? 'completed'
      : sandboxStatus === 'blocked'
        ? 'not_executed'
        : step.status === 'cancelled'
          ? 'cancelled'
          : 'failed'
  return classifyToolObservationOutcome({
    toolName: 'sandbox_run_code',
    status: observationStatus,
    modelContent: JSON.stringify({
      observationType: 'sandbox_execution',
      manifestScoped: true,
      ...facts,
    }),
  })
}

function planStepObservationOutcome(
  step: Row<'agent_plan_steps'>,
  outcomesByCallId: Map<string, AgentToolObservationOutcome>,
): AgentToolObservationOutcome | null {
  const boundaryOutcome = planStepBoundaryOutcome(step)
  if (boundaryOutcome) return boundaryOutcome
  const sandboxOutcome = planStepSandboxOutcome(step)
  if (sandboxOutcome) return sandboxOutcome
  if (step.tool_call_id) {
    const eventOutcome = outcomesByCallId.get(step.tool_call_id)
    if (eventOutcome) return eventOutcome
  }
  return null
}

function isRepairableOutcome(outcome: AgentToolObservationOutcome | null) {
  return outcome === 'failed_repairable' || outcome === 'completed_invalid'
}

function repairableObservationIsOpen(
  step: Row<'agent_plan_steps'>,
  planSteps: Row<'agent_plan_steps'>[],
  outcomesByCallId: Map<string, AgentToolObservationOutcome>,
) {
  const outcome = planStepObservationOutcome(step, outcomesByCallId)
  if (!isRepairableOutcome(outcome)) return false
  return !planSteps.some((candidate) =>
    candidate.sequence_no > step.sequence_no &&
    candidate.tool_name === step.tool_name &&
    planStepObservationOutcome(candidate, outcomesByCallId) === 'completed_valid')
}

function isOperatingModelConfigAction(action: Row<'agent_action_requests'>) {
  return action.kind === 'workspace.update_draft' && payloadSource(action) === 'workspace_configure_operating_model'
}

function evaluatePlannedOperatingModelAction(action: Row<'agent_action_requests'>) {
  const config = payloadConfig(action)
  if (config && hasPositiveOperatingInput(config)) {
    return {
      findings: [],
      satisfied: ['graph.operating_model_inputs_planned'],
    }
  }
  return {
    findings: [finding({
      id: 'graph.operating_model_inputs_planned',
      criterionId: 'domain.goal_facts_match_outcome',
      severity: 'blocking',
      message: '经营模型确认卡缺少可验证的非零收入驱动或成本驱动输入，需要继续修复成员销量、场次、单价或成本结构。',
      evidence: { actionId: action.id, hasConfig: Boolean(config) },
    })],
    satisfied: [],
  }
}

function runtimeToolSignals(runEvents: Row<'agent_run_events'>[]) {
  const selectedCapabilities = new Set<AgentToolCapability>()
  const requiredActionCapabilities = new Set<AgentToolCapability>()
  for (const event of runEvents) {
    if (event.event_type !== 'tool_catalog_ready') continue
    const data = parseJson<Record<string, unknown>>(event.data_json, {})
    const selected = safeRuntimeCapabilities(data.selectedCapabilities)
    for (const capability of selected) selectedCapabilities.add(capability)
    for (const capability of safeRuntimeCapabilities(data.requiredActionCapabilities)) requiredActionCapabilities.add(capability)
  }
  return { selectedCapabilities, requiredActionCapabilities }
}

function safeRuntimeCapabilities(value: unknown): AgentToolCapability[] {
  const allowed = new Set<AgentToolCapability>([
    'data',
    'draft',
    'import_export',
    'ledger',
    'memory',
    'navigation',
    'sandbox',
    'share',
    'version',
  ])
  const values = Array.isArray(value) ? value : []
  return values.filter((item): item is AgentToolCapability => typeof item === 'string' && allowed.has(item as AgentToolCapability))
}

function actionCoversCapability(action: Row<'agent_action_requests'>, capability: AgentToolCapability) {
  if (capability === 'draft') return action.kind === 'workspace.update_draft' || action.kind === 'workspace.rename'
  if (capability === 'ledger') return action.kind.startsWith('ledger.')
  if (capability === 'share') return action.kind.startsWith('share.')
  if (capability === 'version') {
    return [
      'workspace.save_snapshot',
      'workspace.publish_release',
      'workspace.promote_version',
      'workspace.rollback_version',
      'workspace.delete_version',
      'workspace.reset_draft',
    ].includes(action.kind)
  }
  if (capability === 'import_export') return action.kind === 'workspace.import_bundle'
  return false
}

function clarificationMissingFields(planSteps: Row<'agent_plan_steps'>[]) {
  const fields = new Set<string>()
  for (const step of planSteps) {
    if (step.tool_name !== 'ask_user_clarification') continue
    const args = parseJson<Record<string, unknown>>(step.tool_arguments_json, {})
    const candidates = [args.missingFields]
    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue
      for (const item of candidate) {
        if (typeof item === 'string' && item.trim()) fields.add(item.trim())
      }
    }
  }
  return fields
}

function findingBlockedByClarification(item: AgentEvaluationFinding, missingFields: Set<string>) {
  if (missingFields.size === 0) return false
  if (item.id === 'runtime.capability.ledger_action_missing') {
    return ['memberName', 'monthLabel', 'offlineUnits', 'onlineUnits', 'amount', 'entryId', 'occurredAt']
      .some((field) => missingFields.has(field))
  }
  if (item.id === 'runtime.capability.draft_action_missing') {
    return ['shareholderName', 'currentInvestmentAmount', 'workspaceName', 'employeeName', 'costItemName']
      .some((field) => missingFields.has(field))
  }
  return false
}

function evaluateRuntimeToolCoverage(input: {
  runEvents: Row<'agent_run_events'>[]
  planSteps: Row<'agent_plan_steps'>[]
  actions: Row<'agent_action_requests'>[]
  facts: AgentGoalFacts
}) {
  const signals = runtimeToolSignals(input.runEvents)
  for (const capability of safeRuntimeCapabilities(input.facts.requiredActionCapabilities)) {
    signals.requiredActionCapabilities.add(capability)
  }
  const findings: AgentEvaluationFinding[] = []
  const satisfied: string[] = []

  for (const capability of signals.requiredActionCapabilities) {
    if (input.actions.some((action) => actionCoversCapability(action, capability))) {
      satisfied.push(`runtime.capability.${capability}_action`)
      continue
    }
    findings.push(finding({
      id: `runtime.capability.${capability}_action_missing`,
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: `Tool Context Engine 判定本轮需要 ${capability} 写入动作，但运行图还没有对应确认卡或执行结果。`,
      evidence: { capability },
    }))
  }

  if (
    input.facts.requiresSandboxComputation &&
    !input.planSteps.some((step) => step.tool_name === 'sandbox_run_code')
  ) {
    findings.push(finding({
      id: 'runtime.sandbox.observation_missing',
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: '目标契约要求可复核沙箱计算，但运行图还没有 sandbox_run_code 观察结果。',
      evidence: { fact: 'requiresSandboxComputation' },
    }))
  }

  return { findings, satisfied }
}

function evaluateGoalFacts(input: {
  facts: AgentGoalFacts
  actions: Row<'agent_action_requests'>[]
  observation: Awaited<ReturnType<typeof collectAgentObservation>>
}) {
  const findings: AgentEvaluationFinding[] = []
  const policyFindings: AgentEvaluationFinding[] = []
  const satisfied: string[] = []
  const forbiddenActions = new Set(input.facts.forbiddenActions ?? [])
  const plannedConfigs = input.actions
    .filter((action) => action.kind === 'workspace.update_draft')
    .map(payloadConfig)
    .filter((config): config is Record<string, any> => Boolean(config && typeof config === 'object'))
  const plannedWorkspaceNames = input.actions
    .map(payloadWorkspaceName)
    .filter((name): name is string => Boolean(name))

  if (input.facts.workspaceName) {
    if (input.observation.draft.workspaceName === input.facts.workspaceName || plannedWorkspaceNames.includes(input.facts.workspaceName)) {
      satisfied.push('goal.workspace_name')
    } else {
      findings.push(finding({
        id: 'goal.workspace_name',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: `目标要求工作区名称为 ${input.facts.workspaceName}，当前为 ${input.observation.draft.workspaceName}。`,
        evidence: { expected: input.facts.workspaceName, actual: input.observation.draft.workspaceName },
      }))
    }
  }

  if (input.facts.expectedMemberCount) {
    const plannedMatch = plannedConfigs.some((config) => Array.isArray(config.teamMembers) && config.teamMembers.length === input.facts.expectedMemberCount)
    if (input.observation.draft.teamMemberCount === input.facts.expectedMemberCount || plannedMatch) {
      satisfied.push('goal.expected_member_count')
    } else {
      findings.push(finding({
        id: 'goal.expected_member_count',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: `目标要求 ${input.facts.expectedMemberCount} 个成员，当前草稿为 ${input.observation.draft.teamMemberCount} 个。`,
        evidence: { expected: input.facts.expectedMemberCount, actual: input.observation.draft.teamMemberCount },
      }))
    }
  }

  if (input.facts.expectedShareholderCount) {
    const plannedMatch = plannedConfigs.some((config) => Array.isArray(config.shareholders) && config.shareholders.length === input.facts.expectedShareholderCount)
    if (input.observation.draft.shareholderCount === input.facts.expectedShareholderCount || plannedMatch) {
      satisfied.push('goal.expected_shareholder_count')
    } else {
      findings.push(finding({
        id: 'goal.expected_shareholder_count',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: `目标要求 ${input.facts.expectedShareholderCount} 个股东/分红主体，当前草稿为 ${input.observation.draft.shareholderCount} 个。`,
        evidence: { expected: input.facts.expectedShareholderCount, actual: input.observation.draft.shareholderCount },
      }))
    }
  }

  if (input.facts.expectedHorizonMonths) {
    const plannedMatch = plannedConfigs.some((config) => Array.isArray(config.months) && config.months.length === input.facts.expectedHorizonMonths)
    if (input.observation.draft.monthCount === input.facts.expectedHorizonMonths || plannedMatch) {
      satisfied.push('goal.expected_horizon_months')
    } else {
      findings.push(finding({
        id: 'goal.expected_horizon_months',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: `目标要求 ${input.facts.expectedHorizonMonths} 个月预测，当前草稿为 ${input.observation.draft.monthCount} 个月。`,
        evidence: { expected: input.facts.expectedHorizonMonths, actual: input.observation.draft.monthCount },
      }))
    }
  }

  if (input.facts.expectedStartMonth) {
    const plannedMatch = plannedConfigs.some((config) => config?.planning?.startMonth === input.facts.expectedStartMonth)
    if (input.observation.draft.startMonth === input.facts.expectedStartMonth || plannedMatch) {
      satisfied.push('goal.expected_start_month')
    } else {
      findings.push(finding({
        id: 'goal.expected_start_month',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: `目标要求从 ${input.facts.expectedStartMonth} 月开始，当前草稿从 ${input.observation.draft.startMonth} 月开始。`,
        evidence: { expected: input.facts.expectedStartMonth, actual: input.observation.draft.startMonth },
      }))
    }
  }

  if (input.facts.requiresForecastSummary) {
    if (input.observation.draft.totalRevenue > 0 || input.observation.draft.totalCost > 0 || plannedConfigs.some(hasPositiveOperatingInput)) {
      satisfied.push('goal.forecast_summary_computable')
    } else {
      findings.push(finding({
        id: 'goal.forecast_summary_computable',
        criterionId: 'domain.goal_facts_match_outcome',
        severity: 'blocking',
        message: '目标要求输出预测结果摘要，但当前草稿还不能计算有效收入或成本。',
        evidence: {
          totalRevenue: input.observation.draft.totalRevenue,
          totalCost: input.observation.draft.totalCost,
        },
      }))
    }
  }

  if (forbiddenActions.has('publish_release')) {
    const violating = input.actions.find((action) =>
      action.kind === 'workspace.publish_release' || action.kind === 'workspace.promote_version',
    )
    if (violating) {
      const item = finding({
        id: 'policy.no_publish_requested',
        criterionId: 'policy.no_forbidden_actions',
        severity: 'blocking',
        message: '用户明确要求先不要发布正式版本，但运行图包含发布动作。',
        evidence: { actionId: violating.id, kind: violating.kind },
      })
      findings.push(item)
      policyFindings.push(item)
    } else {
      satisfied.push('goal.no_publish_requested')
    }
  }

  if (forbiddenActions.has('share_link')) {
    const violating = input.actions.find((action) => action.kind === 'share.create')
    if (violating) {
      const item = finding({
        id: 'policy.no_share_requested',
        criterionId: 'policy.no_forbidden_actions',
        severity: 'blocking',
        message: '用户明确要求先不要创建分享链接，但运行图包含分享动作。',
        evidence: { actionId: violating.id, kind: violating.kind },
      })
      findings.push(item)
      policyFindings.push(item)
    } else {
      satisfied.push('goal.no_share_requested')
    }
  }

  return { findings, policyFindings, satisfied }
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
  allowComplete?: boolean
}): Promise<Row<'agent_evaluations'>> {
  const [planSteps, actions, observation, runEvents] = await Promise.all([
    input.db.selectFrom('agent_plan_steps').selectAll().where('run_id', '=', input.goal.run_id).orderBy('sequence_no', 'asc').execute(),
    input.db.selectFrom('agent_action_requests').selectAll().where('run_id', '=', input.goal.run_id).orderBy('created_at', 'asc').execute(),
    collectAgentObservation({ db: input.db, workspace: input.workspace }),
    input.db.selectFrom('agent_run_events').selectAll().where('run_id', '=', input.goal.run_id).orderBy('sequence_no', 'asc').execute(),
  ])

  const satisfied = new Set<string>(['policy.no_forbidden_actions', 'context.memory_scoped'])
  const unsatisfied: AgentEvaluationFinding[] = []
  const policyFindings: AgentEvaluationFinding[] = []
  const facts = mergeAgentGoalFacts(goalFactsFromRow(input.goal), runtimeGoalFacts(runEvents))

  if (planSteps.length > 0 || actions.length > 0) {
    satisfied.add('graph.visible_steps')
  } else {
    satisfied.add('graph.visible_steps')
  }

  const pendingActions = actions.filter((action) => action.status === 'pending')
  const failedActions = actions.filter((action) => action.status === 'failed')
  const failedSteps = planSteps.filter((step) => step.status === 'failed')
  const toolObservationOutcomes = toolObservationOutcomesByCallId(runEvents)
  const repairableObservationSteps = planSteps.filter((step) =>
    repairableObservationIsOpen(step, planSteps, toolObservationOutcomes))
  const repairableFailedSteps = failedSteps.filter((step) =>
    repairableObservationIsOpen(step, planSteps, toolObservationOutcomes))
  const terminalFailedSteps = failedSteps.filter((step) =>
    !isRepairableOutcome(planStepObservationOutcome(step, toolObservationOutcomes)))
  const emptyModelReadSteps = planSteps.filter((step) => step.title === '模型没有返回内容')
  const clarificationSteps = planSteps.filter((step) => step.title === '需要补充信息')

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

  if (failedActions.length > 0 || terminalFailedSteps.length > 0) {
    unsatisfied.push(finding({
      id: 'graph.failed_steps',
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: '运行图中存在失败步骤或失败确认卡，需要先修复再继续。',
      evidence: { failedActionCount: failedActions.length, failedStepCount: terminalFailedSteps.length },
    }))
  }

  if (repairableObservationSteps.length > 0) {
    unsatisfied.push(finding({
      id: 'graph.repairable_tool_observations',
      criterionId: 'graph.visible_steps',
      severity: 'blocking',
      message: '存在可由模型修复的工具观察结果，需要把 stderr、边界码或无效输出回放给模型继续处理。',
      evidence: {
        repairableStepCount: repairableObservationSteps.length,
        failedRepairableStepCount: repairableFailedSteps.length,
        toolNames: [...new Set(repairableObservationSteps.map((step) => step.tool_name).filter(Boolean))],
      },
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

  const latestPlannedOperatingModelAction = [...actions].reverse().find((action) =>
    action.status !== 'executed' && isOperatingModelConfigAction(action),
  )
  if (latestPlannedOperatingModelAction) {
    const result = evaluatePlannedOperatingModelAction(latestPlannedOperatingModelAction)
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

  const factResult = evaluateGoalFacts({ facts, actions, observation })
  factResult.satisfied.forEach((id) => satisfied.add(id))
  unsatisfied.push(...factResult.findings)
  policyFindings.push(...factResult.policyFindings)
  const toolCoverageResult = evaluateRuntimeToolCoverage({ runEvents, planSteps, actions, facts })
  toolCoverageResult.satisfied.forEach((id) => satisfied.add(id))
  unsatisfied.push(...toolCoverageResult.findings)
  const blockingFindings = unsatisfied.filter((item) => item.severity === 'blocking')
  const missingFields = clarificationMissingFields(planSteps)
  const independentBlockingFindings = blockingFindings.filter((item) => !findingBlockedByClarification(item, missingFields))

  const decision = decideAgentReadiness({
    policyFindings,
    failedActionCount: failedActions.length,
    terminalFailedStepCount: terminalFailedSteps.length,
    hasClarificationRequest: clarificationSteps.length > 0,
    blockingFindings,
    independentBlockingFindings,
    pendingActionCount: pendingActions.length,
    copy: XOX_READINESS_DECISION_COPY,
  })

  const row = await addEvaluationResult(input.db, input.goal, {
    iteration: input.iteration,
    status: decision.status,
    confidence: decision.confidence,
    satisfiedCriteria: [...satisfied],
    unsatisfiedCriteria: unsatisfied,
    policyFindings,
    nextPlannerBrief: decision.nextPlannerBrief,
    userQuestion: null,
    blocker: decision.blocker,
  })

  const goalStatus =
    decision.status === 'pass'
      ? input.allowComplete === false
        ? 'evaluating'
        : 'completed'
      : decision.status === 'needs_confirmation'
        ? 'waiting_for_confirmation'
        : decision.status === 'needs_clarification'
          ? 'needs_clarification'
        : decision.status === 'continue'
          ? 'repairing'
          : decision.status === 'blocked'
            ? 'blocked'
            : decision.status === 'failed'
              ? 'failed'
              : 'planning'
  await updateGoalStatus(input.db, input.goal, goalStatus, { blockedReason: decision.blocker })
  return row
}
