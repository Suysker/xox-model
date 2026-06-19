import type { AgentAutomationLevel, AgentToolSurfacePlan } from '@xox/contracts'
import type { JsonSchema } from '@agentic-os/contracts'
import {
  buildToolSurfaceManifests,
  buildToolSurfacePack as buildAgenticToolSurfacePack,
  canonicalToolNamesForCapabilities as agenticCanonicalToolNamesForCapabilities,
  type ToolSurfaceDiscoveryTrace,
  type ToolSurfaceManifest,
  type ToolSurfaceManifestOverride,
  type ToolSurfacePack,
  type ToolSurfaceRegistryEntry,
} from '@agentic-os/core'
import type {
  AgentToolCapability,
  AgentToolNavigationTarget,
  AgentToolRegistryEntry,
  ChatTool,
} from './tool-catalog.js'

export type ToolManifest = Omit<ToolSurfaceManifest<ChatTool>, 'capability' | 'navigationTarget'> & {
  capability: AgentToolCapability
  navigationTarget: AgentToolNavigationTarget
}

export type ToolDescriptor = ToolSurfacePack<ChatTool>['toolDescriptors'][number]

export type ToolDiscoveryTrace = Omit<ToolSurfaceDiscoveryTrace, 'selectedCapabilities' | 'rankedCandidates'> & {
  selectedCapabilities: AgentToolCapability[]
  rankedCandidates: Array<{
    name: string
    capability: AgentToolCapability
    score: number
    reasons: string[]
  }>
}

export type ToolContextPack = {
  strategy: 'progressive_tool_discovery'
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities: AgentToolCapability[]
  effectiveCatalog: ToolManifest[]
  visibleTools: ChatTool[]
  visibleToolNames: string[]
  kernelToolNames: string[]
  materializableToolNames: string[]
  deferredCatalog: ToolManifest[]
  replayAllowedToolNames: string[]
  autoAddedControlNames: string[]
  emptySurfaceStatus:
    | 'has_callable_tools'
    | 'direct_answer_only'
    | 'needs_clarification'
    | 'needs_tool_search'
    | 'fail_closed'
  budget: AgentToolSurfacePlan['budget']
  surfacePlan: AgentToolSurfacePlan
  tools: ChatTool[]
  toolNames: string[]
  toolDescriptors: ToolDescriptor[]
  discoveryTrace: ToolDiscoveryTrace
}

const ENTITY_FACT_TOOL = 'data_query_workspace'

export const KERNEL_TOOL_NAMES = [
  'tool_discover',
  'rg',
  'data_query_workspace',
  'sandbox_run_code',
  'ask_user_clarification',
  'account_forbidden',
] as const

const FACT_DEPENDENT_CAPABILITIES: AgentToolCapability[] = [
  'draft',
  'ledger',
  'share',
  'version',
]

const CANONICAL_TOOLS_BY_CAPABILITY: Partial<Record<AgentToolCapability, string[]>> = {
  data: ['data_query_workspace'],
  draft: ['workspace_patch_config', 'workspace_configure_operating_model', 'workspace_rename'],
  import_export: ['workspace_export_bundle', 'workspace_import_bundle'],
  ledger: ['ledger_create_member_income', 'ledger_create_entry'],
  memory: ['memory_search', 'memory_remember'],
  navigation: ['ui_navigate'],
  sandbox: ['sandbox_run_code'],
  share: ['share_create', 'share_revoke'],
  tooling: ['tool_discover', 'rg'],
  version: ['workspace_save_snapshot', 'workspace_publish_release', 'workspace_rollback_version'],
}

const MANIFEST_OVERRIDES: Record<string, ToolSurfaceManifestOverride> = {
  account_forbidden: {
    title: '拒绝账号操作',
    searchHints: ['注销账号', '删除账号', '退出登录', '改密码', '账号安全'],
    entityTags: ['account'],
  },
  ask_user_clarification: {
    title: '询问缺失信息',
    searchHints: ['补充信息', '确认缺失字段', '无法唯一确定', '需要确认'],
    entityTags: ['clarification'],
  },
  tool_discover: {
    title: '查找可用工具',
    summary: '在当前授权工具目录中查找下一步需要的工具，并返回短描述供下一轮物化真实 schema。',
    searchHints: ['tool search', 'tool discover', 'find tools', 'materialize tools', '工具搜索', '查找工具', '物化工具'],
    entityTags: ['tooling'],
  },
  rg: {
    title: '搜索工具文档',
    summary: '在 manifest 授权的工具文档、同轮 observation 文档和 sandbox SDK 文档中执行只读搜索。',
    searchHints: ['rg', 'ripgrep', 'search manifest', 'search tools', 'search sdk', '搜索工具文档', '搜索函数', '查找参数'],
    entityTags: ['tooling', 'manifest', 'sandbox'],
  },
  cost_item_add: {
    title: '新增成本项',
    searchHints: ['增加成本类型', '新增固定成本', '新增每场成本', '新增每张成本'],
    entityTags: ['cost', 'model_config'],
  },
  cost_item_delete: {
    title: '删除成本项',
    searchHints: ['删除成本类型', '移除固定成本', '删除每场成本', '删除每张成本'],
    entityTags: ['cost', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  data_query_workspace: {
    title: '查询工作区数据',
    summary: '查询回本、利润、现金、成员、股东、账本摘要和预实分析。',
    searchHints: ['payback', 'ROI', 'profit', 'cash', 'members', 'shareholders', 'ledger history', 'variance analysis', '回本', '几个月回本', '利润', '现金', '成员列表', '股东列表', '账本记录', '预实分析', '当前数据'],
    entityTags: ['workspace', 'forecast', 'member', 'shareholder', 'ledger', 'period'],
    resolvesFacts: ['workspace_summary', 'periods', 'members', 'shareholders', 'ledger_entries', 'model_config', 'payback'],
  },
  employee_add: {
    title: '新增员工',
    searchHints: ['新增员工', '添加员工', '员工岗位', '招聘员工'],
    entityTags: ['employee', 'model_config'],
  },
  employee_delete: {
    title: '删除员工',
    searchHints: ['删除员工', '移除员工'],
    entityTags: ['employee', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_entry: {
    title: '通用收支入账',
    searchHints: ['普通收入', '其他收入', '普通支出', '员工支出', '成员支出', '记账', '入账', '支出入账'],
    entityTags: ['ledger', 'period', 'income', 'expense', 'employee', 'member'],
    requiredFacts: ['period', 'subject'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_member_income: {
    title: '记录成员收入',
    searchHints: ['成员收入', '线上张数', '线下张数', '拍立得', '销售入账', '成员入账', '记一笔'],
    entityTags: ['ledger', 'period', 'member', 'income'],
    requiredFacts: ['period', 'member'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_planned_member_income_batch: {
    title: '一键入账成员收入',
    searchHints: ['一键入账', '按计划入账', '所有成员收入', '批量成员收入'],
    entityTags: ['ledger', 'period', 'member', 'batch'],
    requiredFacts: ['period', 'members'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_planned_related_expense_batch: {
    title: '一键入账按人支出',
    searchHints: ['批量支出', '成员底薪入账', '员工月薪入账', '按人支出'],
    entityTags: ['ledger', 'period', 'member', 'employee', 'batch'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_restore_entry: {
    title: '恢复分录',
    searchHints: ['取消作废', '恢复分录', '恢复入账'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_set_period_lock: {
    title: '锁定或解锁账期',
    searchHints: ['锁账', '解锁', '封账', '账期锁定'],
    entityTags: ['ledger', 'period'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_update_entry: {
    title: '修改历史分录',
    searchHints: ['修改分录', '修改历史入账', '改账', '更新账本记录'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_void_entry: {
    title: '作废分录',
    searchHints: ['作废', '撤销入账', '删除分录', '精确作废'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  memory_get: {
    title: '读取精确记忆',
    searchHints: ['读取记忆', '记忆详情', '已记住规则'],
    entityTags: ['memory'],
  },
  memory_remember: {
    title: '保存长期记忆',
    searchHints: ['记住', '以后默认', '长期偏好', '默认习惯'],
    entityTags: ['memory'],
  },
  memory_search: {
    title: '检索相关记忆',
    searchHints: ['查记忆', '回忆', '以前说过', '默认偏好'],
    entityTags: ['memory'],
  },
  sandbox_run_code: {
    title: '运行受控计算',
    searchHints: ['运行代码', '复杂计算', '解析文件', '转换文件', '校验表格', '生成文件', '模拟'],
    entityTags: ['sandbox', 'file', 'calculation'],
  },
  share_create: {
    title: '创建分享链接',
    searchHints: ['分享链接', '创建分享', '公开分享'],
    entityTags: ['share', 'version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  share_revoke: {
    title: '撤销分享链接',
    searchHints: ['撤销分享', '取消分享', '删除分享链接'],
    entityTags: ['share', 'version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  shareholder_add: {
    title: '新增股东',
    searchHints: ['新增股东', '添加股东', '新股东', '投资人'],
    entityTags: ['shareholder', 'model_config'],
  },
  shareholder_delete: {
    title: '删除股东',
    searchHints: ['删除股东', '移除股东'],
    entityTags: ['shareholder', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  stage_cost_type_add: {
    title: '新增专项成本类型',
    searchHints: ['新增专项成本', '活动成本类型', '一次性成本类型'],
    entityTags: ['cost', 'model_config'],
  },
  stage_cost_type_delete: {
    title: '删除专项成本类型',
    searchHints: ['删除专项成本', '移除活动成本'],
    entityTags: ['cost', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  team_member_add: {
    title: '新增成员',
    searchHints: ['新增成员', '添加成员', '新建成员', '成员保底', '成员提成'],
    entityTags: ['member', 'model_config'],
  },
  team_member_delete: {
    title: '删除成员',
    searchHints: ['删除成员', '移除成员', '删掉成员'],
    entityTags: ['member', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ui_navigate: {
    title: '打开页面',
    searchHints: ['打开页面', '切到页面', '跳转', '打开面板'],
    entityTags: ['navigation'],
  },
  workspace_configure_operating_model: {
    title: '配置完整经营模型',
    searchHints: ['完整经营模型', '经营简报', '12个月预测', '50个成员', '多个股东', '批量建模', '启动测算'],
    entityTags: ['workspace', 'model_config', 'shareholder', 'member', 'employee', 'cost', 'forecast'],
    requiredFacts: ['business_brief'],
  },
  workspace_delete_version: {
    title: '删除版本',
    searchHints: ['删除版本', '删除快照', '删除发布版'],
    entityTags: ['version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_export_bundle: {
    title: '导出工作区',
    searchHints: ['导出', '导出bundle', '备份工作区'],
    entityTags: ['import_export', 'workspace'],
  },
  workspace_import_bundle: {
    title: '导入工作区',
    searchHints: ['导入', '恢复bundle', '导入备份'],
    entityTags: ['import_export', 'workspace'],
  },
  workspace_patch_config: {
    title: '修改模型草稿',
    searchHints: ['修改模型', '股东注资', '追加投资', '投资额', '分红比例', '调模型', '保存草稿', '成本结构', '预测输入', '线下单价', '线上单价', '单价', '价格'],
    entityTags: ['workspace', 'model_config', 'shareholder', 'member', 'employee', 'cost'],
    requiredFacts: ['model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_promote_version: {
    title: '快照发布为正式版',
    searchHints: ['快照发布', '发布快照', '转正式版'],
    entityTags: ['version', 'release'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_publish_release: {
    title: '发布正式版',
    searchHints: ['发布版本', '发布正式版', '创建发布版'],
    entityTags: ['version', 'release'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_rename: {
    title: '重命名工作区',
    searchHints: ['工作区改名', '项目改名', '重命名项目'],
    entityTags: ['workspace', 'model_config'],
  },
  workspace_reset_draft: {
    title: '重置草稿',
    searchHints: ['重置草稿', '恢复默认模型', '覆盖当前草稿'],
    entityTags: ['workspace', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_rollback_version: {
    title: '恢复版本',
    searchHints: ['恢复版本', '回滚版本', '恢复发布版'],
    entityTags: ['version', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_save_snapshot: {
    title: '保存快照',
    searchHints: ['保存快照', '创建快照', '保存版本'],
    entityTags: ['version'],
  },
  workspace_update_online_factor: {
    title: '试算或保存线上系数',
    searchHints: ['线上系数', '如果系数变成', '利润会怎样', '试算', '保存系数'],
    entityTags: ['forecast', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
}

function toolSurfaceEntry(entry: AgentToolRegistryEntry): ToolSurfaceRegistryEntry<ChatTool> {
  return {
    name: entry.name,
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
    providerSchema: entry.tool,
    description: entry.tool.function.description,
    title: entry.name.split('_').filter(Boolean).join(' '),
    inputJsonSchema: entry.tool.function.parameters as unknown as JsonSchema,
    navigationTarget: entry.navigationTarget,
  }
}

function asToolManifest(value: ToolSurfaceManifest<ChatTool>): ToolManifest {
  return value as ToolManifest
}

function asToolDiscoveryTrace(value: ToolSurfaceDiscoveryTrace): ToolDiscoveryTrace {
  return value as ToolDiscoveryTrace
}

function asToolContextPack(pack: ToolSurfacePack<ChatTool>): ToolContextPack {
  const effectiveCatalog = pack.effectiveCatalog.map(asToolManifest)
  const deferredCatalog = pack.deferredCatalog.map(asToolManifest)
  const surfacePlan: AgentToolSurfacePlan = {
    schemaVersion: 'xox.tool_surface.v2',
    turnLane: 'agent_goal',
    effectiveCatalog: pack.surfacePlan.effectiveCatalog,
    kernelToolNames: pack.surfacePlan.kernelToolNames,
    visibleToolNames: pack.surfacePlan.visibleToolNames,
    materializableToolNames: pack.surfacePlan.materializableToolNames,
    deferredToolNames: pack.surfacePlan.deferredToolNames,
    replayAllowedToolNames: pack.surfacePlan.replayAllowedToolNames,
    autoAddedControlNames: pack.surfacePlan.autoAddedControlNames,
    capabilityHints: pack.surfacePlan.capabilityHints,
    budget: pack.surfacePlan.budget,
    emptySurfaceStatus: pack.surfacePlan.emptySurfaceStatus,
    discoveryTraceId: pack.surfacePlan.discoveryTraceId,
  }

  return {
    strategy: 'progressive_tool_discovery',
    selectedCapabilities: pack.selectedCapabilities as AgentToolCapability[],
    requiredActionCapabilities: pack.requiredActionCapabilities as AgentToolCapability[],
    effectiveCatalog,
    visibleTools: pack.visibleTools,
    visibleToolNames: pack.visibleToolNames,
    kernelToolNames: pack.kernelToolNames,
    materializableToolNames: pack.materializableToolNames,
    deferredCatalog,
    replayAllowedToolNames: pack.replayAllowedToolNames,
    autoAddedControlNames: pack.autoAddedControlNames,
    emptySurfaceStatus: pack.emptySurfaceStatus,
    budget: pack.budget,
    surfacePlan,
    tools: pack.tools,
    toolNames: pack.toolNames,
    toolDescriptors: pack.toolDescriptors,
    discoveryTrace: asToolDiscoveryTrace(pack.discoveryTrace),
  }
}

export function canonicalToolNamesForCapabilities(capabilities: AgentToolCapability[]) {
  return agenticCanonicalToolNamesForCapabilities(capabilities, CANONICAL_TOOLS_BY_CAPABILITY)
}

export function buildToolManifests(entries: AgentToolRegistryEntry[]): ToolManifest[] {
  return buildToolSurfaceManifests(entries.map(toolSurfaceEntry), {
    overrides: MANIFEST_OVERRIDES,
    kernelToolNames: KERNEL_TOOL_NAMES,
  }).map(asToolManifest)
}

export function buildToolContextPack(input: {
  registry: AgentToolRegistryEntry[]
  selectedCapabilities: AgentToolCapability[]
  requiredActionCapabilities?: AgentToolCapability[]
  requiredToolNames?: string[]
  message?: string
  routerReason?: string
  automationLevel?: AgentAutomationLevel
}): ToolContextPack {
  const pack = buildAgenticToolSurfacePack({
    registry: input.registry.map(toolSurfaceEntry),
    overrides: MANIFEST_OVERRIDES,
    kernelToolNames: KERNEL_TOOL_NAMES,
    canonicalToolsByCapability: CANONICAL_TOOLS_BY_CAPABILITY,
    factDependentCapabilities: FACT_DEPENDENT_CAPABILITIES,
    selectedCapabilities: input.selectedCapabilities,
    requiredActionCapabilities: input.requiredActionCapabilities ?? [],
    ...(input.requiredToolNames !== undefined ? { requiredToolNames: input.requiredToolNames } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.routerReason !== undefined ? { routerReason: input.routerReason } : {}),
  })
  return asToolContextPack(pack)
}
