import { AGENT_TOOL_CATALOG, type ChatTool } from './tool-catalog.js'

export type AgentToolCapability =
  | 'account'
  | 'clarification'
  | 'data'
  | 'draft'
  | 'import_export'
  | 'ledger'
  | 'navigation'
  | 'share'
  | 'version'

export type AgentToolRiskLevel = 'read' | 'low' | 'medium' | 'high'

export type AgentToolMetadata = {
  name: string
  capability: AgentToolCapability
  riskLevel: AgentToolRiskLevel
  requiresConfirmation: boolean
  navigationTarget: 'bookkeeping' | 'dashboard' | 'inputs' | 'variance' | 'workspace' | null
}

type ToolProjectionInput = {
  message: string
}

const TOOL_METADATA: Record<string, Omit<AgentToolMetadata, 'name'>> = {
  account_forbidden: { capability: 'account', riskLevel: 'read', requiresConfirmation: false, navigationTarget: null },
  ask_user_clarification: { capability: 'clarification', riskLevel: 'read', requiresConfirmation: false, navigationTarget: null },
  cost_item_add: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  cost_item_delete: { capability: 'draft', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  data_query_workspace: { capability: 'data', riskLevel: 'read', requiresConfirmation: false, navigationTarget: null },
  employee_add: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  employee_delete: { capability: 'draft', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  ledger_create_entry: { capability: 'ledger', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_create_member_income: { capability: 'ledger', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_create_planned_member_income_batch: { capability: 'ledger', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_create_planned_related_expense_batch: { capability: 'ledger', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_restore_entry: { capability: 'ledger', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_set_period_lock: { capability: 'ledger', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_update_entry: { capability: 'ledger', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  ledger_void_entry: { capability: 'ledger', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'bookkeeping' },
  share_create: { capability: 'share', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  share_revoke: { capability: 'share', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'workspace' },
  shareholder_add: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  shareholder_delete: { capability: 'draft', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  stage_cost_type_add: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  stage_cost_type_delete: { capability: 'draft', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  team_member_add: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  team_member_delete: { capability: 'draft', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  ui_navigate: { capability: 'navigation', riskLevel: 'read', requiresConfirmation: false, navigationTarget: null },
  workspace_delete_version: { capability: 'version', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_export_bundle: { capability: 'import_export', riskLevel: 'read', requiresConfirmation: false, navigationTarget: 'workspace' },
  workspace_import_bundle: { capability: 'import_export', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_patch_config: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
  workspace_promote_version: { capability: 'version', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_publish_release: { capability: 'version', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_rename: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_reset_draft: { capability: 'version', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'inputs' },
  workspace_rollback_version: { capability: 'version', riskLevel: 'high', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_save_snapshot: { capability: 'version', riskLevel: 'low', requiresConfirmation: true, navigationTarget: 'workspace' },
  workspace_update_online_factor: { capability: 'draft', riskLevel: 'medium', requiresConfirmation: true, navigationTarget: 'inputs' },
}

export const AGENT_TOOL_REGISTRY = AGENT_TOOL_CATALOG.map((tool) => {
  const name = tool.function.name
  const metadata = TOOL_METADATA[name]
  if (!metadata) throw new Error(`Agent tool metadata missing for ${name}`)
  return { name, tool, ...metadata } satisfies AgentToolMetadata & { tool: ChatTool }
})

const TOOLS_BY_NAME = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry.tool]))

function compactMessage(message: string) {
  return message.replace(/\s+/g, '').toLocaleLowerCase()
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text))
}

function addCapability(names: Set<string>, capability: AgentToolCapability) {
  for (const entry of AGENT_TOOL_REGISTRY) {
    if (entry.capability === capability) names.add(entry.name)
  }
}

function addTools(names: Set<string>, toolNames: string[]) {
  for (const name of toolNames) names.add(name)
}

export function projectAgentTools(input: ToolProjectionInput): ChatTool[] {
  const text = compactMessage(input.message)
  const names = new Set<string>(['ask_user_clarification', 'ui_navigate'])

  const accountIntent = hasAny(text, [/注销|删除账号|退出登录|登录|注册|改密码|密码/])
  if (accountIntent) {
    names.clear()
    addTools(names, ['account_forbidden', 'ask_user_clarification'])
    return [...names].map((name) => TOOLS_BY_NAME.get(name)).filter((tool): tool is ChatTool => Boolean(tool))
  }

  const ledgerIntent = hasAny(text, [
    /记账|入账|过账|分录|账本|作废|撤销入账|取消入账|恢复分录|取消作废|锁账|封账|解锁|支出|收款|付款/,
    /线下\d+(?:\.\d+)?张|线上\d+(?:\.\d+)?张/,
  ])
  const writeVerbIntent = hasAny(text, [/新增|添加|删除|移除|改成|修改|保存|重命名|改名|调整|设置|设计/])
  const draftIntent = hasAny(text, [
    /调模型|模型|草稿|线上系数|收入引擎|收入预测|成本预测/,
  ]) || (writeVerbIntent && hasAny(text, [/成本|收入|成员|员工|股东|模块|预测/]))
  const dataIntent = hasAny(text, [
    /几个|多少|哪些|名单|告诉|查询|分析|预实|偏差|利润|成本|收入|回本|roi|会怎样|如果|筛选|排行|历史/,
  ])
  const versionIntent = hasAny(text, [
    /版本|快照|发布|正式版|分享|链接|回滚|恢复到|恢复为|重置草稿|重置工作区/,
  ])
  const importExportIntent = hasAny(text, [/导入|导出|bundle|json|工作区包/])
  const navigationIntent = hasAny(text, [/打开|切到|进入|查看|页面|面板|工作台|看测算|调模型|记实际|看偏差/])
  const complexBusinessIntent = hasAny(text, [
    /多个|多笔|一堆|批量|一步|同时|然后|并且|以及|设计/,
  ]) && (ledgerIntent || draftIntent || dataIntent)

  if (ledgerIntent || complexBusinessIntent) addCapability(names, 'ledger')
  if (draftIntent || complexBusinessIntent) addCapability(names, 'draft')
  if (dataIntent || complexBusinessIntent) addCapability(names, 'data')
  if (versionIntent) {
    addCapability(names, 'version')
    addCapability(names, 'share')
  }
  if (importExportIntent) addCapability(names, 'import_export')
  if (navigationIntent) addCapability(names, 'navigation')

  if (text.includes('分享') || text.includes('链接')) addCapability(names, 'share')
  if (text.includes('导出') || text.includes('导入')) addCapability(names, 'import_export')

  if (names.size <= 2 && !navigationIntent) {
    addCapability(names, 'data')
  }

  return [...names].map((name) => TOOLS_BY_NAME.get(name)).filter((tool): tool is ChatTool => Boolean(tool))
}

export function projectedToolNames(input: ToolProjectionInput) {
  return projectAgentTools(input).map((tool) => tool.function.name)
}
