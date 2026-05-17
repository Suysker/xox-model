import type { ModelConfig } from '@xox/domain'

export type AgentEditableFieldDescriptor = {
  path: string
  label: string
  valueType: 'string' | 'number' | 'boolean' | 'enum'
  route: 'capital' | 'revenue' | 'cost'
  pattern?: string
}

export type AgentManualCapabilityDescriptor = {
  capability: string
  surface: string
  agentTool: string
  status: 'supported' | 'manual_only'
  reason?: string
}

export const AGENT_MANUAL_CAPABILITY_COVERAGE: AgentManualCapabilityDescriptor[] = [
  { capability: 'capital_planning', surface: '调模型 / 股东投资', agentTool: 'shareholder_add + shareholder_delete + workspace_patch_config', status: 'supported' },
  { capability: 'revenue_engine', surface: '调模型 / 收入引擎', agentTool: 'workspace_patch_config + workspace_update_online_factor', status: 'supported' },
  { capability: 'team_members', surface: '调模型 / 团队成员假设', agentTool: 'team_member_add + team_member_delete + workspace_patch_config', status: 'supported' },
  { capability: 'cost_structure', surface: '调模型 / 成本编辑', agentTool: 'cost_item_add + cost_item_delete + stage_cost_type_add + stage_cost_type_delete + workspace_patch_config', status: 'supported' },
  { capability: 'employees', surface: '调模型 / 运营员工配置', agentTool: 'employee_add + employee_delete + workspace_patch_config', status: 'supported' },
  { capability: 'bookkeeping_entries', surface: '记实际 / 账本', agentTool: 'ledger_create_member_income + ledger_create_entry + ledger_create_planned_member_income_batch + ledger_create_planned_related_expense_batch + ledger_update_entry + ledger_void_entry + ledger_restore_entry + ledger_set_period_lock', status: 'supported' },
  { capability: 'bookkeeping_history_filters', surface: '记实际 / 账本历史', agentTool: 'data_query_workspace(scope=ledger_history)', status: 'supported' },
  { capability: 'variance_deep_questions', surface: '预实分析 / 偏差明细', agentTool: 'data_query_workspace(scope=variance_detail)', status: 'supported' },
  { capability: 'versions_and_shares', surface: '版本管理', agentTool: 'workspace_rename + workspace_save_snapshot + workspace_publish_release + workspace_promote_version + workspace_rollback_version + workspace_delete_version + share_create + share_revoke', status: 'supported' },
  { capability: 'workspace_import_export', surface: '版本管理 / 导入导出 JSON', agentTool: 'workspace_export_bundle + workspace_import_bundle', status: 'supported' },
  { capability: 'account_actions', surface: '账号入口', agentTool: 'account_forbidden', status: 'manual_only', reason: '登录、退出、注销、删除账号和改密码影响账号安全，不允许 Agent 自动执行。' },
]

const STATIC_EDITABLE_FIELDS: AgentEditableFieldDescriptor[] = [
  { path: 'planning.startMonth', label: '起始月份', valueType: 'number', route: 'capital' },
  { path: 'planning.horizonMonths', label: '规划月份', valueType: 'number', route: 'capital' },
  { path: 'operating.offlineUnitPrice', label: '线下单价', valueType: 'number', route: 'revenue' },
  { path: 'operating.onlineUnitPrice', label: '线上单价', valueType: 'number', route: 'revenue' },
  { path: 'operating.polaroidLossRate', label: '拍立得损耗率', valueType: 'number', route: 'revenue' },
  { path: 'timelineTemplate.events', label: '默认场次', valueType: 'number', route: 'revenue' },
  { path: 'timelineTemplate.salesMultiplier', label: '默认销售系数', valueType: 'number', route: 'revenue' },
  { path: 'timelineTemplate.onlineSalesFactor', label: '默认线上系数', valueType: 'number', route: 'revenue' },
  { path: 'timelineTemplate.rehearsalCount', label: '默认排练次数', valueType: 'number', route: 'cost' },
  { path: 'timelineTemplate.rehearsalCost', label: '默认单次排练费', valueType: 'number', route: 'cost' },
  { path: 'timelineTemplate.teacherCount', label: '默认老师次数', valueType: 'number', route: 'cost' },
  { path: 'timelineTemplate.teacherCost', label: '默认单次老师费', valueType: 'number', route: 'cost' },
]

const STATIC_EDITABLE_PATTERNS = [
  'operating.monthlyFixedCosts[n].name',
  'operating.monthlyFixedCosts[n].amount',
  'operating.perEventCosts[n].name',
  'operating.perEventCosts[n].amount',
  'operating.perUnitCosts[n].name',
  'operating.perUnitCosts[n].amount',
  'operating.monthlyFixedCosts.add',
  'operating.monthlyFixedCosts.delete',
  'operating.perEventCosts.add',
  'operating.perEventCosts.delete',
  'operating.perUnitCosts.add',
  'operating.perUnitCosts.delete',
  'shareholders[n].name',
  'shareholders[n].investmentAmount',
  'shareholders[n].dividendRate',
  'shareholders.add',
  'shareholders.delete',
  'stageCostItems[n].name',
  'stageCostItems[n].mode',
  'stageCostItems.add',
  'stageCostItems.delete',
  'timelineTemplate.specialCosts[n].amount',
  'timelineTemplate.specialCosts[n].count',
  'teamMembers[n].name',
  'teamMembers[n].employmentType',
  'teamMembers[n].monthlyBasePay',
  'teamMembers[n].perEventTravelCost',
  'teamMembers[n].departureMonthIndex',
  'teamMembers[n].commissionRate',
  'teamMembers[n].unitsPerEvent.pessimistic',
  'teamMembers[n].unitsPerEvent.base',
  'teamMembers[n].unitsPerEvent.optimistic',
  'teamMembers.add',
  'teamMembers.delete',
  'employees[n].name',
  'employees[n].role',
  'employees[n].monthlyBasePay',
  'employees[n].perEventCost',
  'employees.add',
  'employees.delete',
  'workspace.name',
  'months[n].events',
  'months[n].salesMultiplier',
  'months[n].onlineSalesFactor',
  'months[n].rehearsalCount',
  'months[n].rehearsalCost',
  'months[n].teacherCount',
  'months[n].teacherCost',
  'months[n].specialCosts[m].amount',
  'months[n].specialCosts[m].count',
] as const

function addIndexedFields(
  fields: AgentEditableFieldDescriptor[],
  count: number,
  builder: (index: number) => AgentEditableFieldDescriptor[],
) {
  for (let index = 0; index < count; index += 1) {
    fields.push(...builder(index))
  }
}

export function buildAgentWritableConfigCatalog(config: ModelConfig): AgentEditableFieldDescriptor[] {
  const fields = [...STATIC_EDITABLE_FIELDS]

  addIndexedFields(fields, config.shareholders.length, (index) => [
    { path: `shareholders[${index}].name`, label: `股东 ${index + 1} 名称`, valueType: 'string', route: 'capital', pattern: 'shareholders[n].name' },
    { path: `shareholders[${index}].investmentAmount`, label: `股东 ${index + 1} 投资额`, valueType: 'number', route: 'capital', pattern: 'shareholders[n].investmentAmount' },
    { path: `shareholders[${index}].dividendRate`, label: `股东 ${index + 1} 分红比例`, valueType: 'number', route: 'capital', pattern: 'shareholders[n].dividendRate' },
  ])

  addIndexedFields(fields, config.operating.monthlyFixedCosts.length, (index) => [
    { path: `operating.monthlyFixedCosts[${index}].name`, label: `月固定成本 ${index + 1} 名称`, valueType: 'string', route: 'cost', pattern: 'operating.monthlyFixedCosts[n].name' },
    { path: `operating.monthlyFixedCosts[${index}].amount`, label: `月固定成本 ${index + 1} 金额`, valueType: 'number', route: 'cost', pattern: 'operating.monthlyFixedCosts[n].amount' },
  ])
  addIndexedFields(fields, config.operating.perEventCosts.length, (index) => [
    { path: `operating.perEventCosts[${index}].name`, label: `按场成本 ${index + 1} 名称`, valueType: 'string', route: 'cost', pattern: 'operating.perEventCosts[n].name' },
    { path: `operating.perEventCosts[${index}].amount`, label: `按场成本 ${index + 1} 金额`, valueType: 'number', route: 'cost', pattern: 'operating.perEventCosts[n].amount' },
  ])
  addIndexedFields(fields, config.operating.perUnitCosts.length, (index) => [
    { path: `operating.perUnitCosts[${index}].name`, label: `按张成本 ${index + 1} 名称`, valueType: 'string', route: 'cost', pattern: 'operating.perUnitCosts[n].name' },
    { path: `operating.perUnitCosts[${index}].amount`, label: `按张成本 ${index + 1} 金额`, valueType: 'number', route: 'cost', pattern: 'operating.perUnitCosts[n].amount' },
  ])

  addIndexedFields(fields, config.stageCostItems.length, (index) => [
    { path: `stageCostItems[${index}].name`, label: `专项成本 ${index + 1} 名称`, valueType: 'string', route: 'cost', pattern: 'stageCostItems[n].name' },
    { path: `stageCostItems[${index}].mode`, label: `专项成本 ${index + 1} 计费方式`, valueType: 'enum', route: 'cost', pattern: 'stageCostItems[n].mode' },
    { path: `timelineTemplate.specialCosts[${index}].amount`, label: `默认专项成本 ${index + 1} 单价`, valueType: 'number', route: 'cost', pattern: 'timelineTemplate.specialCosts[n].amount' },
    { path: `timelineTemplate.specialCosts[${index}].count`, label: `默认专项成本 ${index + 1} 数量/系数`, valueType: 'number', route: 'cost', pattern: 'timelineTemplate.specialCosts[n].count' },
  ])

  addIndexedFields(fields, config.teamMembers.length, (index) => [
    { path: `teamMembers[${index}].name`, label: `成员 ${index + 1} 名称`, valueType: 'string', route: 'revenue', pattern: 'teamMembers[n].name' },
    { path: `teamMembers[${index}].employmentType`, label: `成员 ${index + 1} 合作类型`, valueType: 'enum', route: 'revenue', pattern: 'teamMembers[n].employmentType' },
    { path: `teamMembers[${index}].monthlyBasePay`, label: `成员 ${index + 1} 底薪`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].monthlyBasePay' },
    { path: `teamMembers[${index}].perEventTravelCost`, label: `成员 ${index + 1} 每场路费`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].perEventTravelCost' },
    { path: `teamMembers[${index}].departureMonthIndex`, label: `成员 ${index + 1} 离队月份`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].departureMonthIndex' },
    { path: `teamMembers[${index}].commissionRate`, label: `成员 ${index + 1} 提成比例`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].commissionRate' },
    { path: `teamMembers[${index}].unitsPerEvent.pessimistic`, label: `成员 ${index + 1} 保守单场销量`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].unitsPerEvent.pessimistic' },
    { path: `teamMembers[${index}].unitsPerEvent.base`, label: `成员 ${index + 1} 基准单场销量`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].unitsPerEvent.base' },
    { path: `teamMembers[${index}].unitsPerEvent.optimistic`, label: `成员 ${index + 1} 乐观单场销量`, valueType: 'number', route: 'revenue', pattern: 'teamMembers[n].unitsPerEvent.optimistic' },
  ])

  addIndexedFields(fields, config.employees.length, (index) => [
    { path: `employees[${index}].name`, label: `员工 ${index + 1} 名称`, valueType: 'string', route: 'cost', pattern: 'employees[n].name' },
    { path: `employees[${index}].role`, label: `员工 ${index + 1} 岗位`, valueType: 'string', route: 'cost', pattern: 'employees[n].role' },
    { path: `employees[${index}].monthlyBasePay`, label: `员工 ${index + 1} 月固定薪酬`, valueType: 'number', route: 'cost', pattern: 'employees[n].monthlyBasePay' },
    { path: `employees[${index}].perEventCost`, label: `员工 ${index + 1} 每场补贴`, valueType: 'number', route: 'cost', pattern: 'employees[n].perEventCost' },
  ])

  addIndexedFields(fields, config.months.length, (index) => [
    { path: `months[${index}].events`, label: `月份 ${index + 1} 场次`, valueType: 'number', route: 'revenue', pattern: 'months[n].events' },
    { path: `months[${index}].salesMultiplier`, label: `月份 ${index + 1} 销售系数`, valueType: 'number', route: 'revenue', pattern: 'months[n].salesMultiplier' },
    { path: `months[${index}].onlineSalesFactor`, label: `月份 ${index + 1} 线上系数`, valueType: 'number', route: 'revenue', pattern: 'months[n].onlineSalesFactor' },
    { path: `months[${index}].rehearsalCount`, label: `月份 ${index + 1} 排练次数`, valueType: 'number', route: 'cost', pattern: 'months[n].rehearsalCount' },
    { path: `months[${index}].rehearsalCost`, label: `月份 ${index + 1} 单次排练费`, valueType: 'number', route: 'cost', pattern: 'months[n].rehearsalCost' },
    { path: `months[${index}].teacherCount`, label: `月份 ${index + 1} 老师次数`, valueType: 'number', route: 'cost', pattern: 'months[n].teacherCount' },
    { path: `months[${index}].teacherCost`, label: `月份 ${index + 1} 单次老师费`, valueType: 'number', route: 'cost', pattern: 'months[n].teacherCost' },
    ...config.stageCostItems.flatMap((_, stageIndex) => [
      { path: `months[${index}].specialCosts[${stageIndex}].amount`, label: `月份 ${index + 1} 专项 ${stageIndex + 1} 单价`, valueType: 'number' as const, route: 'cost' as const, pattern: 'months[n].specialCosts[m].amount' },
      { path: `months[${index}].specialCosts[${stageIndex}].count`, label: `月份 ${index + 1} 专项 ${stageIndex + 1} 数量/系数`, valueType: 'number' as const, route: 'cost' as const, pattern: 'months[n].specialCosts[m].count' },
    ]),
  ])

  return fields
}

export function agentWritableConfigPatterns(config: ModelConfig) {
  return Array.from(new Set([
    ...STATIC_EDITABLE_PATTERNS,
    ...buildAgentWritableConfigCatalog(config).map((field) => field.pattern ?? field.path),
  ])).sort()
}

export function buildAgentWritableConfigContext(config: ModelConfig) {
  const catalog = buildAgentWritableConfigCatalog(config)
  const sampleFields = catalog.filter((field) => {
    if (!field.pattern) return true
    return /\[0\]/.test(field.path) || /\[1\]/.test(field.path)
  })

  return {
    patterns: agentWritableConfigPatterns(config),
    sampleFields: sampleFields.map((field) => ({
      path: field.path,
      label: field.label,
      valueType: field.valueType,
      route: field.route,
      pattern: field.pattern,
    })),
    manualCapabilityCoverage: AGENT_MANUAL_CAPABILITY_COVERAGE,
  }
}
