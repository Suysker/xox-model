export type AgentToolCallStep = {
  intent?: string
  reply?: string
  monthLabel?: string
  memberId?: string
  memberName?: string
  newMemberName?: string
  shareholderId?: string
  shareholderName?: string
  newShareholderName?: string
  investmentAmount?: number
  dividendRate?: number
  costCategory?: 'monthlyFixed' | 'perEvent' | 'perUnit'
  costItemId?: string
  costItemName?: string
  newCostItemName?: string
  amount?: number
  stageCostItemId?: string
  stageCostItemName?: string
  newStageCostItemName?: string
  costMode?: 'monthly' | 'perEvent' | 'perUnit'
  count?: number
  employmentType?: 'salary' | 'partTime'
  monthlyBasePay?: number
  perEventTravelCost?: number
  departureMonthIndex?: number | null
  commissionRate?: number
  pessimisticUnitsPerEvent?: number
  baseUnitsPerEvent?: number
  optimisticUnitsPerEvent?: number
  offlineUnits?: number
  onlineUnits?: number
  onlineSalesFactor?: number
  mode?: 'forecast' | 'write'
  versionNo?: number
  versionName?: string
  createShare?: boolean
  locked?: boolean
  mainTab?: 'dashboard' | 'inputs' | 'bookkeeping' | 'variance'
  secondaryTab?: string
  question?: string
  missingFields?: string[]
  suggestions?: string[]
  scope?: 'workspace_summary' | 'period_summary' | 'member_summary' | 'team_summary' | 'top_months'
  metrics?: string[]
  order?: 'asc' | 'desc'
  limit?: number
  patches?: Array<{ path: string; value: unknown; label?: string }>
  bundle?: unknown
  useProvidedBundle?: boolean
}

type JsonSchema = {
  type: string | string[]
  description?: string
  enum?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  additionalProperties?: boolean
}

type ChatTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: JsonSchema
  }
}

const monthLabel: JsonSchema = {
  type: 'string',
  description: '业务账期中文月份标签，例如 3月、4月。',
}

const versionNo: JsonSchema = {
  type: 'number',
  description: '工作区版本号，例如发布版 1 对应 1。',
}

const versionName: JsonSchema = {
  type: 'string',
  description: '版本或快照名称。',
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const AGENT_TOOL_CATALOG: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'agent_reply',
      description:
        '普通对话、问候、身份说明或能力说明的只读回复工具。用户说“你好”“你是谁”“你能做什么”等非业务写入请求时必须调用本工具；不要输出普通文本。回复中必须自称 xox-model Agent OS，不要自称 DeepSeek、Qwen、阿渠或其他名字。',
      parameters: objectSchema({
        message: {
          type: 'string',
          description:
            '要展示给用户的中文回复。应简短、诚实说明你是 xox-model Agent OS，可通过对话驱动测算、调模型、记账、预实分析、版本、分享和锁账；写入前会生成确认卡。',
        },
      }, ['message']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_create_member_income',
      description: '为某个月的某个成员规划一笔线下/线上销售收入入账确认卡。',
      parameters: objectSchema({
        monthLabel,
        memberName: { type: 'string', description: '成员名称或成员 id；当用户说默认成员/默认记账成员时，从 tenantScopedMemory 中解析具体成员名后填写。' },
        offlineUnits: { type: 'number', description: '线下销售张数。' },
        onlineUnits: { type: 'number', description: '线上销售张数。' },
      }, ['monthLabel', 'memberName']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_void_entry',
      description: '规划作废某个月符合条件的一笔账本分录。',
      parameters: objectSchema({
        monthLabel,
        memberName: { type: 'string', description: '可选成员名称，用于缩小分录候选范围。' },
      }, ['monthLabel']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_set_period_lock',
      description:
        '规划账期锁定状态变更确认卡。用户说“锁定 3 月账期 / 锁账 / 封账 / 关闭账期 / 不允许再记账”时必须调用本工具并设置 locked=true；用户说“解锁 3 月账期 / 打开账期 / 允许继续记账”时必须调用本工具并设置 locked=false。不要用 ui_navigate 或普通文本替代该工具；该工具只生成确认卡，不直接改账期。',
      parameters: objectSchema({
        monthLabel: { ...monthLabel, description: '要锁定或解锁的业务账期中文月份标签，例如用户说 3 月账期时填写 3月。' },
        locked: { type: 'boolean', description: 'true 表示锁定/锁账/封账/关闭账期，false 表示解锁/打开账期/允许继续记账。' },
      }, ['monthLabel', 'locked']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_update_online_factor',
      description: '规划修改或只读试算某个月线上系数。',
      parameters: objectSchema({
        monthLabel,
        onlineSalesFactor: { type: 'number', description: '新的线上销售系数。' },
        mode: { type: 'string', enum: ['forecast', 'write'], description: 'forecast 表示只读试算，write 表示保存草稿。' },
      }, ['monthLabel', 'onlineSalesFactor', 'mode']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_member_add',
      description:
        '规划在当前模型草稿里新增一个团队成员。用户说“新增成员 / 添加成员 / 加一个成员 / 新建成员”时必须调用本工具；本工具只生成确认卡，不直接保存。若用户没有提供姓名，可以省略 newMemberName，服务端会按当前人数生成类似“成员 8”的默认名称。',
      parameters: objectSchema({
        newMemberName: { type: 'string', description: '新增成员名称；用户未指定时可省略，由服务端生成默认名称。' },
        employmentType: { type: 'string', enum: ['salary', 'partTime'], description: '合作类型：salary=底薪制，partTime=兼职/分成制。' },
        monthlyBasePay: { type: 'number', description: '月固定底薪，未提及时省略。' },
        perEventTravelCost: { type: 'number', description: '每场路费，未提及时省略。' },
        departureMonthIndex: { type: ['number', 'null'], description: '离队月份序号；没有离队计划时省略或传 null。' },
        commissionRate: { type: 'number', description: '提成比例，使用小数，例如 35% 填 0.35。' },
        pessimisticUnitsPerEvent: { type: 'number', description: '保守场均销售张数。' },
        baseUnitsPerEvent: { type: 'number', description: '基准场均销售张数。' },
        optimisticUnitsPerEvent: { type: 'number', description: '乐观场均销售张数。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'team_member_delete',
      description:
        '规划从当前模型草稿里删除一个团队成员。用户说“删除成员 / 移除成员 / 删掉成员”时必须调用本工具；必须提供明确 memberName 或 memberId。若用户没有指定删除谁，调用 ask_user_clarification，不要猜测。',
      parameters: objectSchema({
        memberName: { type: 'string', description: '要删除的成员名称，例如 成员 A。' },
        memberId: { type: 'string', description: '要删除的成员 id；如果已经知道 id，可用 id 精确定位。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'shareholder_add',
      description:
        '规划在当前模型草稿里新增一个股东。用户说“新增股东 / 添加股东 / 加一个股东 / 新建股东”时必须调用本工具；本工具只生成确认卡，不直接保存。',
      parameters: objectSchema({
        newShareholderName: { type: 'string', description: '新增股东名称；用户未指定时可省略，由服务端生成默认名称。' },
        investmentAmount: { type: 'number', description: '投资额，未提及时省略。' },
        dividendRate: { type: 'number', description: '分红比例，使用小数，例如 30% 填 0.3。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'shareholder_delete',
      description:
        '规划从当前模型草稿里删除一个股东。用户说“删除股东 / 移除股东 / 删掉股东”时必须调用本工具；必须提供明确 shareholderName 或 shareholderId。若用户没有指定删除谁，调用 ask_user_clarification，不要猜测。',
      parameters: objectSchema({
        shareholderName: { type: 'string', description: '要删除的股东名称，例如 股东 A。' },
        shareholderId: { type: 'string', description: '要删除的股东 id；如果已经知道 id，可用 id 精确定位。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'cost_item_add',
      description:
        '规划新增基础成本项，用于“每月固定成本 / 每场成本 / 每张成本”列表。用户说新增房租、摄影、耗材这类基础成本项时调用本工具；本工具只生成确认卡，不直接保存。',
      parameters: objectSchema({
        costCategory: {
          type: 'string',
          enum: ['monthlyFixed', 'perEvent', 'perUnit'],
          description: '成本项归属：monthlyFixed=每月固定，perEvent=每场，perUnit=每张。用户说“每月/固定/月租”时用 monthlyFixed，说“每场/按场”时用 perEvent，说“每张/按张/单张”时用 perUnit。',
        },
        newCostItemName: { type: 'string', description: '新增成本项名称。' },
        amount: { type: 'number', description: '成本金额，未提及时省略，服务端默认 0。' },
      }, ['costCategory']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'cost_item_delete',
      description:
        '规划删除基础成本项，用于“每月固定成本 / 每场成本 / 每张成本”列表。必须提供 costItemName 或 costItemId；如果名称可能跨分类重复，优先提供 costCategory。',
      parameters: objectSchema({
        costCategory: {
          type: 'string',
          enum: ['monthlyFixed', 'perEvent', 'perUnit'],
          description: '成本项归属；如果用户明确说了每月固定/每场/每张，必须传该分类。',
        },
        costItemName: { type: 'string', description: '要删除的成本项名称。' },
        costItemId: { type: 'string', description: '要删除的成本项 id。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_cost_type_add',
      description:
        '规划新增专项成本类型，也就是月度成本表里可按“每月 / 每场 / 每张”录入的成本类型。用户说“新增成本类型 / 新增专项成本 / 添加一个可按场记录的成本类型”时调用本工具；本工具只生成确认卡，不直接保存。',
      parameters: objectSchema({
        newStageCostItemName: { type: 'string', description: '新增专项成本类型名称。' },
        costMode: { type: 'string', enum: ['monthly', 'perEvent', 'perUnit'], description: '计费方式：monthly=每月，perEvent=每场，perUnit=每张。用户未指定时可省略，服务端默认 perEvent。' },
        amount: { type: 'number', description: '可选默认金额；提供时服务端会写入模板和现有月份对应成本值。' },
        count: { type: 'number', description: '可选默认数量或系数；仅用户明确说明时填写。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'stage_cost_type_delete',
      description:
        '规划删除专项成本类型，也就是月度成本表里的一个成本类型。用户说“删除成本类型 / 删除专项成本 / 移除某个按场成本类型”时调用本工具；必须提供 stageCostItemName 或 stageCostItemId。',
      parameters: objectSchema({
        stageCostItemName: { type: 'string', description: '要删除的专项成本类型名称。' },
        stageCostItemId: { type: 'string', description: '要删除的专项成本类型 id。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_patch_config',
      description: '规划通用模型草稿字段修改，用于覆盖页面上可手动编辑但没有专用工具的字段。',
      parameters: objectSchema({
        patches: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string', description: '配置字段路径，例如 months[1].onlineSalesFactor。' },
            value: { type: ['string', 'number', 'boolean', 'object', 'array'], description: '新值。' },
            label: { type: 'string', description: '展示给用户看的字段名。' },
          }, ['path', 'value']),
        },
      }, ['patches']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_save_snapshot',
      description: '规划保存当前草稿快照。',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_publish_release',
      description: '规划发布当前草稿为不可变正式版本。',
      parameters: objectSchema({
        createShare: { type: 'boolean', description: '发布后是否继续创建分享链接。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_rollback_version',
      description: '规划把某个版本恢复到当前草稿。',
      parameters: objectSchema({ versionNo, versionName }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_delete_version',
      description: '规划删除某个可删除版本或快照。',
      parameters: objectSchema({ versionNo, versionName }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_reset_draft',
      description: '规划用默认模型覆盖当前草稿。',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_export_bundle',
      description: '导出当前工作区 bundle。只读动作，不修改业务数据。',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'workspace_import_bundle',
      description: '规划导入用户提供的工作区 bundle，用 bundle.currentConfig 覆盖当前草稿。如果上下文提示 WorkspaceBundle JSON 已由服务端解析，传 useProvidedBundle=true，不要复制完整 JSON。',
      parameters: objectSchema({
        bundle: { type: 'object', description: '用户提供的 WorkspaceBundle JSON，至少包含 workspaceName 和 currentConfig。', additionalProperties: true },
        useProvidedBundle: { type: 'boolean', description: '当用户粘贴的 bundle 已被服务端解析为 artifact 时设为 true。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_create',
      description: '规划为指定发布版本创建只读分享链接。',
      parameters: objectSchema({ versionNo, versionName }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_revoke',
      description: '规划撤销指定发布版本的分享链接。',
      parameters: objectSchema({ versionNo, versionName }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_navigate',
      description: '规划显式页面导航，不写入业务数据。',
      parameters: objectSchema({
        mainTab: { type: 'string', enum: ['dashboard', 'inputs', 'bookkeeping', 'variance'] },
        secondaryTab: { type: 'string', description: '页面二级标签。' },
      }, ['mainTab']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'data_query_workspace',
      description: '回答当前工作区的只读数据问题，例如团队成员数量/成员名单、某月计划/实际收入成本利润、成员贡献、回本、最佳月份。只读，不生成确认卡，不修改业务数据。',
      parameters: objectSchema({
        question: { type: 'string', description: '用户原始问题的简短复述。' },
        scope: {
          type: 'string',
          enum: ['workspace_summary', 'period_summary', 'member_summary', 'team_summary', 'top_months'],
          description: '查询范围：整体工作区、单月汇总、指定成员汇总、团队成员数量/名单、月份排行。用户问“几个成员/有哪些成员/团队构成”时用 team_summary。',
        },
        monthLabel: { ...monthLabel, description: '可选目标月份，例如 3月；scope=period_summary 时优先提供。' },
        memberName: { type: 'string', description: '可选成员名称；scope=member_summary 时优先提供。' },
        metrics: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['plannedRevenue', 'plannedCost', 'actualRevenue', 'actualCost', 'plannedProfit', 'actualProfit', 'cash', 'roi', 'payback', 'memberRevenue', 'memberCommission', 'memberContribution', 'teamMemberCount', 'teamMemberNames'],
          },
          description: '需要回答的指标；不确定时传空数组或省略，由服务端返回该范围的核心指标。',
        },
        order: { type: 'string', enum: ['asc', 'desc'], description: '排行方向，仅 scope=top_months 使用。' },
        limit: { type: 'number', description: '返回排行数量，仅 scope=top_months 使用。' },
      }, ['question', 'scope']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user_clarification',
      description: '当用户目标可执行但缺少必要业务信息时，向用户提出一个简短澄清问题。只读，不生成确认卡，不修改业务数据。',
      parameters: objectSchema({
        question: { type: 'string', description: '要问用户的简短问题，用中文，一次只问最关键缺口。' },
        missingFields: {
          type: 'array',
          items: { type: 'string' },
          description: '缺失的业务字段，例如 monthLabel、memberName、offlineUnits、onlineUnits、versionNo。',
        },
        suggestions: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的简短候选项，来自上下文或记忆；没有把握时留空。',
        },
      }, ['question']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'account_forbidden',
      description: '用户请求账号登录、退出、注册、注销、删除账号、改密码等禁止 Agent 自动执行的动作。',
      parameters: objectSchema({}),
    },
  },
]

export function toolCallToPlannerStep(toolName: string, args: Record<string, unknown>): AgentToolCallStep | null {
  switch (toolName) {
    case 'agent_reply':
      return { intent: 'agent.reply', reply: typeof args.message === 'string' ? args.message : '' }
    case 'ledger_create_member_income':
      return { intent: 'ledger.create_member_income', ...args }
    case 'ledger_void_entry':
      return { intent: 'ledger.void_entry', ...args }
    case 'ledger_set_period_lock':
      return { intent: 'ledger.set_period_lock', ...args }
    case 'workspace_update_online_factor':
      return { intent: 'workspace.update_online_factor', ...args }
    case 'team_member_add':
      return { intent: 'team_member.add', ...args }
    case 'team_member_delete':
      return { intent: 'team_member.delete', ...args }
    case 'shareholder_add':
      return { intent: 'shareholder.add', ...args }
    case 'shareholder_delete':
      return { intent: 'shareholder.delete', ...args }
    case 'cost_item_add':
      return { intent: 'cost_item.add', ...args }
    case 'cost_item_delete':
      return { intent: 'cost_item.delete', ...args }
    case 'stage_cost_type_add':
      return { intent: 'stage_cost_type.add', ...args }
    case 'stage_cost_type_delete':
      return { intent: 'stage_cost_type.delete', ...args }
    case 'workspace_patch_config':
      return { intent: 'workspace.patch_config', ...args }
    case 'workspace_save_snapshot':
      return { intent: 'workspace.save_snapshot', ...args }
    case 'workspace_publish_release':
      return { intent: 'workspace.publish_release', ...args }
    case 'workspace_rollback_version':
      return { intent: 'workspace.rollback_version', ...args }
    case 'workspace_delete_version':
      return { intent: 'workspace.delete_version', ...args }
    case 'workspace_reset_draft':
      return { intent: 'workspace.reset_draft', ...args }
    case 'workspace_export_bundle':
      return { intent: 'workspace.export_bundle' }
    case 'workspace_import_bundle':
      return { intent: 'workspace.import_bundle', ...args }
    case 'share_create':
      return { intent: 'share.create', ...args }
    case 'share_revoke':
      return { intent: 'share.revoke', ...args }
    case 'ui_navigate':
      return { intent: 'ui.navigate', ...args }
    case 'data_query_workspace':
      return { intent: 'data.query_workspace', ...args }
    case 'ask_user_clarification':
      return { intent: 'agent.ask_clarification', ...args }
    case 'account_forbidden':
      return { intent: 'account.forbidden' }
    default:
      return null
  }
}
