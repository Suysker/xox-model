import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { BarChart3, LayoutDashboard, LineChart, ReceiptText, Settings2, type LucideIcon } from 'lucide-react'
import { MemberContributionList } from './components/analysis/MemberContributionList'
import { AuthScreen } from './components/auth/AuthScreen'
import { type ChartMetricKey } from './components/analysis/MetricBandChart'
import { MonthlyResultsTable } from './components/analysis/MonthlyResultsTable'
import { OverviewPanel } from './components/analysis/OverviewPanel'
import { ScenarioDeck } from './components/analysis/ScenarioDeck'
import { BookkeepingPanel, type BookkeepingSubmitPayload } from './components/bookkeeping/BookkeepingPanel'
import { NoticeBanner, type NoticeTone } from './components/common/NoticeBanner'
import { Panel, SectionTitle } from './components/common/ui'
import { CostWorkbench } from './components/inputs/CostWorkbench'
import { CostOverridesEditor } from './components/inputs/CostOverridesEditor'
import { OperatingWorkbench } from './components/inputs/OperatingWorkbench'
import { EmployeesTable } from './components/inputs/EmployeesTable'
import { RevenueWorkbench } from './components/inputs/RevenueWorkbench'
import { TeamMembersTable } from './components/inputs/TeamMembersTable'
import { TimelineEditor } from './components/inputs/TimelineEditor'
import { ProductHero } from './components/layout/ProductHero'
import { SidebarNav } from './components/layout/SidebarNav'
import { WorkspaceLoadingScreen } from './components/layout/WorkspaceLoadingScreen'
import { SharedVersionScreen } from './components/share/SharedVersionScreen'
import { VariancePanel } from './components/variance/VariancePanel'
import { WorkspacePanel } from './components/workspace/WorkspacePanel'
import { useWorkspace } from './hooks/useWorkspace'
import { api, type AuthUser, type EntryResponse, type PeriodResponse, type SubjectResponse, type VarianceResponse } from './lib/api'
import {
  createCostItem,
  createEmployee,
  createMember,
  createShareholder,
  createStageCostItem,
  createStageCostValues,
  syncMonthsToPlanning,
} from './lib/defaults'
import { projectModel } from './lib/model'
import { getScenarioLabel } from './lib/scenarios'
import { parseWorkspaceBundle, serializeWorkspaceBundle } from './lib/storage'
import type {
  CostCategory,
  CostItem,
  ModelConfig,
  MonthlyPlan,
  MonthlyPlanTemplate,
  ScenarioKey,
  StageCostMode,
  StageCostValue,
  WorkspaceSnapshot,
} from './types'

type MainTab = 'dashboard' | 'inputs' | 'bookkeeping' | 'variance'
type DashboardTab = 'overview' | 'months' | 'members'
type InputsTab = 'capital' | 'revenue' | 'cost'
type BookkeepingTab = 'entries'
type VarianceTab = 'analysis'
type BannerState = { tone: NoticeTone; message: string }
type TimelineSection = 'sales' | 'training' | 'special'
type RevenueNumberKey = 'events' | 'salesMultiplier' | 'onlineSalesFactor'
type CostTemplateNumberKey =
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'

const mainTabs: Array<{ value: MainTab; label: string; description: string; icon: LucideIcon }> = [
  {
    value: 'dashboard',
    label: '经营分析',
    description: '看三档场景、月度现金流和回本进度。',
    icon: LayoutDashboard,
  },
  {
    value: 'inputs',
    label: '模型输入',
    description: '配置股东投资、收入引擎和成本结构。',
    icon: Settings2,
  },
  {
    value: 'bookkeeping',
    label: '记账',
    description: '按期间登记实际收入和成本。',
    icon: ReceiptText,
  },
  {
    value: 'variance',
    label: '预实分析',
    description: '按预算基线查看计划与实际差异。',
    icon: BarChart3,
  },
]

const dashboardTabs: Array<{ value: DashboardTab; label: string; description: string }> = [
  { value: 'overview', label: '总览', description: '先看上下界、回报率和当前月透视。' },
  { value: 'months', label: '月度表', description: '逐月展开营收、成本、利润与累计现金。' },
  { value: 'members', label: '成员拆解', description: '按月份看每个成员的收入贡献。' },
]

const inputTabs: Array<{ value: InputsTab; label: string; description: string }> = [
  { value: 'capital', label: '股东投资', description: '配置投资金额、股东结构和分红比例。' },
  { value: 'revenue', label: '收入引擎', description: '把线上/线下单价、成员卖张、场次节奏和线上系数放在一起配置。' },
  { value: 'cost', label: '成本结构', description: '先看成本概览，再改成本编辑。' },
]

const bookkeepingTabs: Array<{ value: BookkeepingTab; label: string; description: string }> = [
  { value: 'entries', label: '实际分录', description: '登记期间实际发生额。' },
]

const varianceTabs: Array<{ value: VarianceTab; label: string; description: string }> = [
  { value: 'analysis', label: '差异分析', description: '对比预算基线和已过账实际。' },
]

const chartMetricTabs: Array<{ value: ChartMetricKey; label: string }> = [
  { value: 'cash', label: '累计现金' },
  { value: 'profit', label: '利润' },
  { value: 'revenue', label: '收入' },
  { value: 'cost', label: '总成本' },
]

function sanitizeFilename(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 48) || 'workspace'
}

function getSharedTokenFromPath(pathname: string) {
  const prefix = '/shared/'

  if (!pathname.startsWith(prefix)) {
    return null
  }

  const token = pathname.slice(prefix.length).split('/')[0]
  return token ? decodeURIComponent(token) : null
}

const costCategoryLabels: Record<CostCategory, string> = {
  monthlyFixed: '每月成本',
  perEvent: '每场成本',
  perUnit: '每张成本',
}

const costCategoryKeys = {
  monthlyFixed: 'monthlyFixedCosts',
  perEvent: 'perEventCosts',
  perUnit: 'perUnitCosts',
} as const

function findSnapshot(snapshots: WorkspaceSnapshot[], id: string) {
  return snapshots.find((snapshot) => snapshot.id === id)
}

const timelineSectionKeys: Record<Exclude<TimelineSection, 'special'>, Array<RevenueNumberKey | CostTemplateNumberKey>> = {
  sales: ['events', 'salesMultiplier', 'onlineSalesFactor'],
  training: ['rehearsalCount', 'rehearsalCost', 'teacherCount', 'teacherCost'],
}

function roundTo(value: number, precision: number) {
  const safeValue = Number.isFinite(value) ? value : 0
  const factor = 10 ** precision
  return Math.round(safeValue * factor) / factor
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeRevenueNumber(key: RevenueNumberKey, value: number) {
  if (key === 'events') {
    return Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  }

  return Math.max(0, roundTo(value, 2))
}

function syncStageCosts(config: ModelConfig, stageCostItems: ModelConfig['stageCostItems']) {
  return {
    ...config,
    stageCostItems,
    timelineTemplate: {
      ...config.timelineTemplate,
      specialCosts: createStageCostValues(stageCostItems, config.timelineTemplate.specialCosts),
    },
    months: config.months.map((month) => ({
      ...month,
      specialCosts: createStageCostValues(stageCostItems, month.specialCosts),
    })),
  }
}

function updateStageCostValues(
  values: StageCostValue[],
  stageCostItems: ModelConfig['stageCostItems'],
  itemId: string,
  updater: (value: StageCostValue) => StageCostValue,
) {
  return createStageCostValues(stageCostItems, values).map((value) =>
    value.itemId === itemId ? updater(value) : value,
  )
}

function applyTemplateToMonthSection(
  month: MonthlyPlan,
  template: MonthlyPlanTemplate,
  section: TimelineSection,
  stageCostItems: ModelConfig['stageCostItems'],
): MonthlyPlan {
  if (section === 'special') {
    return {
      ...month,
      specialCosts: createStageCostValues(stageCostItems, template.specialCosts),
    }
  }

  const nextMonth = {
    ...month,
  }

  timelineSectionKeys[section].forEach((key) => {
    nextMonth[key] = template[key]
  })

  return nextMonth
}

export default function App() {
  const importInputRef = useRef<HTMLInputElement>(null)
  const sharedToken = getSharedTokenFromPath(window.location.pathname)
  const [authState, setAuthState] = useState<'loading' | 'authenticated' | 'unauthenticated'>('loading')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)
  const {
    bundle,
    workspaceName,
    config,
    snapshots,
    versionShares,
    lastSavedAt,
    loading: workspaceLoading,
    error: workspaceError,
    setWorkspaceName,
    setConfig,
    saveSnapshot,
    publishRelease,
    loadSnapshot,
    deleteSnapshot,
    promoteSnapshotToRelease,
    createShareLink,
    revokeShareLink,
    importBundle,
    resetWorkspace,
  } = useWorkspace(authState === 'authenticated' && !sharedToken)

  const [mainTab, setMainTab] = useState<MainTab>('dashboard')
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('overview')
  const [inputsTab, setInputsTab] = useState<InputsTab>('revenue')
  const [bookkeepingTab, setBookkeepingTab] = useState<BookkeepingTab>('entries')
  const [varianceTab, setVarianceTab] = useState<VarianceTab>('analysis')
  const [selectedScenario, setSelectedScenario] = useState<ScenarioKey>('base')
  const [chartMetric, setChartMetric] = useState<ChartMetricKey>('cash')
  const [selectedMonthId, setSelectedMonthId] = useState(config.months[0]?.id ?? '')
  const [periods, setPeriods] = useState<PeriodResponse[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [subjects, setSubjects] = useState<SubjectResponse[]>([])
  const [entries, setEntries] = useState<EntryResponse[]>([])
  const [variance, setVariance] = useState<VarianceResponse | null>(null)
  const [ledgerBusy, setLedgerBusy] = useState(false)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [banner, setBanner] = useState<BannerState | null>(null)

  const projection = projectModel(config)
  const selectedScenarioResult =
    projection.scenarios.find((scenario) => scenario.key === selectedScenario) ?? projection.scenarios[0]
  const selectedPeriod = periods.find((period) => period.id === selectedPeriodId) ?? null
  const selectedBaselineSnapshot =
    selectedPeriod?.baselineVersionId ? snapshots.find((snapshot) => snapshot.id === selectedPeriod.baselineVersionId) ?? null : null
  const baselineProjection = selectedBaselineSnapshot ? projectModel(selectedBaselineSnapshot.config) : null
  const baselineScenarioResult =
    baselineProjection?.scenarios.find((scenario) => scenario.key === 'base') ?? baselineProjection?.scenarios[0] ?? null
  const selectedBaselineMonthResult =
    selectedPeriod && baselineScenarioResult
      ? baselineScenarioResult.months.find((month) => month.monthIndex === selectedPeriod.monthIndex) ?? null
      : null

  async function refreshPeriods() {
    const nextPeriods = await api.listPeriods()
    setPeriods(nextPeriods)
    setSelectedPeriodId((current) => (nextPeriods.some((period) => period.id === current) ? current : (nextPeriods[0]?.id ?? '')))
  }

  async function refreshSelectedPeriodData(periodId: string) {
    const [nextSubjects, nextEntries, nextVariance] = await Promise.all([
      api.listSubjects(periodId),
      api.listEntries(periodId),
      api.getVariance(periodId),
    ])

    setSubjects(nextSubjects)
    setEntries(nextEntries)
    setVariance(nextVariance)
  }

  useEffect(() => {
    if (sharedToken) {
      setAuthState('unauthenticated')
      return
    }

    let active = true

    async function bootstrapAuth() {
      try {
        const me = await api.me()
        if (!active) {
          return
        }
        setCurrentUser(me)
        setAuthState('authenticated')
        setAuthError(null)
      } catch {
        if (active) {
          setAuthState('unauthenticated')
        }
      }
    }

    void bootstrapAuth()

    return () => {
      active = false
    }
  }, [sharedToken])

  useEffect(() => {
    if (!workspaceError) {
      return
    }

    setBanner({ tone: 'error', message: workspaceError })
  }, [workspaceError])

  useEffect(() => {
    if (authState !== 'authenticated' || workspaceLoading) {
      return
    }

    void refreshPeriods()
  }, [authState, workspaceLoading, snapshots.length])

  useEffect(() => {
    if (authState !== 'authenticated' || !selectedPeriodId) {
      return
    }

    let active = true

    async function loadLedgerData() {
      try {
        const [nextSubjects, nextEntries, nextVariance] = await Promise.all([
          api.listSubjects(selectedPeriodId),
          api.listEntries(selectedPeriodId),
          api.getVariance(selectedPeriodId),
        ])

        if (!active) {
          return
        }

        setSubjects(nextSubjects)
        setEntries(nextEntries)
        setVariance(nextVariance)
      } catch (loadError) {
        if (active) {
          setBanner({
            tone: 'error',
            message: loadError instanceof Error ? loadError.message : String(loadError),
          })
        }
      }
    }

    void loadLedgerData()

    return () => {
      active = false
    }
  }, [authState, selectedPeriodId])

  useEffect(() => {
    const firstMonthId = config.months[0]?.id ?? ''

    if (!config.months.some((month) => month.id === selectedMonthId)) {
      setSelectedMonthId(firstMonthId)
    }
  }, [config.months, selectedMonthId])

  async function handleLogin(payload: { email: string; password: string }) {
    setAuthBusy(true)
    try {
      const user = await api.login(payload)
      setCurrentUser(user)
      setAuthState('authenticated')
      setAuthError(null)
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : String(loginError))
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleRegister(payload: { email: string; password: string; displayName: string }) {
    setAuthBusy(true)
    try {
      const user = await api.register(payload)
      setCurrentUser(user)
      setAuthState('authenticated')
      setAuthError(null)
    } catch (registerError) {
      setAuthError(registerError instanceof Error ? registerError.message : String(registerError))
    } finally {
      setAuthBusy(false)
    }
  }

  async function handleLogout() {
    try {
      await api.logout()
      setCurrentUser(null)
      setAuthState('unauthenticated')
      setWorkspaceOpen(false)
      setBanner(null)
    } catch (logoutError) {
      setBanner({ tone: 'error', message: getErrorMessage(logoutError) })
    }
  }

  async function handleCancelAccount() {
    const confirmed = window.confirm('注销账号后，当前账号的全部会话都会失效。确认继续吗？')

    if (!confirmed) {
      return
    }

    try {
      await api.cancelAccount()
      setCurrentUser(null)
      setAuthState('unauthenticated')
      setWorkspaceOpen(false)
      setBanner({ tone: 'info', message: '账号已注销，当前会话已退出。' })
    } catch (cancelError) {
      setBanner({ tone: 'error', message: getErrorMessage(cancelError) })
    }
  }

  async function handleSubmitEntry(payload: BookkeepingSubmitPayload) {
    if (!selectedPeriodId || payload.amount <= 0 || payload.allocations.length === 0) {
      return false
    }

    const allocations = payload.allocations

    if (Math.abs(allocations.reduce((sum, allocation) => sum + allocation.amount, 0) - payload.amount) >= 0.005) {
      setBanner({ tone: 'error', message: '分录金额必须与分摊合计一致。' })
      return false
    }

    setLedgerBusy(true)
    try {
      await api.createEntry({
        ledgerPeriodId: selectedPeriodId,
        direction: payload.direction,
        amount: payload.amount,
        allocations,
        ...(payload.counterparty ? { counterparty: payload.counterparty } : {}),
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.relatedEntityType ? { relatedEntityType: payload.relatedEntityType } : {}),
        ...(payload.relatedEntityId ? { relatedEntityId: payload.relatedEntityId } : {}),
        ...(payload.relatedEntityName ? { relatedEntityName: payload.relatedEntityName } : {}),
      })

      await refreshPeriods()
      await refreshSelectedPeriodData(selectedPeriodId)
      setBanner({ tone: 'success', message: '实际分录已过账。' })
      return true
    } catch (entryError) {
      setBanner({ tone: 'error', message: entryError instanceof Error ? entryError.message : String(entryError) })
      return false
    } finally {
      setLedgerBusy(false)
    }
  }

  async function handleVoidEntry(entryId: string) {
    const confirmed = window.confirm('作废后这笔分录会保留审计记录，但不会继续参与预实分析。确认继续吗？')

    if (!confirmed) {
      return false
    }

    setLedgerBusy(true)
    try {
      await api.voidEntry(entryId)
      await refreshPeriods()
      if (selectedPeriodId) {
        await refreshSelectedPeriodData(selectedPeriodId)
      }
      setBanner({ tone: 'info', message: '分录已作废。' })
    } catch (entryError) {
      setBanner({ tone: 'error', message: entryError instanceof Error ? entryError.message : String(entryError) })
    } finally {
      setLedgerBusy(false)
    }
  }

  async function handleTogglePeriodLock() {
    if (!selectedPeriodId) {
      return
    }

    const currentPeriod = periods.find((period) => period.id === selectedPeriodId)

    if (!currentPeriod) {
      return
    }

    const confirmed = window.confirm(
      currentPeriod.status === 'locked'
        ? `确认解锁 ${currentPeriod.monthLabel} 吗？解锁后可以继续修改已过账记录。`
        : `确认锁定 ${currentPeriod.monthLabel} 吗？锁定后将禁止新增、作废和修改分录。`,
    )

    if (!confirmed) {
      return
    }

    setLedgerBusy(true)
    try {
      if (currentPeriod.status === 'locked') {
        await api.unlockPeriod(selectedPeriodId)
        setBanner({ tone: 'success', message: '期间已解锁。' })
      } else {
        await api.lockPeriod(selectedPeriodId)
        setBanner({ tone: 'info', message: '期间已锁定。' })
      }
      await refreshPeriods()
      await refreshSelectedPeriodData(selectedPeriodId)
    } catch (periodError) {
      setBanner({ tone: 'error', message: periodError instanceof Error ? periodError.message : String(periodError) })
    } finally {
      setLedgerBusy(false)
    }
  }

  if (sharedToken) {
    return <SharedVersionScreen shareToken={sharedToken} />
  }

  if (authState === 'loading') {
    return <WorkspaceLoadingScreen title="正在恢复登录状态" description="稍等片刻，我们正在恢复你的会话并连接工作区。" />
  }

  if (authState !== 'authenticated') {
    return (
      <AuthScreen
        loading={authBusy}
        error={authError}
        onLogin={handleLogin}
        onRegister={handleRegister}
        onClearError={() => setAuthError(null)}
      />
    )
  }

  if (workspaceLoading) {
    return <WorkspaceLoadingScreen title="正在加载工作区" description="测算草稿、版本和账务基线正在同步，请稍等。" />
  }

  if (!selectedScenarioResult) {
    return null
  }

  const selectedMonthResult =
    selectedScenarioResult.months.find((month) => month.monthId === selectedMonthId) ??
    selectedScenarioResult.months[0]
  const selectedMonthPlan = config.months.find((month) => month.id === selectedMonthId) ?? config.months[0]

  if (!selectedMonthResult || !selectedMonthPlan) {
    return null
  }

  const secondaryTitle = mainTab === 'dashboard' ? '分析视图' : '输入模块'
  const secondaryItems = mainTab === 'dashboard' ? dashboardTabs : inputTabs
  const secondaryValue = mainTab === 'dashboard' ? dashboardTab : inputsTab

  function updateOfflineUnitPrice(value: number) {
    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        offlineUnitPrice: value,
      },
    }))
  }

  function updateOnlineUnitPrice(value: number) {
    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        onlineUnitPrice: value,
      },
    }))
  }

  function updateCostItem(
    category: CostCategory,
    id: string,
    updater: (item: CostItem) => CostItem,
  ) {
    const categoryKey = costCategoryKeys[category]

    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        [categoryKey]: current.operating[categoryKey].map((item) => (item.id === id ? updater(item) : item)),
      },
    }))
  }

  function handleAddCostItem(category: CostCategory) {
    const categoryKey = costCategoryKeys[category]

    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        [categoryKey]: [
          ...current.operating[categoryKey],
          createCostItem(`${category}-${Date.now()}`, {
            name: `${costCategoryLabels[category]} ${current.operating[categoryKey].length + 1}`,
          }),
        ],
      },
    }))
  }

  function handleRemoveCostItem(category: CostCategory, id: string) {
    const categoryKey = costCategoryKeys[category]

    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        [categoryKey]: current.operating[categoryKey].filter((item) => item.id !== id),
      },
    }))
  }

  function updateShareholder(
    id: string,
    updater: (shareholder: ModelConfig['shareholders'][number]) => ModelConfig['shareholders'][number],
  ) {
    setConfig((current) => ({
      ...current,
      shareholders: current.shareholders.map((shareholder) =>
        shareholder.id === id ? updater(shareholder) : shareholder,
      ),
    }))
  }

  function updateMember(
    id: string,
    updater: (member: ModelConfig['teamMembers'][number]) => ModelConfig['teamMembers'][number],
  ) {
    setConfig((current) => ({
      ...current,
      teamMembers: current.teamMembers.map((member) => (member.id === id ? updater(member) : member)),
    }))
  }

  function updateEmployee(
    id: string,
    updater: (employee: ModelConfig['employees'][number]) => ModelConfig['employees'][number],
  ) {
    setConfig((current) => ({
      ...current,
      employees: current.employees.map((employee) => (employee.id === id ? updater(employee) : employee)),
    }))
  }

  function updateMonth(id: string, updater: (month: MonthlyPlan) => MonthlyPlan) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) => (month.id === id ? updater(month) : month)),
    }))
  }

  function updateTimelineTemplate(key: RevenueNumberKey | CostTemplateNumberKey, value: number) {
    const nextValue = key === 'events' || key === 'salesMultiplier' || key === 'onlineSalesFactor'
      ? normalizeRevenueNumber(key, value)
      : value

    setConfig((current) => ({
      ...current,
      timelineTemplate: {
        ...current.timelineTemplate,
        [key]: nextValue,
      },
    }))
  }

  function updatePlanning(key: keyof ModelConfig['planning'], value: number) {
    setConfig((current) => {
      const nextPlanning = {
        startMonth:
          key === 'startMonth'
            ? Math.min(12, Math.max(1, Math.round(Number.isFinite(value) ? value : current.planning.startMonth)))
            : current.planning.startMonth,
        horizonMonths:
          key === 'horizonMonths'
            ? Math.min(24, Math.max(1, Math.round(Number.isFinite(value) ? value : current.planning.horizonMonths)))
            : current.planning.horizonMonths,
      }

      return {
        ...current,
        planning: nextPlanning,
        months: syncMonthsToPlanning(
          current.months,
          nextPlanning,
          'workspace',
          current.timelineTemplate,
          current.stageCostItems,
        ),
      }
    })
  }

  function handleAddStageCostItem() {
    setConfig((current) =>
      syncStageCosts(current, [
        ...current.stageCostItems,
        createStageCostItem(`${Date.now()}`, {
          name: `专项成本 ${current.stageCostItems.length + 1}`,
        }),
      ]),
    )
  }

  function handleRemoveStageCostItem(id: string) {
    setConfig((current) => syncStageCosts(current, current.stageCostItems.filter((item) => item.id !== id)))
  }

  function updateStageCostItem(
    id: string,
    updater: (item: ModelConfig['stageCostItems'][number]) => ModelConfig['stageCostItems'][number],
  ) {
    setConfig((current) =>
      syncStageCosts(
        current,
        current.stageCostItems.map((item) => (item.id === id ? updater(item) : item)),
      ),
    )
  }

  function updateTemplateStageCost(itemId: string, key: 'amount' | 'count', value: number) {
    setConfig((current) => ({
      ...current,
      timelineTemplate: {
        ...current.timelineTemplate,
        specialCosts: updateStageCostValues(
          current.timelineTemplate.specialCosts,
          current.stageCostItems,
          itemId,
          (stageCost) => ({
            ...stageCost,
            [key]: value,
          }),
        ),
      },
    }))
  }

  function updateMonthStageCost(monthId: string, itemId: string, key: 'amount' | 'count', value: number) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) =>
        month.id === monthId
          ? {
              ...month,
              specialCosts: updateStageCostValues(month.specialCosts, current.stageCostItems, itemId, (stageCost) => ({
                ...stageCost,
                [key]: value,
              })),
            }
          : month,
      ),
    }))
  }

  function handleAddMember() {
    setConfig((current) => {
      const nextIndex = current.teamMembers.length + 1

      return {
        ...current,
        teamMembers: [
          ...current.teamMembers,
          createMember(`${Date.now()}`, {
            name: `成员 ${nextIndex}`,
          }),
        ],
      }
    })
  }

  function handleRemoveMember(id: string) {
    setConfig((current) => ({
      ...current,
      teamMembers:
        current.teamMembers.length > 1
          ? current.teamMembers.filter((member) => member.id !== id)
          : current.teamMembers,
    }))
  }

  function handleAddEmployee() {
    setConfig((current) => {
      const nextIndex = current.employees.length + 1

      return {
        ...current,
        employees: [
          ...current.employees,
          createEmployee(`${Date.now()}`, {
            name: `员工 ${nextIndex}`,
          }),
        ],
      }
    })
  }

  function handleAddShareholder() {
    setConfig((current) => {
      const nextIndex = current.shareholders.length + 1

      return {
        ...current,
        shareholders: [
          ...current.shareholders,
          createShareholder(`${Date.now()}`, {
            name: `股东 ${String.fromCharCode(64 + nextIndex)}`,
          }),
        ],
      }
    })
  }

  function handleRemoveShareholder(id: string) {
    setConfig((current) => ({
      ...current,
      shareholders:
        current.shareholders.length > 1
          ? current.shareholders.filter((shareholder) => shareholder.id !== id)
          : current.shareholders,
    }))
  }

  function handleRemoveEmployee(id: string) {
    setConfig((current) => ({
      ...current,
      employees: current.employees.filter((employee) => employee.id !== id),
    }))
  }

  async function handleSaveSnapshot() {
    try {
      await saveSnapshot()
      setBanner({ tone: 'success', message: '已保存当前草稿快照。' })
    } catch (saveError) {
      setBanner({ tone: 'error', message: getErrorMessage(saveError) })
    }
  }

  async function handlePublishRelease() {
    try {
      await publishRelease()
      await refreshPeriods()
      setBanner({ tone: 'success', message: '已发布当前版本，后续可以继续基于草稿试算。' })
    } catch (publishError) {
      setBanner({ tone: 'error', message: getErrorMessage(publishError) })
    }
  }

  async function handleLoadSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    const confirmed = window.confirm(
      snapshot
        ? `回滚会用“${snapshot.name}”覆盖当前草稿。确认继续吗？`
        : '回滚会覆盖当前草稿。确认继续吗？',
    )

    if (!confirmed) {
      return
    }

    try {
      const draft = await loadSnapshot(id)
      setMainTab('dashboard')
      setDashboardTab('overview')
      setSelectedMonthId(draft.config.months[0]?.id ?? snapshot?.config.months[0]?.id ?? '')
      setBanner({
        tone: 'info',
        message: snapshot ? `已回滚到版本：${snapshot.name}` : '已回滚到所选版本。',
      })
    } catch (loadError) {
      setBanner({ tone: 'error', message: getErrorMessage(loadError) })
    }
  }

  async function handleDeleteSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    const confirmed = window.confirm(
      snapshot ? `确认删除版本“${snapshot.name}”吗？删除后无法恢复。` : '确认删除当前版本吗？删除后无法恢复。',
    )

    if (!confirmed) {
      return
    }

    try {
      await deleteSnapshot(id)
      setBanner({
        tone: 'info',
        message: snapshot ? `已删除版本：${snapshot.name}` : '已删除所选版本。',
      })
    } catch (deleteError) {
      setBanner({ tone: 'error', message: getErrorMessage(deleteError) })
    }
  }

  async function handlePromoteSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    const confirmed = window.confirm(
      snapshot
        ? `升级会先将“${snapshot.name}”恢复为当前草稿，再发布为新版本。确认继续吗？`
        : '升级会覆盖当前草稿并发布为新版本。确认继续吗？',
    )

    if (!confirmed) {
      return
    }

    try {
      await promoteSnapshotToRelease(id)
      await refreshPeriods()
      setBanner({
        tone: 'success',
        message: snapshot ? `已将“${snapshot.name}”升级为发布版本。` : '已升级为发布版本。',
      })
    } catch (promoteError) {
      setBanner({ tone: 'error', message: getErrorMessage(promoteError) })
    }
  }

  async function handleCreateShareLink(id: string) {
    try {
      await createShareLink(id)
      setBanner({ tone: 'success', message: '已为当前发布版创建分享链接。' })
    } catch (shareError) {
      setBanner({ tone: 'error', message: getErrorMessage(shareError) })
    }
  }

  async function handleCopyShareLink(id: string) {
    const share = versionShares[id]

    if (!share) {
      setBanner({ tone: 'error', message: '当前发布版没有可用的分享链接。' })
      return
    }

    const shareUrl = new URL(share.sharePath, window.location.origin).toString()

    try {
      await navigator.clipboard.writeText(shareUrl)
      setBanner({ tone: 'success', message: '分享链接已复制。' })
    } catch {
      setBanner({ tone: 'info', message: shareUrl })
    }
  }

  async function handleRevokeShareLink(id: string) {
    const confirmed = window.confirm('撤销后，旧分享链接会立即失效。确认继续吗？')

    if (!confirmed) {
      return
    }

    try {
      await revokeShareLink(id)
      setBanner({ tone: 'info', message: '分享链接已撤销。' })
    } catch (shareError) {
      setBanner({ tone: 'error', message: getErrorMessage(shareError) })
    }
  }

  function handleExportBundle() {
    const raw = serializeWorkspaceBundle(bundle)
    const blob = new Blob([raw], { type: 'application/json;charset=utf-8' })
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')

    anchor.href = url
    anchor.download = `${sanitizeFilename(workspaceName)}.json`
    anchor.click()
    window.URL.revokeObjectURL(url)
    setBanner({ tone: 'success', message: '当前工作区已导出为 JSON 文件。' })
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const raw = await file.text()
      const parsed = parseWorkspaceBundle(raw)

      if (!parsed) {
        setBanner({ tone: 'error', message: '导入失败：文件格式不正确，或不是工作区导出文件。' })
        return
      }

      await importBundle(parsed)
      setMainTab('dashboard')
      setDashboardTab('overview')
      setSelectedMonthId(parsed.currentConfig.months[0]?.id ?? '')
      setBanner({ tone: 'success', message: `已导入工作区：${parsed.workspaceName}` })
    } catch {
      setBanner({ tone: 'error', message: '导入失败：读取文件时发生错误。' })
    } finally {
      event.target.value = ''
    }
  }

  async function handleResetWorkspace() {
    const confirmed = window.confirm('重置会清空当前草稿并恢复默认模型。确认继续吗？')

    if (!confirmed) {
      return
    }

    try {
      await resetWorkspace()
      setMainTab('inputs')
      setInputsTab('revenue')
      setDashboardTab('overview')
      setWorkspaceOpen(false)
      setBanner({ tone: 'info', message: '已重置为新的草稿工作区。' })
    } catch (resetError) {
      setBanner({ tone: 'error', message: getErrorMessage(resetError) })
    }
  }

  function handleApplyTemplateToAll(section: TimelineSection) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) =>
        applyTemplateToMonthSection(month, current.timelineTemplate, section, current.stageCostItems),
      ),
    }))

    setBanner({ tone: 'success', message: '已同步默认基线，接下来只需要改少数例外月份。' })
  }

  function handleResetMonthFromTemplate(id: string, section: TimelineSection) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) =>
        month.id === id
          ? applyTemplateToMonthSection(month, current.timelineTemplate, section, current.stageCostItems)
          : month,
      ),
    }))
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.12),_transparent_28%),linear-gradient(180deg,_#fbf8f1_0%,_#f3ede3_100%)] px-4 py-5 text-stone-900 md:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px]">
        {banner ? (
          <div className="mb-4">
            <NoticeBanner tone={banner.tone} message={banner.message} onDismiss={() => setBanner(null)} />
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <SidebarNav
            title="地下偶像经营工作台"
            subtitle="把测算、发布、记账和预实分析收在同一套经营工作流里。"
            workspaceName={workspaceName}
            lastSavedAt={lastSavedAt}
            snapshotCount={snapshots.length}
            workspaceOpen={workspaceOpen}
            currentUser={currentUser}
            onOpenWorkspace={() => setWorkspaceOpen((current) => !current)}
            onLogout={() => void handleLogout()}
            onCancelAccount={() => void handleCancelAccount()}
            mainItems={mainTabs}
            mainValue={mainTab}
            onMainChange={setMainTab}
            secondaryTitle={
              mainTab === 'dashboard'
                ? '分析视图'
                : mainTab === 'inputs'
                  ? '输入模块'
                  : mainTab === 'bookkeeping'
                    ? '账务模块'
                    : '分析模块'
            }
            secondaryItems={
              mainTab === 'dashboard'
                ? dashboardTabs
                : mainTab === 'inputs'
                  ? inputTabs
                  : mainTab === 'bookkeeping'
                    ? bookkeepingTabs
                    : varianceTabs
            }
            secondaryValue={
              mainTab === 'dashboard'
                ? dashboardTab
                : mainTab === 'inputs'
                  ? inputsTab
                  : mainTab === 'bookkeeping'
                    ? bookkeepingTab
                    : varianceTab
            }
            onSecondaryChange={(value) => {
              if (mainTab === 'dashboard') {
                setDashboardTab(value as DashboardTab)
                return
              }

              if (mainTab === 'inputs') {
                setInputsTab(value as InputsTab)
                return
              }

              if (mainTab === 'bookkeeping') {
                setBookkeepingTab(value as BookkeepingTab)
                return
              }

              setVarianceTab(value as VarianceTab)
            }}
          />

          <main className="min-w-0 space-y-4">
            {mainTab === 'dashboard' ? (
              <>
                <ProductHero
                  workspaceName={workspaceName}
                  scenario={selectedScenarioResult}
                  memberCount={config.teamMembers.length}
                  monthCount={config.months.length}
                />

                <Panel>
                  <SectionTitle
                    icon={LineChart}
                    eyebrow="分析"
                    title="三档场景总览"
                    description="先选一档主判断口径。"
                  />
                  <div className="mt-5">
                    <ScenarioDeck
                      scenarios={projection.scenarios}
                      selectedKey={selectedScenario}
                      onSelect={setSelectedScenario}
                    />
                  </div>
                </Panel>

                {dashboardTab === 'overview' ? (
                  <OverviewPanel
                    scenarios={projection.scenarios}
                    selectedScenarioResult={selectedScenarioResult}
                    chartMetric={chartMetric}
                    chartMetricTabs={chartMetricTabs}
                    onChartMetricChange={setChartMetric}
                    months={config.months}
                    selectedMonthPlan={selectedMonthPlan}
                    selectedMonthResult={selectedMonthResult}
                    onSelectMonth={setSelectedMonthId}
                  />
                ) : null}

                {dashboardTab === 'months' ? (
                  <MonthlyResultsTable
                    months={selectedScenarioResult.months}
                    selectedMonthId={selectedMonthId}
                    onSelectMonth={setSelectedMonthId}
                  />
                ) : null}

                {dashboardTab === 'members' ? (
                  <MemberContributionList
                    months={selectedScenarioResult.months}
                    selectedMonthId={selectedMonthId}
                    onSelectMonth={setSelectedMonthId}
                  />
                ) : null}
              </>
            ) : null}

            {mainTab === 'inputs' ? (
              <>
                {inputsTab === 'capital' ? (
                  <OperatingWorkbench
                    shareholders={config.shareholders}
                    planning={config.planning}
                    onPlanningChange={updatePlanning}
                    onShareholderAdd={handleAddShareholder}
                    onShareholderRemove={handleRemoveShareholder}
                    onShareholderNameChange={(id, value) =>
                      updateShareholder(id, (shareholder) => ({ ...shareholder, name: value }))
                    }
                    onShareholderInvestmentChange={(id, value) =>
                      updateShareholder(id, (shareholder) => ({ ...shareholder, investmentAmount: value }))
                    }
                    onShareholderDividendChange={(id, value) =>
                      updateShareholder(id, (shareholder) => ({ ...shareholder, dividendRate: value }))
                    }
                  />
                ) : null}

                {inputsTab === 'revenue' ? (
                  <div className="space-y-4">
                    <RevenueWorkbench
                      offlineUnitPrice={config.operating.offlineUnitPrice}
                      onlineUnitPrice={config.operating.onlineUnitPrice}
                      onOfflineUnitPriceChange={updateOfflineUnitPrice}
                      onOnlineUnitPriceChange={updateOnlineUnitPrice}
                    />

                    <TimelineEditor
                      template={config.timelineTemplate}
                      months={config.months}
                      onTemplateNumberChange={updateTimelineTemplate}
                      onNumberChange={(id, key, value) =>
                        updateMonth(id, (month) => ({
                          ...month,
                          [key]: normalizeRevenueNumber(key, value),
                        }))
                      }
                      onApplyTemplateToAll={() => handleApplyTemplateToAll('sales')}
                      onResetMonthFromTemplate={(id) => handleResetMonthFromTemplate(id, 'sales')}
                    />

                    <TeamMembersTable
                      members={config.teamMembers}
                      cycleMonths={config.months.map((month, index) => ({
                        label: month.label,
                        value: index + 1,
                      }))}
                      onAdd={handleAddMember}
                      onNameChange={(id, value) => updateMember(id, (member) => ({ ...member, name: value }))}
                      onEmploymentTypeChange={(id, value) =>
                        updateMember(id, (member) => ({ ...member, employmentType: value }))
                      }
                      onCommissionChange={(id, value) =>
                        updateMember(id, (member) => ({ ...member, commissionRate: value }))
                      }
                      onBasePayChange={(id, value) =>
                        updateMember(id, (member) => ({ ...member, monthlyBasePay: value }))
                      }
                      onTravelCostChange={(id, value) =>
                        updateMember(id, (member) => ({ ...member, perEventTravelCost: value }))
                      }
                      onDepartureMonthChange={(id, value) =>
                        updateMember(id, (member) => ({ ...member, departureMonthIndex: value }))
                      }
                      onUnitsChange={(id, key, value) =>
                        updateMember(id, (member) => ({
                          ...member,
                          unitsPerEvent: {
                            ...member.unitsPerEvent,
                            [key]: value,
                          },
                        }))
                      }
                      onRemove={handleRemoveMember}
                    />
                  </div>
                ) : null}

                {inputsTab === 'cost' ? (
                  <div className="space-y-4">
                    <CostWorkbench
                      operating={config.operating}
                      teamMembers={config.teamMembers}
                      employees={config.employees}
                      stageCostItems={config.stageCostItems}
                      months={config.months}
                      scenarioMonths={selectedScenarioResult.months}
                      selectedMonthId={selectedMonthId}
                      selectedMonthPlan={selectedMonthPlan}
                      selectedMonthResult={selectedMonthResult}
                      selectedScenarioLabel={getScenarioLabel(selectedScenarioResult.key, selectedScenarioResult.label)}
                      onSelectMonth={setSelectedMonthId}
                    />

                    <CostOverridesEditor
                      operating={config.operating}
                      teamMembers={config.teamMembers}
                      employees={config.employees}
                      template={config.timelineTemplate}
                      months={config.months}
                      stageCostItems={config.stageCostItems}
                      onCostItemAdd={handleAddCostItem}
                      onCostItemRemove={handleRemoveCostItem}
                      onCostItemNameChange={(category, id, value) =>
                        updateCostItem(category, id, (item) => ({ ...item, name: value }))
                      }
                      onCostItemAmountChange={(category, id, value) =>
                        updateCostItem(category, id, (item) => ({ ...item, amount: value }))
                      }
                      onTrainingTemplateChange={updateTimelineTemplate}
                      onTrainingMonthChange={(id, key, value) =>
                        updateMonth(id, (month) => ({
                          ...month,
                          [key]: value,
                        }))
                      }
                      onApplyTemplateToAll={handleApplyTemplateToAll}
                      onResetMonthFromTemplate={handleResetMonthFromTemplate}
                      onStageCostItemAdd={handleAddStageCostItem}
                      onStageCostItemRemove={handleRemoveStageCostItem}
                      onStageCostItemNameChange={(id, value) =>
                        updateStageCostItem(id, (item) => ({ ...item, name: value }))
                      }
                      onStageCostItemModeChange={(id, value) =>
                        updateStageCostItem(id, (item) => ({ ...item, mode: value }))
                      }
                      onTemplateStageCostChange={updateTemplateStageCost}
                      onMonthStageCostChange={updateMonthStageCost}
                    />

                    <EmployeesTable
                      employees={config.employees}
                      onAdd={handleAddEmployee}
                      onNameChange={(id, value) => updateEmployee(id, (employee) => ({ ...employee, name: value }))}
                      onRoleChange={(id, value) => updateEmployee(id, (employee) => ({ ...employee, role: value }))}
                      onBasePayChange={(id, value) =>
                        updateEmployee(id, (employee) => ({ ...employee, monthlyBasePay: value }))
                      }
                      onPerEventCostChange={(id, value) =>
                        updateEmployee(id, (employee) => ({ ...employee, perEventCost: value }))
                      }
                      onRemove={handleRemoveEmployee}
                    />
                  </div>
                ) : null}

              </>
            ) : null}

            {mainTab === 'bookkeeping' ? (
              <BookkeepingPanel
                periods={periods}
                selectedPeriodId={selectedPeriodId}
                subjects={subjects}
                entries={entries}
                loading={ledgerBusy}
                baselineMonthResult={selectedBaselineMonthResult}
                onSelectPeriod={setSelectedPeriodId}
                onSubmit={handleSubmitEntry}
                onVoid={handleVoidEntry}
                onToggleLock={handleTogglePeriodLock}
              />
            ) : null}

            {mainTab === 'variance' ? (
              <VariancePanel
                periods={periods}
                selectedPeriodId={selectedPeriodId}
                variance={variance}
                onSelectPeriod={setSelectedPeriodId}
              />
            ) : null}
          </main>
        </div>
      </div>

      {workspaceOpen ? (
        <>
          <button
            type="button"
            aria-label="关闭版本库"
            className="fixed inset-0 z-40 bg-stone-950/20 backdrop-blur-[2px]"
            onClick={() => setWorkspaceOpen(false)}
          />
          <div className="fixed inset-y-4 right-4 z-50 w-[420px] max-w-[calc(100vw-1.5rem)] md:right-6">
            <WorkspacePanel
              workspaceName={workspaceName}
              lastSavedAt={lastSavedAt}
              snapshots={snapshots}
              shareLinks={versionShares}
              onNameChange={setWorkspaceName}
              onSaveSnapshot={handleSaveSnapshot}
              onPublishRelease={handlePublishRelease}
              onExport={handleExportBundle}
              onImportClick={() => importInputRef.current?.click()}
              onReset={handleResetWorkspace}
              onLoadSnapshot={handleLoadSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
              onPromoteToRelease={handlePromoteSnapshot}
              onCreateShare={handleCreateShareLink}
              onCopyShareLink={handleCopyShareLink}
              onRevokeShare={handleRevokeShareLink}
              onClose={() => setWorkspaceOpen(false)}
            />
          </div>
        </>
      ) : null}

      <input
        ref={importInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportFile}
      />
    </div>
  )
}
