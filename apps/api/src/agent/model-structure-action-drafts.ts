import {
  createCostItem,
  createEmployee,
  createMember,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
  hydrateModelConfig,
  type CostCategory,
  type CostItem,
  type Employee,
  type EmploymentType,
  type ModelConfig,
  type Shareholder,
  type StageCostItem,
  type StageCostMode,
  type TeamMember,
} from '@xox/domain'
import type { AgentNavigationEvent } from '@xox/contracts'
import { newId } from '../core/security.js'
import type { PlannerContext } from './planning-context.js'
import type { AgentActionDraft } from './action-draft-builder.js'
import type { ReadDraft, RuntimePlannerStep } from './action-draft-builder.js'
import { currentDraftConfig, findEmployee, findTeamMember, finiteNumber, normalizedMemberKey } from './action-draft-utils.js'
import { cloneModelConfig } from './config-patch.js'

function memberWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'revenue' },
    reason,
  }
}

function capitalWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'capital' },
    reason,
  }
}

function costWorkbenchNavigation(reason: string): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'inputs', secondaryTab: 'cost' },
    reason,
  }
}

function normalizedCommissionRate(value: unknown) {
  const number = finiteNumber(value)
  if (number === null) return null
  return number > 1 && number <= 100 ? Math.round((number / 100) * 10000) / 10000 : number
}

function isEmploymentType(value: unknown): value is EmploymentType {
  return value === 'salary' || value === 'partTime'
}

function defaultTeamMemberName(config: ModelConfig) {
  const existing = new Set(config.teamMembers.map((member) => normalizedMemberKey(member.name)))
  let index = config.teamMembers.length + 1
  while (existing.has(normalizedMemberKey(`成员 ${index}`))) index += 1
  return `成员 ${index}`
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function applyTeamMemberToolFields(member: TeamMember, step: RuntimePlannerStep) {
  const next: TeamMember = {
    ...member,
    unitsPerEvent: { ...member.unitsPerEvent },
  }
  if (isEmploymentType(step.employmentType)) next.employmentType = step.employmentType

  const monthlyBasePay = finiteNumber(step.monthlyBasePay)
  if (monthlyBasePay !== null) next.monthlyBasePay = monthlyBasePay

  const perEventTravelCost = finiteNumber(step.perEventTravelCost)
  if (perEventTravelCost !== null) next.perEventTravelCost = perEventTravelCost

  if (step.departureMonthIndex === null) {
    next.departureMonthIndex = null
  } else {
    const departureMonthIndex = finiteNumber(step.departureMonthIndex)
    if (departureMonthIndex !== null) next.departureMonthIndex = departureMonthIndex
  }

  const commissionRate = normalizedCommissionRate(step.commissionRate)
  if (commissionRate !== null) next.commissionRate = commissionRate

  const pessimisticUnits = finiteNumber(step.pessimisticUnitsPerEvent)
  if (pessimisticUnits !== null) next.unitsPerEvent.pessimistic = pessimisticUnits

  const baseUnits = finiteNumber(step.baseUnitsPerEvent)
  if (baseUnits !== null) next.unitsPerEvent.base = baseUnits

  const optimisticUnits = finiteNumber(step.optimisticUnitsPerEvent)
  if (optimisticUnits !== null) next.unitsPerEvent.optimistic = optimisticUnits

  return next
}

export async function planAddTeamMemberFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = firstNonEmptyString(step.newMemberName, step.memberName, step.name)
  const name = requestedName || defaultTeamMemberName(config)
  if (config.teamMembers.some((member) => normalizedMemberKey(member.name) === normalizedMemberKey(name))) {
    return {
      title: '成员已存在',
      message: `当前团队里已经有“${name}”。如果要新增同名成员，请先给出一个可区分的姓名或编号。`,
      status: 'failed',
      navigation: memberWorkbenchNavigation('新增成员需要打开团队成员假设供核对。'),
    } satisfies ReadDraft
  }

  const member = applyTeamMemberToolFields(createMember(newId(), { name }), step)
  const nextConfig = cloneModelConfig(config)
  nextConfig.teamMembers = [...nextConfig.teamMembers, member]
  const normalized = hydrateModelConfig(nextConfig)

  return {
    kind: 'workspace.update_draft',
    title: '确认新增团队成员',
    summary: `新增团队成员“${member.name}”，保存后后续测算会把该成员纳入收入、提成和成本计算。`,
    targetLabel: member.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增团队成员' },
      { label: '成员名称', value: member.name },
      { label: '成员数变化', value: `${config.teamMembers.length} -> ${normalized.teamMembers.length}` },
      { label: '合作类型', value: member.employmentType === 'salary' ? '底薪制' : '兼职/分成制' },
      { label: '底薪', value: `${member.monthlyBasePay}` },
      { label: '每场路费', value: `${member.perEventTravelCost}` },
      { label: '提成比例', value: `${member.commissionRate}` },
      { label: '基准场均销量', value: `${member.unitsPerEvent.base}` },
    ],
    navigation: memberWorkbenchNavigation('新增成员属于团队成员假设，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'teamMembers', value: normalized.teamMembers, label: '团队成员列表' }],
    },
  } satisfies AgentActionDraft
}

export async function planDeleteTeamMemberFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const memberName = firstNonEmptyString(step.memberName, step.newMemberName, step.name)
  const target = findTeamMember(config, { memberId: step.memberId, memberName })
  const navigation = memberWorkbenchNavigation('删除成员需要打开团队成员假设供核对。')

  if (!step.memberId && !memberName) {
    return {
      title: '需要指定要删除的成员',
      message: `请告诉我要删除哪位成员。当前成员有：${config.teamMembers.map((member) => member.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的成员',
      message: `当前工作区没有匹配“${memberName || step.memberId}”的成员。当前成员有：${config.teamMembers.map((member) => member.name).join('、')}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  if (config.teamMembers.length <= 1) {
    return {
      title: '不能删除最后一个成员',
      message: '不能删除最后一个成员：当前团队只剩 1 个成员。为了保持模型可计算，Agent 不会生成删除最后一个成员的确认卡。',
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = cloneModelConfig(config)
  nextConfig.teamMembers = nextConfig.teamMembers.filter((member) => member.id !== target.id)
  const normalized = hydrateModelConfig(nextConfig)

  return {
    kind: 'workspace.update_draft',
    title: '确认删除团队成员',
    summary: `删除团队成员“${target.name}”。历史账本分录不会被删除，但后续测算不再包含该成员。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除团队成员' },
      { label: '成员名称', value: target.name },
      { label: '成员 ID', value: target.id },
      { label: '成员数变化', value: `${config.teamMembers.length} -> ${normalized.teamMembers.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本和账本分录不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'teamMembers', value: normalized.teamMembers, label: '团队成员列表' }],
    },
  } satisfies AgentActionDraft
}

function defaultEmployeeName(config: ModelConfig) {
  const existing = new Set(config.employees.map((employee) => normalizedMemberKey(employee.name)))
  let index = config.employees.length + 1
  while (existing.has(normalizedMemberKey(`员工 ${index}`))) index += 1
  return `员工 ${index}`
}

function applyEmployeeToolFields(employee: Employee, step: RuntimePlannerStep) {
  const next: Employee = { ...employee }
  if (typeof step.role === 'string' && step.role.trim()) next.role = step.role.trim()
  const monthlyBasePay = finiteNumber(step.monthlyBasePay)
  if (monthlyBasePay !== null) next.monthlyBasePay = monthlyBasePay
  const perEventCost = finiteNumber(step.perEventCost)
  if (perEventCost !== null) next.perEventCost = perEventCost
  return next
}

export async function planAddEmployeeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = firstNonEmptyString(step.newEmployeeName, step.employeeName, step.name)
  const name = requestedName || defaultEmployeeName(config)
  if (config.employees.some((employee) => normalizedMemberKey(employee.name) === normalizedMemberKey(name))) {
    return {
      title: '员工已存在',
      message: `当前员工列表里已经有“${name}”。如果要新增同名员工，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增员工需要打开运营员工配置供核对。'),
    } satisfies ReadDraft
  }

  const employee = applyEmployeeToolFields(createEmployee(newId(), { name }), step)
  const normalized = hydrateModelConfig({
    ...cloneModelConfig(config),
    employees: [...config.employees, employee],
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认新增员工',
    summary: `新增运营员工“${employee.name}”，保存后员工月薪和场次成本会进入后续测算。`,
    targetLabel: employee.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增员工' },
      { label: '员工名称', value: employee.name },
      { label: '岗位', value: employee.role },
      { label: '员工数变化', value: `${config.employees.length} -> ${normalized.employees.length}` },
      { label: '月固定薪酬', value: `${employee.monthlyBasePay}` },
      { label: '每场补贴', value: `${employee.perEventCost}` },
    ],
    navigation: costWorkbenchNavigation('新增员工属于运营员工配置，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'employees', value: normalized.employees, label: '运营员工列表' }],
    },
  } satisfies AgentActionDraft
}

export async function planDeleteEmployeeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = costWorkbenchNavigation('删除员工需要打开运营员工配置供核对。')
  const employeeName = firstNonEmptyString(step.employeeName, step.newEmployeeName, step.name)
  const target = findEmployee(config, { employeeId: step.employeeId, employeeName })

  if (!step.employeeId && !employeeName) {
    return {
      title: '需要指定要删除的员工',
      message: `请告诉我要删除哪位员工。当前员工有：${config.employees.map((employee) => employee.name).join('、') || '暂无员工'}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的员工',
      message: `当前工作区没有匹配“${employeeName || step.employeeId}”的员工。当前员工有：${config.employees.map((employee) => employee.name).join('、') || '暂无员工'}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const normalized = hydrateModelConfig({
    ...cloneModelConfig(config),
    employees: config.employees.filter((employee) => employee.id !== target.id),
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认删除员工',
    summary: `删除运营员工“${target.name}”。历史账本分录不会被删除，但后续测算不再包含该员工。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除员工' },
      { label: '员工名称', value: target.name },
      { label: '员工 ID', value: target.id },
      { label: '员工数变化', value: `${config.employees.length} -> ${normalized.employees.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本和账本分录不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: normalized,
      patches: [{ path: 'employees', value: normalized.employees, label: '运营员工列表' }],
    },
  } satisfies AgentActionDraft
}

function shareholderNameForIndex(index: number) {
  return index >= 1 && index <= 26 ? `股东 ${String.fromCharCode(64 + index)}` : `股东 ${index}`
}

function defaultShareholderName(config: ModelConfig) {
  const existing = new Set(config.shareholders.map((shareholder) => normalizedMemberKey(shareholder.name)))
  let index = config.shareholders.length + 1
  while (existing.has(normalizedMemberKey(shareholderNameForIndex(index)))) index += 1
  return shareholderNameForIndex(index)
}

function findShareholder(config: ModelConfig, input: { shareholderId?: string | null | undefined; shareholderName?: string | null | undefined }) {
  const shareholderId = typeof input.shareholderId === 'string' ? input.shareholderId.trim() : ''
  if (shareholderId) {
    const byId = config.shareholders.find((shareholder) => shareholder.id === shareholderId)
    if (byId) return byId
  }

  const shareholderName = typeof input.shareholderName === 'string' ? input.shareholderName.trim() : ''
  if (!shareholderName) return null
  const normalized = normalizedMemberKey(shareholderName)
  return config.shareholders.find((shareholder) => shareholder.id === shareholderName || normalizedMemberKey(shareholder.name) === normalized) ?? null
}

function applyShareholderToolFields(shareholder: Shareholder, step: RuntimePlannerStep) {
  const next: Shareholder = { ...shareholder }
  const investmentAmount = finiteNumber(step.investmentAmount)
  if (investmentAmount !== null) next.investmentAmount = investmentAmount
  const dividendRate = normalizedCommissionRate(step.dividendRate)
  if (dividendRate !== null) next.dividendRate = dividendRate
  return next
}

export async function planAddShareholderFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = firstNonEmptyString(step.newShareholderName, step.shareholderName, step.name)
  const name = requestedName || defaultShareholderName(config)
  if (config.shareholders.some((shareholder) => normalizedMemberKey(shareholder.name) === normalizedMemberKey(name))) {
    return {
      title: '股东已存在',
      message: `当前股东列表里已经有“${name}”。如果要新增同名股东，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: capitalWorkbenchNavigation('新增股东需要打开股东投资页面供核对。'),
    } satisfies ReadDraft
  }

  const shareholder = applyShareholderToolFields(createShareholder(newId(), { name }), step)
  const nextConfig = hydrateModelConfig({
    ...cloneModelConfig(config),
    shareholders: [...config.shareholders, shareholder],
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认新增股东',
    summary: `新增股东“${shareholder.name}”，保存后投资额和分红比例会进入后续测算。`,
    targetLabel: shareholder.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增股东' },
      { label: '股东名称', value: shareholder.name },
      { label: '股东数变化', value: `${config.shareholders.length} -> ${nextConfig.shareholders.length}` },
      { label: '投资额', value: `${shareholder.investmentAmount}` },
      { label: '分红比例', value: `${shareholder.dividendRate}` },
    ],
    navigation: capitalWorkbenchNavigation('新增股东属于股东投资设置，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'shareholders', value: nextConfig.shareholders, label: '股东列表' }],
    },
  } satisfies AgentActionDraft
}

export async function planDeleteShareholderFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = capitalWorkbenchNavigation('删除股东需要打开股东投资页面供核对。')
  const shareholderName = firstNonEmptyString(step.shareholderName, step.newShareholderName, step.name)
  const target = findShareholder(config, { shareholderId: step.shareholderId, shareholderName })

  if (!step.shareholderId && !shareholderName) {
    return {
      title: '需要指定要删除的股东',
      message: `请告诉我要删除哪位股东。当前股东有：${config.shareholders.map((shareholder) => shareholder.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  if (!target) {
    return {
      title: '没有找到要删除的股东',
      message: `当前工作区没有匹配“${shareholderName || step.shareholderId}”的股东。当前股东有：${config.shareholders.map((shareholder) => shareholder.name).join('、')}。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  if (config.shareholders.length <= 1) {
    return {
      title: '不能删除最后一个股东',
      message: '不能删除最后一个股东：当前资本结构只剩 1 个股东。为了保持投资与分红模型可计算，Agent 不会生成删除最后一个股东的确认卡。',
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = hydrateModelConfig({
    ...cloneModelConfig(config),
    shareholders: config.shareholders.filter((shareholder) => shareholder.id !== target.id),
  })

  return {
    kind: 'workspace.update_draft',
    title: '确认删除股东',
    summary: `删除股东“${target.name}”。历史版本不会被改写，当前草稿的资本结构会更新。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除股东' },
      { label: '股东名称', value: target.name },
      { label: '股东 ID', value: target.id },
      { label: '股东数变化', value: `${config.shareholders.length} -> ${nextConfig.shareholders.length}` },
      { label: '审计说明', value: '仅覆盖当前草稿；历史版本不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'shareholders', value: nextConfig.shareholders, label: '股东列表' }],
    },
  } satisfies AgentActionDraft
}

const costCategoryKeys: Record<CostCategory, 'monthlyFixedCosts' | 'perEventCosts' | 'perUnitCosts'> = {
  monthlyFixed: 'monthlyFixedCosts',
  perEvent: 'perEventCosts',
  perUnit: 'perUnitCosts',
}

const costCategoryLabels: Record<CostCategory, string> = {
  monthlyFixed: '每月固定成本',
  perEvent: '每场成本',
  perUnit: '每张成本',
}

function isCostCategory(value: unknown): value is CostCategory {
  return value === 'monthlyFixed' || value === 'perEvent' || value === 'perUnit'
}

function costItemsForCategory(config: ModelConfig, category: CostCategory) {
  return config.operating[costCategoryKeys[category]]
}

function defaultCostItemName(config: ModelConfig, category: CostCategory) {
  const items = costItemsForCategory(config, category)
  const existing = new Set(items.map((item) => normalizedMemberKey(item.name)))
  let index = items.length + 1
  while (existing.has(normalizedMemberKey(`${costCategoryLabels[category]} ${index}`))) index += 1
  return `${costCategoryLabels[category]} ${index}`
}

function setCostItems(config: ModelConfig, category: CostCategory, items: CostItem[]) {
  const nextConfig = cloneModelConfig(config)
  const key = costCategoryKeys[category]
  nextConfig.operating = {
    ...nextConfig.operating,
    [key]: items,
  }
  return hydrateModelConfig(nextConfig)
}

type CostItemLookup =
  | { status: 'found'; category: CostCategory; item: CostItem }
  | { status: 'ambiguous'; matches: Array<{ category: CostCategory; item: CostItem }> }
  | { status: 'missing' }

function findCostItem(config: ModelConfig, input: { category?: CostCategory | null; costItemId?: string | null | undefined; costItemName?: string | null | undefined }): CostItemLookup {
  const categories: CostCategory[] = input.category ? [input.category] : ['monthlyFixed', 'perEvent', 'perUnit']
  const costItemId = typeof input.costItemId === 'string' ? input.costItemId.trim() : ''
  const costItemName = typeof input.costItemName === 'string' ? input.costItemName.trim() : ''
  const normalizedName = normalizedMemberKey(costItemName)
  const matches: Array<{ category: CostCategory; item: CostItem }> = []

  for (const category of categories) {
    for (const item of costItemsForCategory(config, category)) {
      if (costItemId && item.id === costItemId) matches.push({ category, item })
      if (!costItemId && costItemName && (item.id === costItemName || normalizedMemberKey(item.name) === normalizedName)) {
        matches.push({ category, item })
      }
    }
  }

  if (matches.length === 1) return { status: 'found', ...matches[0]! }
  if (matches.length > 1) return { status: 'ambiguous', matches }
  return { status: 'missing' }
}

export async function planAddCostItemFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  if (!isCostCategory(step.costCategory)) {
    return {
      title: '需要指定成本归属',
      message: '请说明要新增的是每月固定成本、每场成本还是每张成本。',
      status: 'info',
      navigation: costWorkbenchNavigation('新增基础成本项需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const { draft, config } = await currentDraftConfig(ctx)
  const category = step.costCategory
  const items = costItemsForCategory(config, category)
  const requestedName = firstNonEmptyString(step.newCostItemName, step.costItemName, step.name)
  const name = requestedName || defaultCostItemName(config, category)
  if (items.some((item) => normalizedMemberKey(item.name) === normalizedMemberKey(name))) {
    return {
      title: '成本项已存在',
      message: `${costCategoryLabels[category]}里已经有“${name}”。如果要新增同名成本项，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增基础成本项需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const amount = finiteNumber(step.amount) ?? 0
  const item = createCostItem(newId(), { name, amount })
  const nextConfig = setCostItems(config, category, [...items, item])

  return {
    kind: 'workspace.update_draft',
    title: '确认新增基础成本项',
    summary: `新增${costCategoryLabels[category]}“${item.name}”，金额 ${item.amount} 元。`,
    targetLabel: item.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增基础成本项' },
      { label: '成本归属', value: costCategoryLabels[category] },
      { label: '成本名称', value: item.name },
      { label: '金额', value: `${item.amount}` },
      { label: '数量变化', value: `${items.length} -> ${costItemsForCategory(nextConfig, category).length}` },
    ],
    navigation: costWorkbenchNavigation('新增基础成本项属于成本编辑，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: `operating.${costCategoryKeys[category]}`, value: costItemsForCategory(nextConfig, category), label: costCategoryLabels[category] }],
    },
  } satisfies AgentActionDraft
}

export async function planDeleteCostItemFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const category = isCostCategory(step.costCategory) ? step.costCategory : null
  const navigation = costWorkbenchNavigation('删除基础成本项需要打开成本编辑页面供核对。')
  const costItemName = firstNonEmptyString(step.costItemName, step.newCostItemName, step.name)
  if (!step.costItemId && !costItemName) {
    return {
      title: '需要指定要删除的成本项',
      message: '请告诉我要删除哪个成本项；如果同名成本项可能存在于多个分类，请同时说明每月固定、每场或每张。',
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  const lookup = findCostItem(config, { category, costItemId: step.costItemId, costItemName })
  if (lookup.status === 'ambiguous') {
    return {
      title: '需要指定成本项分类',
      message: `找到多个同名成本项：${lookup.matches.map((match) => `${costCategoryLabels[match.category]} / ${match.item.name}`).join('、')}。请补充要删除哪一类。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }
  if (lookup.status === 'missing') {
    return {
      title: '没有找到要删除的成本项',
      message: `当前工作区没有匹配“${costItemName || step.costItemId}”的基础成本项。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const items = costItemsForCategory(config, lookup.category)
  const nextConfig = setCostItems(config, lookup.category, items.filter((item) => item.id !== lookup.item.id))

  return {
    kind: 'workspace.update_draft',
    title: '确认删除基础成本项',
    summary: `删除${costCategoryLabels[lookup.category]}“${lookup.item.name}”。历史版本不会被改写，当前草稿成本结构会更新。`,
    targetLabel: lookup.item.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除基础成本项' },
      { label: '成本归属', value: costCategoryLabels[lookup.category] },
      { label: '成本名称', value: lookup.item.name },
      { label: '金额', value: `${lookup.item.amount}` },
      { label: '数量变化', value: `${items.length} -> ${costItemsForCategory(nextConfig, lookup.category).length}` },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: `operating.${costCategoryKeys[lookup.category]}`, value: costItemsForCategory(nextConfig, lookup.category), label: costCategoryLabels[lookup.category] }],
    },
  } satisfies AgentActionDraft
}

function isStageCostMode(value: unknown): value is StageCostMode {
  return value === 'monthly' || value === 'perEvent' || value === 'perUnit'
}

function defaultStageCostName(config: ModelConfig) {
  const existing = new Set(config.stageCostItems.map((item) => normalizedMemberKey(item.name)))
  let index = config.stageCostItems.length + 1
  while (existing.has(normalizedMemberKey(`专项成本 ${index}`))) index += 1
  return `专项成本 ${index}`
}

function findStageCostItem(config: ModelConfig, input: { stageCostItemId?: string | null | undefined; stageCostItemName?: string | null | undefined }) {
  const stageCostItemId = typeof input.stageCostItemId === 'string' ? input.stageCostItemId.trim() : ''
  if (stageCostItemId) {
    const byId = config.stageCostItems.find((item) => item.id === stageCostItemId)
    if (byId) return byId
  }

  const stageCostItemName = typeof input.stageCostItemName === 'string' ? input.stageCostItemName.trim() : ''
  if (!stageCostItemName) return null
  const normalized = normalizedMemberKey(stageCostItemName)
  return config.stageCostItems.find((item) => item.id === stageCostItemName || normalizedMemberKey(item.name) === normalized) ?? null
}

function syncStageCostItemsForPlanner(config: ModelConfig, stageCostItems: StageCostItem[], defaultValue?: { itemId: string; amount: number; count: number }) {
  const nextConfig = cloneModelConfig(config)
  const addDefault = (values: Array<{ itemId: string; amount?: number; count?: number }>) =>
    defaultValue && !values.some((value) => value.itemId === defaultValue.itemId)
      ? [...values, defaultValue]
      : values

  nextConfig.stageCostItems = stageCostItems
  nextConfig.timelineTemplate = {
    ...nextConfig.timelineTemplate,
    specialCosts: createStageCostValues(stageCostItems, addDefault(nextConfig.timelineTemplate.specialCosts)),
  }
  nextConfig.months = nextConfig.months.map((month) => ({
    ...month,
    specialCosts: createStageCostValues(stageCostItems, addDefault(month.specialCosts)),
  }))
  return hydrateModelConfig(nextConfig)
}

export async function planAddStageCostTypeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const requestedName = firstNonEmptyString(
    step.newStageCostItemName,
    step.newStageCostTypeName,
    step.stageCostItemName,
    step.costTypeName,
    step.newCostTypeName,
    step.name,
  )
  const name = requestedName || defaultStageCostName(config)
  if (config.stageCostItems.some((item) => normalizedMemberKey(item.name) === normalizedMemberKey(name))) {
    return {
      title: '成本类型已存在',
      message: `当前专项成本类型里已经有“${name}”。如果要新增同名类型，请先给出一个可区分的名称。`,
      status: 'failed',
      navigation: costWorkbenchNavigation('新增专项成本类型需要打开成本编辑页面供核对。'),
    } satisfies ReadDraft
  }

  const mode = isStageCostMode(step.costMode) ? step.costMode : 'perEvent'
  const item = createStageCostItem(newId(), { name, mode })
  const amount = finiteNumber(step.amount) ?? 0
  const defaultCount = mode === 'perEvent' ? 0 : 1
  const count = finiteNumber(step.count) ?? defaultCount
  const defaultValue = step.amount !== undefined || step.count !== undefined
    ? { itemId: item.id, amount, count }
    : undefined
  const nextConfig = syncStageCostItemsForPlanner(config, [...config.stageCostItems, item], defaultValue)

  return {
    kind: 'workspace.update_draft',
    title: '确认新增专项成本类型',
    summary: `新增专项成本类型“${item.name}”，计费方式为 ${mode === 'monthly' ? '每月' : mode === 'perEvent' ? '每场' : '每张'}。`,
    targetLabel: item.name,
    riskLevel: 'medium',
    details: [
      { label: '动作', value: '新增专项成本类型' },
      { label: '成本类型', value: item.name },
      { label: '计费方式', value: mode === 'monthly' ? '每月' : mode === 'perEvent' ? '每场' : '每张' },
      { label: '默认金额', value: `${amount}` },
      { label: '默认数量/系数', value: `${count}` },
      { label: '类型数变化', value: `${config.stageCostItems.length} -> ${nextConfig.stageCostItems.length}` },
    ],
    navigation: costWorkbenchNavigation('新增专项成本类型属于成本编辑，先打开调模型页面供核对。'),
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'stageCostItems', value: nextConfig.stageCostItems, label: '专项成本类型' }],
    },
  } satisfies AgentActionDraft
}

export async function planDeleteStageCostTypeFromStep(ctx: PlannerContext, step: RuntimePlannerStep) {
  const { draft, config } = await currentDraftConfig(ctx)
  const navigation = costWorkbenchNavigation('删除专项成本类型需要打开成本编辑页面供核对。')
  const stageCostItemName = firstNonEmptyString(
    step.stageCostItemName,
    step.newStageCostItemName,
    step.newStageCostTypeName,
    step.costTypeName,
    step.newCostTypeName,
    step.name,
  )
  if (!step.stageCostItemId && !stageCostItemName) {
    return {
      title: '需要指定要删除的成本类型',
      message: `请告诉我要删除哪个专项成本类型。当前类型有：${config.stageCostItems.map((item) => item.name).join('、')}。`,
      status: 'info',
      navigation,
    } satisfies ReadDraft
  }

  const target = findStageCostItem(config, { stageCostItemId: step.stageCostItemId, stageCostItemName })
  if (!target) {
    return {
      title: '没有找到要删除的成本类型',
      message: `当前工作区没有匹配“${stageCostItemName || step.stageCostItemId}”的专项成本类型。`,
      status: 'failed',
      navigation,
    } satisfies ReadDraft
  }

  const nextConfig = syncStageCostItemsForPlanner(config, config.stageCostItems.filter((item) => item.id !== target.id))

  return {
    kind: 'workspace.update_draft',
    title: '确认删除专项成本类型',
    summary: `删除专项成本类型“${target.name}”，并从模板和所有月份成本表中移除该类型的值。`,
    targetLabel: target.name,
    riskLevel: 'high',
    details: [
      { label: '动作', value: '删除专项成本类型' },
      { label: '成本类型', value: target.name },
      { label: '计费方式', value: target.mode === 'monthly' ? '每月' : target.mode === 'perEvent' ? '每场' : '每张' },
      { label: '类型数变化', value: `${config.stageCostItems.length} -> ${nextConfig.stageCostItems.length}` },
      { label: '审计说明', value: '当前草稿的模板和全部月份成本表会同步移除该类型；历史版本不被删除。' },
    ],
    navigation,
    payload: {
      revision: draft.revision,
      workspaceName: ctx.workspace.name,
      config: nextConfig,
      patches: [{ path: 'stageCostItems', value: nextConfig.stageCostItems, label: '专项成本类型' }],
    },
  } satisfies AgentActionDraft
}
