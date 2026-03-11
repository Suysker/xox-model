import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { LayoutDashboard, LineChart, Settings2, type LucideIcon } from 'lucide-react'
import { MemberContributionList } from './components/analysis/MemberContributionList'
import { type ChartMetricKey } from './components/analysis/MetricBandChart'
import { MonthlyResultsTable } from './components/analysis/MonthlyResultsTable'
import { OverviewPanel } from './components/analysis/OverviewPanel'
import { ScenarioDeck } from './components/analysis/ScenarioDeck'
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
import { WorkspacePanel } from './components/workspace/WorkspacePanel'
import { WorkspaceToolbar } from './components/workspace/WorkspaceToolbar'
import { useWorkspace } from './hooks/useWorkspace'
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

type MainTab = 'dashboard' | 'inputs'
type DashboardTab = 'overview' | 'months' | 'members'
type InputsTab = 'capital' | 'revenue' | 'cost'
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
]

const dashboardTabs: Array<{ value: DashboardTab; label: string; description: string }> = [
  { value: 'overview', label: '总览', description: '先看上下界、ROI 和当前月透视。' },
  { value: 'months', label: '月度表', description: '逐月展开营收、成本、利润与累计现金。' },
  { value: 'members', label: '成员拆解', description: '按月份看每个成员的收入贡献。' },
]

const inputTabs: Array<{ value: InputsTab; label: string; description: string }> = [
  { value: 'capital', label: '股东投资', description: '配置投资金额、股东结构和分红比例。' },
  { value: 'revenue', label: '收入引擎', description: '把线上/线下单价、成员卖张、场次节奏和线上系数放在一起配置。' },
  { value: 'cost', label: '成本结构', description: '先看成本概览，再改成本编辑。' },
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
  const {
    bundle,
    workspaceName,
    config,
    snapshots,
    lastSavedAt,
    setWorkspaceName,
    setConfig,
    saveSnapshot,
    publishRelease,
    loadSnapshot,
    deleteSnapshot,
    promoteSnapshotToRelease,
    importBundle,
    resetWorkspace,
  } = useWorkspace()

  const [mainTab, setMainTab] = useState<MainTab>('dashboard')
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>('overview')
  const [inputsTab, setInputsTab] = useState<InputsTab>('revenue')
  const [selectedScenario, setSelectedScenario] = useState<ScenarioKey>('base')
  const [chartMetric, setChartMetric] = useState<ChartMetricKey>('cash')
  const [selectedMonthId, setSelectedMonthId] = useState(config.months[0]?.id ?? '')
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [banner, setBanner] = useState<BannerState | null>(null)

  const projection = projectModel(config)
  const selectedScenarioResult =
    projection.scenarios.find((scenario) => scenario.key === selectedScenario) ?? projection.scenarios[0]

  useEffect(() => {
    const firstMonthId = config.months[0]?.id ?? ''

    if (!config.months.some((month) => month.id === selectedMonthId)) {
      setSelectedMonthId(firstMonthId)
    }
  }, [config.months, selectedMonthId])

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
    setConfig((current) => ({
      ...current,
      timelineTemplate: {
        ...current.timelineTemplate,
        [key]: value,
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

  function handleSaveSnapshot() {
    saveSnapshot()
    setBanner({ tone: 'success', message: '已保存当前草稿快照。' })
  }

  function handlePublishRelease() {
    publishRelease()
    setBanner({ tone: 'success', message: '已发布当前版本，后续可以作为基线继续试算。' })
  }

  function handleLoadSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    loadSnapshot(id)
    setMainTab('dashboard')
    setDashboardTab('overview')
    setSelectedMonthId(snapshot?.config.months[0]?.id ?? '')
    setBanner({
      tone: 'info',
      message: snapshot ? `已加载版本：${snapshot.name}` : '已加载所选版本。',
    })
  }

  function handleDeleteSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    deleteSnapshot(id)
    setBanner({
      tone: 'info',
      message: snapshot ? `已删除版本：${snapshot.name}` : '已删除所选版本。',
    })
  }

  function handlePromoteSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    promoteSnapshotToRelease(id)
    setBanner({
      tone: 'success',
      message: snapshot ? `已将“${snapshot.name}”升级为发布版本。` : '已升级为发布版本。',
    })
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
        setBanner({ tone: 'error', message: '导入失败：文件格式不正确或不是工作区导出文件。' })
        return
      }

      importBundle(parsed)
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

  function handleResetWorkspace() {
    resetWorkspace()
    setMainTab('inputs')
    setInputsTab('revenue')
    setDashboardTab('overview')
    setWorkspaceOpen(false)
    setBanner({ tone: 'info', message: '已重置为新的草稿工作区。' })
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

        <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
          <SidebarNav
            title="地下偶像经营工作台"
            subtitle="左侧切换分析和输入，右上角管理快照、发布版本和导入导出。"
            mainItems={mainTabs}
            mainValue={mainTab}
            onMainChange={setMainTab}
            secondaryTitle={secondaryTitle}
            secondaryItems={secondaryItems}
            secondaryValue={secondaryValue}
            onSecondaryChange={(value) => {
              if (mainTab === 'dashboard') {
                setDashboardTab(value as DashboardTab)
                return
              }

              setInputsTab(value as InputsTab)
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
                    eyebrow="Analysis"
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
                          [key]: value,
                        }))
                      }
                      onApplyTemplateToAll={() => handleApplyTemplateToAll('sales')}
                      onResetMonthFromTemplate={(id) => handleResetMonthFromTemplate(id, 'sales')}
                    />

                    <TeamMembersTable
                      members={config.teamMembers}
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
                      selectedScenarioLabel={selectedScenarioResult.label}
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
          </main>
        </div>
      </div>

      <div className="fixed right-4 top-4 z-[60] md:right-6 md:top-5">
        <WorkspaceToolbar
          snapshotCount={snapshots.length}
          libraryOpen={workspaceOpen}
          onToggleLibrary={() => setWorkspaceOpen((current) => !current)}
        />
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
              onNameChange={setWorkspaceName}
              onSaveSnapshot={handleSaveSnapshot}
              onPublishRelease={handlePublishRelease}
              onExport={handleExportBundle}
              onImportClick={() => importInputRef.current?.click()}
              onReset={handleResetWorkspace}
              onLoadSnapshot={handleLoadSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
              onPromoteToRelease={handlePromoteSnapshot}
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
