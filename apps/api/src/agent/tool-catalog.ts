export type AgentToolCallStep = {
  intent?: string
  monthLabel?: string
  memberId?: string
  memberName?: string
  newMemberName?: string
  employeeId?: string
  employeeName?: string
  newEmployeeName?: string
  role?: string
  perEventCost?: number
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
  direction?: 'income' | 'expense'
  subjectKey?: string
  subjectName?: string
  entryId?: string
  entryStatus?: 'posted' | 'voided'
  occurredAt?: string
  occurredOn?: string
  counterparty?: string
  description?: string
  relatedEntityType?: 'teamMember' | 'employee'
  relatedEntityId?: string
  relatedEntityName?: string
  allocations?: Array<{ subjectKey?: string; subjectName?: string; amount: number }>
  keyword?: string
  dateMode?: 'all' | 'day' | 'week'
  day?: string
  week?: string
  newAmount?: number
  newSubjectKey?: string
  newSubjectName?: string
  newOccurredAt?: string
  newRelatedEntityName?: string
  onlineSalesFactor?: number
  mode?: 'forecast' | 'write'
  workspaceName?: string
  versionNo?: number
  versionName?: string
  createShare?: boolean
  locked?: boolean
  mainTab?: 'dashboard' | 'inputs' | 'bookkeeping' | 'variance'
  secondaryTab?: string
  question?: string
  missingFields?: string[]
  suggestions?: string[]
  scope?: 'workspace_summary' | 'period_summary' | 'member_summary' | 'team_summary' | 'top_months' | 'variance_detail' | 'ledger_history'
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

const ledgerDirection: JsonSchema = {
  type: 'string',
  enum: ['income', 'expense'],
  description: '账本方向：income=收入，expense=支出。',
}

const ledgerSubjectKey: JsonSchema = {
  type: 'string',
  description: '账本科目 key，例如 revenue.offline_sales、cost.member.base_pay；不确定时用 subjectName。',
}

const ledgerSubjectName: JsonSchema = {
  type: 'string',
  description: '账本科目名称，例如 线下营收、成员底薪、员工月薪、排练、某个自定义成本项。',
}

const ledgerEntryLocator = {
  entryId: { type: 'string', description: '分录 id；已知时优先填写，能唯一定位。' } satisfies JsonSchema,
  amount: { type: 'number', description: '用于定位或更新的金额。' } satisfies JsonSchema,
  subjectKey: ledgerSubjectKey,
  subjectName: ledgerSubjectName,
  relatedEntityName: { type: 'string', description: '用于定位或设置归属对象的成员/员工名称。' } satisfies JsonSchema,
  relatedEntityId: { type: 'string', description: '用于定位或设置归属对象的成员/员工 id。' } satisfies JsonSchema,
  occurredOn: { type: 'string', description: '业务发生日期，YYYY-MM-DD。' } satisfies JsonSchema,
  keyword: { type: 'string', description: '描述、对方单位、科目或归属对象关键词。' } satisfies JsonSchema,
}

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false }
}

export const AGENT_TOOL_CATALOG: ChatTool[] = [
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
      name: 'ledger_create_entry',
      description:
        '规划一笔通用账本收入或支出确认卡。用于其他收入、普通支出、员工/成员支出按人入账。成员销售张数收入优先用 ledger_create_member_income；任意科目金额入账用本工具。',
      parameters: objectSchema({
        monthLabel,
        direction: ledgerDirection,
        subjectKey: ledgerSubjectKey,
        subjectName: ledgerSubjectName,
        amount: { type: 'number', description: '入账金额。' },
        occurredAt: { type: 'string', description: '业务发生时间 ISO 字符串；只有用户明确日期时填写。' },
        counterparty: { type: 'string', description: '对方单位或收付款方。' },
        description: { type: 'string', description: '分录备注。' },
        relatedEntityType: { type: 'string', enum: ['teamMember', 'employee'], description: '归属对象类型。成员/员工支出或成员收入需要填写。' },
        relatedEntityName: { type: 'string', description: '归属成员或员工名称。' },
        relatedEntityId: { type: 'string', description: '归属成员或员工 id。' },
      }, ['monthLabel', 'direction', 'amount']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_create_planned_member_income_batch',
      description:
        '按当前基准计划为某个月所有成员生成多张成员收入入账确认卡。用户说“按计划一键入账所有成员收入 / 所有成员收入一键入账”时调用；不要直接执行。',
      parameters: objectSchema({
        monthLabel,
      }, ['monthLabel']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_create_planned_related_expense_batch',
      description:
        '按当前基准计划为某个月某个成员/员工类支出科目生成多张按人支出确认卡。用于成员底薪、成员路费、员工月薪、员工场次的一键入账。',
      parameters: objectSchema({
        monthLabel,
        subjectKey: ledgerSubjectKey,
        subjectName: ledgerSubjectName,
      }, ['monthLabel']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_void_entry',
      description: '规划作废/撤销某个月符合条件的一笔账本分录。用户说“作废某人这笔入账/撤销某笔支出/精确作废 entryId”时调用。支持 entryId、金额、日期、科目、对象、关键词精确定位；如果无法唯一定位，调用 ask_user_clarification。',
      parameters: objectSchema({
        monthLabel,
        memberName: { type: 'string', description: '可选成员名称，用于缩小分录候选范围。' },
        direction: ledgerDirection,
        ...ledgerEntryLocator,
      }, ['monthLabel']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_restore_entry',
      description: '规划取消作废/恢复某个月一笔已作废账本分录。支持 entryId、金额、日期、科目、对象、关键词精确定位。',
      parameters: objectSchema({
        monthLabel,
        direction: ledgerDirection,
        entryStatus: { type: 'string', enum: ['voided'], description: '恢复分录时固定为 voided。' },
        ...ledgerEntryLocator,
      }, ['monthLabel']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_update_entry',
      description:
        '规划修改历史账本分录确认卡。先用 entryId 或金额/日期/科目/对象/关键词定位一笔已过账手工分录，再按新金额、科目、日期、对方、备注或归属对象更新。',
      parameters: objectSchema({
        monthLabel,
        direction: ledgerDirection,
        entryId: ledgerEntryLocator.entryId,
        amount: ledgerEntryLocator.amount,
        subjectKey: ledgerSubjectKey,
        subjectName: ledgerSubjectName,
        occurredOn: ledgerEntryLocator.occurredOn,
        keyword: ledgerEntryLocator.keyword,
        relatedEntityName: ledgerEntryLocator.relatedEntityName,
        newAmount: { type: 'number', description: '更新后的总金额；未提供时沿用原金额。' },
        newSubjectKey: { ...ledgerSubjectKey, description: '更新后的科目 key。' },
        newSubjectName: { ...ledgerSubjectName, description: '更新后的科目名称。' },
        newOccurredAt: { type: 'string', description: '更新后的业务发生时间 ISO 字符串或 YYYY-MM-DD。' },
        counterparty: { type: 'string', description: '更新后的对方单位。' },
        description: { type: 'string', description: '更新后的备注。' },
        relatedEntityType: { type: 'string', enum: ['teamMember', 'employee'], description: '更新后的归属对象类型。' },
        newRelatedEntityName: { type: 'string', description: '更新后的归属对象名称。' },
        allocations: {
          type: 'array',
          description: '更新后的分摊明细；不填时服务端用新科目/新金额或原科目生成。',
          items: objectSchema({
            subjectKey: ledgerSubjectKey,
            subjectName: ledgerSubjectName,
            amount: { type: 'number', description: '分摊金额。' },
          }, ['amount']),
        },
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
      name: 'employee_add',
      description:
        '规划在当前模型草稿里新增一个运营员工。用户说“新增员工 / 添加员工 / 加一个员工 / 新建员工”时必须调用本工具；本工具只生成确认卡，不直接保存。',
      parameters: objectSchema({
        newEmployeeName: { type: 'string', description: '新增员工名称；用户未指定时可省略，由服务端生成默认名称。' },
        role: { type: 'string', description: '岗位，例如 场务、助理、执行。' },
        monthlyBasePay: { type: 'number', description: '月固定薪酬，未提及时省略。' },
        perEventCost: { type: 'number', description: '每场补贴或场次成本，未提及时省略。' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'employee_delete',
      description:
        '规划从当前模型草稿里删除一个运营员工。用户说“删除员工 / 移除员工 / 删掉员工”时必须调用本工具；必须提供 employeeName 或 employeeId。若用户没有指定删除谁，调用 ask_user_clarification，不要猜测。',
      parameters: objectSchema({
        employeeName: { type: 'string', description: '要删除的员工名称，例如 员工 1、场务 A。' },
        employeeId: { type: 'string', description: '要删除的员工 id；如果已经知道 id，可用 id 精确定位。' },
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
      name: 'workspace_rename',
      description: '规划修改当前工作区名称。用户说“把工作区改名为 / 重命名工作区”时调用本工具；只生成确认卡。',
      parameters: objectSchema({
        workspaceName: { type: 'string', description: '新的工作区名称。' },
      }, ['workspaceName']),
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
      name: 'workspace_promote_version',
      description: '规划把某个快照或版本先恢复为当前草稿，再发布为新的正式版本。用户说“把某快照发布为正式版 / 将快照升为发布版”时调用。',
      parameters: objectSchema({ versionNo, versionName }),
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
          enum: ['workspace_summary', 'period_summary', 'member_summary', 'team_summary', 'top_months', 'variance_detail', 'ledger_history'],
          description: '查询范围：整体工作区、单月汇总、指定成员汇总、团队成员数量/名单、月份排行、预实科目差异、账本历史筛选。用户问“几个成员/有哪些成员/团队构成”时用 team_summary。',
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
        subjectKey: ledgerSubjectKey,
        subjectName: ledgerSubjectName,
        direction: ledgerDirection,
        entryStatus: { type: 'string', enum: ['posted', 'voided'], description: '账本筛选状态。' },
        dateMode: { type: 'string', enum: ['all', 'day', 'week'], description: '账本历史日期筛选模式。' },
        day: { type: 'string', description: '账本历史某天筛选，YYYY-MM-DD。' },
        week: { type: 'string', description: '账本历史某周筛选，YYYY-Www。' },
        keyword: { type: 'string', description: '账本历史或预实科目关键词。' },
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
    case 'ledger_create_member_income':
      return { intent: 'ledger.create_member_income', ...args }
    case 'ledger_create_entry':
      return { intent: 'ledger.create_entry', ...args }
    case 'ledger_create_planned_member_income_batch':
      return { intent: 'ledger.create_planned_member_income_batch', ...args }
    case 'ledger_create_planned_related_expense_batch':
      return { intent: 'ledger.create_planned_related_expense_batch', ...args }
    case 'ledger_void_entry':
      return { intent: 'ledger.void_entry', ...args }
    case 'ledger_restore_entry':
      return { intent: 'ledger.restore_entry', ...args }
    case 'ledger_update_entry':
      return { intent: 'ledger.update_entry', ...args }
    case 'ledger_set_period_lock':
      return { intent: 'ledger.set_period_lock', ...args }
    case 'workspace_update_online_factor':
      return { intent: 'workspace.update_online_factor', ...args }
    case 'team_member_add':
      return { intent: 'team_member.add', ...args }
    case 'team_member_delete':
      return { intent: 'team_member.delete', ...args }
    case 'employee_add':
      return { intent: 'employee.add', ...args }
    case 'employee_delete':
      return { intent: 'employee.delete', ...args }
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
    case 'workspace_rename':
      return { intent: 'workspace.rename', ...args }
    case 'workspace_save_snapshot':
      return { intent: 'workspace.save_snapshot', ...args }
    case 'workspace_publish_release':
      return { intent: 'workspace.publish_release', ...args }
    case 'workspace_promote_version':
      return { intent: 'workspace.promote_version', ...args }
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
