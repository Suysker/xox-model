import type {
  AgentToolCapability,
  AgentToolConfirmationMode,
  AgentToolNavigationTarget,
  AgentToolRegistryEntry,
  AgentToolRiskLevel,
  ChatTool,
} from '../tool-catalog.js'

export type ToolManifest = {
  name: string
  capability: AgentToolCapability
  title: string
  summary: string
  aliases: string[]
  entityTags: string[]
  parameterNames: string[]
  riskLevel: AgentToolRiskLevel
  confirmationMode: AgentToolConfirmationMode
  navigationTarget: AgentToolNavigationTarget
  requiredFacts: string[]
  resolvesFacts: string[]
  prerequisiteTools: string[]
  providerSchema: ChatTool
}

type ToolManifestOverride = Partial<Pick<ToolManifest,
  'title' |
  'summary' |
  'aliases' |
  'entityTags' |
  'requiredFacts' |
  'resolvesFacts' |
  'prerequisiteTools'
>>

const ENTITY_FACT_TOOL = 'data_query_workspace'

const MANIFEST_OVERRIDES: Record<string, ToolManifestOverride> = {
  account_forbidden: {
    title: '拒绝账号操作',
    aliases: ['注销账号', '删除账号', '退出登录', '改密码', '账号安全'],
    entityTags: ['account'],
  },
  ask_user_clarification: {
    title: '询问缺失信息',
    aliases: ['补充信息', '确认缺失字段', '无法唯一确定', '需要确认'],
    entityTags: ['clarification'],
  },
  cost_item_add: {
    title: '新增成本项',
    aliases: ['增加成本类型', '新增固定成本', '新增每场成本', '新增每张成本'],
    entityTags: ['cost', 'model_config'],
  },
  cost_item_delete: {
    title: '删除成本项',
    aliases: ['删除成本类型', '移除固定成本', '删除每场成本', '删除每张成本'],
    entityTags: ['cost', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  data_query_workspace: {
    title: '查询工作区数据',
    summary: '查询回本、利润、现金、成员、股东、账本摘要和预实分析。',
    aliases: ['回本', '几个月回本', 'ROI', '利润', '现金', '成员列表', '股东列表', '账本记录', '预实分析', '当前数据', '第一个股东', '成员A'],
    entityTags: ['workspace', 'forecast', 'member', 'shareholder', 'ledger', 'period'],
    resolvesFacts: ['workspace_summary', 'periods', 'members', 'shareholders', 'ledger_entries', 'model_config', 'payback'],
  },
  employee_add: {
    title: '新增员工',
    aliases: ['新增员工', '添加员工', '员工岗位', '招聘员工'],
    entityTags: ['employee', 'model_config'],
  },
  employee_delete: {
    title: '删除员工',
    aliases: ['删除员工', '移除员工'],
    entityTags: ['employee', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_entry: {
    title: '通用收支入账',
    aliases: ['普通收入', '其他收入', '普通支出', '员工支出', '成员支出', '记账', '入账', '支出入账'],
    entityTags: ['ledger', 'period', 'income', 'expense', 'employee', 'member'],
    requiredFacts: ['period', 'subject'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_member_income: {
    title: '记录成员收入',
    aliases: ['成员收入', '线上张数', '线下张数', '线上10张', '拍立得', '销售入账', '成员入账', '记一笔'],
    entityTags: ['ledger', 'period', 'member', 'income'],
    requiredFacts: ['period', 'member'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_planned_member_income_batch: {
    title: '一键入账成员收入',
    aliases: ['一键入账', '按计划入账', '所有成员收入', '批量成员收入'],
    entityTags: ['ledger', 'period', 'member', 'batch'],
    requiredFacts: ['period', 'members'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_create_planned_related_expense_batch: {
    title: '一键入账按人支出',
    aliases: ['批量支出', '成员底薪入账', '员工月薪入账', '按人支出'],
    entityTags: ['ledger', 'period', 'member', 'employee', 'batch'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_restore_entry: {
    title: '恢复分录',
    aliases: ['取消作废', '恢复分录', '恢复入账'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_set_period_lock: {
    title: '锁定或解锁账期',
    aliases: ['锁账', '解锁', '封账', '账期锁定'],
    entityTags: ['ledger', 'period'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_update_entry: {
    title: '修改历史分录',
    aliases: ['修改分录', '修改历史入账', '改账', '更新账本记录'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ledger_void_entry: {
    title: '作废分录',
    aliases: ['作废', '撤销入账', '删除分录', '精确作废'],
    entityTags: ['ledger', 'entry'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  memory_get: {
    title: '读取精确记忆',
    aliases: ['读取记忆', '记忆详情', '已记住规则'],
    entityTags: ['memory'],
  },
  memory_remember: {
    title: '保存长期记忆',
    aliases: ['记住', '以后默认', '长期偏好', '默认习惯'],
    entityTags: ['memory'],
  },
  memory_search: {
    title: '检索相关记忆',
    aliases: ['查记忆', '回忆', '以前说过', '默认偏好'],
    entityTags: ['memory'],
  },
  sandbox_run_code: {
    title: '运行受控计算',
    aliases: ['运行代码', '复杂计算', '解析文件', '转换文件', '校验表格', '生成文件', '模拟'],
    entityTags: ['sandbox', 'file', 'calculation'],
  },
  share_create: {
    title: '创建分享链接',
    aliases: ['分享链接', '创建分享', '公开分享'],
    entityTags: ['share', 'version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  share_revoke: {
    title: '撤销分享链接',
    aliases: ['撤销分享', '取消分享', '删除分享链接'],
    entityTags: ['share', 'version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  shareholder_add: {
    title: '新增股东',
    aliases: ['新增股东', '添加股东', '新股东', '投资人'],
    entityTags: ['shareholder', 'model_config'],
  },
  shareholder_delete: {
    title: '删除股东',
    aliases: ['删除股东', '移除股东'],
    entityTags: ['shareholder', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  stage_cost_type_add: {
    title: '新增专项成本类型',
    aliases: ['新增专项成本', '活动成本类型', '一次性成本类型'],
    entityTags: ['cost', 'model_config'],
  },
  stage_cost_type_delete: {
    title: '删除专项成本类型',
    aliases: ['删除专项成本', '移除活动成本'],
    entityTags: ['cost', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  team_member_add: {
    title: '新增成员',
    aliases: ['新增成员', '添加成员', '新建成员', '成员保底', '成员提成'],
    entityTags: ['member', 'model_config'],
  },
  team_member_delete: {
    title: '删除成员',
    aliases: ['删除成员', '移除成员', '删掉成员'],
    entityTags: ['member', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  ui_navigate: {
    title: '打开页面',
    aliases: ['打开页面', '切到页面', '跳转', '打开面板'],
    entityTags: ['navigation'],
  },
  workspace_configure_operating_model: {
    title: '配置完整经营模型',
    aliases: ['完整经营模型', '经营简报', '12个月预测', '50个成员', '多个股东', '批量建模', '启动测算'],
    entityTags: ['workspace', 'model_config', 'shareholder', 'member', 'employee', 'cost', 'forecast'],
    requiredFacts: ['business_brief'],
  },
  workspace_delete_version: {
    title: '删除版本',
    aliases: ['删除版本', '删除快照', '删除发布版'],
    entityTags: ['version'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_export_bundle: {
    title: '导出工作区',
    aliases: ['导出', '导出bundle', '备份工作区'],
    entityTags: ['import_export', 'workspace'],
  },
  workspace_import_bundle: {
    title: '导入工作区',
    aliases: ['导入', '恢复bundle', '导入备份'],
    entityTags: ['import_export', 'workspace'],
  },
  workspace_patch_config: {
    title: '修改模型草稿',
    aliases: ['修改模型', '股东注资', '追加投资', '投资额', '分红比例', '调模型', '保存草稿', '成本结构', '预测输入'],
    entityTags: ['workspace', 'model_config', 'shareholder', 'member', 'employee', 'cost'],
    requiredFacts: ['model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_promote_version: {
    title: '快照发布为正式版',
    aliases: ['快照发布', '发布快照', '转正式版'],
    entityTags: ['version', 'release'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_publish_release: {
    title: '发布正式版',
    aliases: ['发布版本', '发布正式版', '创建发布版'],
    entityTags: ['version', 'release'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_rename: {
    title: '重命名工作区',
    aliases: ['工作区改名', '项目改名', '重命名项目'],
    entityTags: ['workspace', 'model_config'],
  },
  workspace_reset_draft: {
    title: '重置草稿',
    aliases: ['重置草稿', '恢复默认模型', '覆盖当前草稿'],
    entityTags: ['workspace', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_rollback_version: {
    title: '恢复版本',
    aliases: ['恢复版本', '回滚版本', '恢复发布版'],
    entityTags: ['version', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
  workspace_save_snapshot: {
    title: '保存快照',
    aliases: ['保存快照', '创建快照', '保存版本'],
    entityTags: ['version'],
  },
  workspace_update_online_factor: {
    title: '试算或保存线上系数',
    aliases: ['线上系数', '如果系数变成', '利润会怎样', '试算', '保存系数'],
    entityTags: ['forecast', 'model_config'],
    prerequisiteTools: [ENTITY_FACT_TOOL],
  },
}

function parameterNames(tool: ChatTool): string[] {
  const properties = tool.function.parameters.properties ?? {}
  return Object.keys(properties)
}

function defaultTitle(name: string) {
  return name.split('_').filter(Boolean).join(' ')
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))]
}

export function buildToolManifests(entries: AgentToolRegistryEntry[]): ToolManifest[] {
  return entries.map((entry) => {
    const override = MANIFEST_OVERRIDES[entry.name] ?? {}
    const params = parameterNames(entry.tool)
    const title = override.title ?? defaultTitle(entry.name)
    const summary = override.summary ?? entry.tool.function.description
    return {
      name: entry.name,
      capability: entry.capability,
      title,
      summary,
      aliases: unique([title, entry.name, ...(override.aliases ?? []), ...params]),
      entityTags: unique(override.entityTags ?? []),
      parameterNames: params,
      riskLevel: entry.riskLevel,
      confirmationMode: entry.confirmationMode,
      navigationTarget: entry.navigationTarget,
      requiredFacts: unique(override.requiredFacts ?? []),
      resolvesFacts: unique(override.resolvesFacts ?? []),
      prerequisiteTools: unique(override.prerequisiteTools ?? []),
      providerSchema: entry.tool,
    }
  })
}
