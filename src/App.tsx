import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { LayoutDashboard, LineChart, Settings2, type LucideIcon } from 'lucide-react'
import { MemberContributionList } from './components/analysis/MemberContributionList'
import { type ChartMetricKey } from './components/analysis/MetricBandChart'
import { MonthlyResultsTable } from './components/analysis/MonthlyResultsTable'
import { OverviewPanel } from './components/analysis/OverviewPanel'
import { ScenarioDeck } from './components/analysis/ScenarioDeck'
import { NoticeBanner, type NoticeTone } from './components/common/NoticeBanner'
import { Panel, SectionTitle, SegmentTabs } from './components/common/ui'
import { OperatingWorkbench } from './components/inputs/OperatingWorkbench'
import { EmployeesTable } from './components/inputs/EmployeesTable'
import { TeamMembersTable } from './components/inputs/TeamMembersTable'
import { TimelineEditor } from './components/inputs/TimelineEditor'
import { ProductHero } from './components/layout/ProductHero'
import { SidebarNav } from './components/layout/SidebarNav'
import { WorkspacePanel } from './components/workspace/WorkspacePanel'
import { WorkspaceToolbar } from './components/workspace/WorkspaceToolbar'
import { useWorkspace } from './hooks/useWorkspace'
import { createEmployee, createMember } from './lib/defaults'
import { projectModel } from './lib/model'
import { parseWorkspaceBundle, serializeWorkspaceBundle } from './lib/storage'
import { syncMonthsToPlanning } from './lib/defaults'
import type { ModelConfig, MonthlyPlan, MonthlyPlanTemplate, ScenarioKey, WorkspaceSnapshot } from './types'

type MainTab = 'dashboard' | 'inputs'
type DashboardTab = 'overview' | 'months' | 'members'
type InputsTab = 'team' | 'operating' | 'timeline'
type BannerState = { tone: NoticeTone; message: string }
type TimelineSection = 'sales' | 'training' | 'special'
type TimelineTemplateNumberKey =
  | 'events'
  | 'salesMultiplier'
  | 'rehearsalCount'
  | 'rehearsalCost'
  | 'teacherCount'
  | 'teacherCost'
  | 'extraPerEventCost'
  | 'extraFixedCost'
  | 'vjCost'
  | 'originalSongCost'
  | 'makeupCost'
  | 'travelCost'
  | 'streamingCost'
  | 'mealCost'

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
    description: '配置成员、经济参数和整段经营周期。',
    icon: Settings2,
  },
]

const dashboardTabs: Array<{ value: DashboardTab; label: string; description: string }> = [
  { value: 'overview', label: '总览', description: '先看上下界、ROI 和当前月透视。' },
  { value: 'months', label: '月度表', description: '逐月展开营收、成本、利润与累计现金。' },
  { value: 'members', label: '成员拆解', description: '按月份看每个成员的收入贡献。' },
]

const inputTabs: Array<{ value: InputsTab; label: string; description: string }> = [
  { value: 'team', label: '成员与员工', description: '配置成员收入结构，以及员工月薪和场次成本。' },
  { value: 'operating', label: '经营底盘', description: '定义单价、固定成本、场次成本与耗材。' },
  { value: 'timeline', label: '月度排期', description: '按月份矩阵批量维护经营周期。' },
]

const chartMetricTabs: Array<{ value: ChartMetricKey; label: string }> = [
  { value: 'cash', label: '累计现金' },
  { value: 'profit', label: '月利润' },
  { value: 'revenue', label: '月收入' },
  { value: 'cost', label: '月总成本' },
]

function sanitizeFilename(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 48) || 'workspace'
}

function findSnapshot(snapshots: WorkspaceSnapshot[], id: string) {
  return snapshots.find((snapshot) => snapshot.id === id)
}

const timelineSectionKeys: Record<TimelineSection, TimelineTemplateNumberKey[]> = {
  sales: ['events', 'salesMultiplier'],
  training: ['rehearsalCount', 'rehearsalCost', 'teacherCount', 'teacherCost', 'extraPerEventCost', 'extraFixedCost'],
  special: ['vjCost', 'originalSongCost', 'makeupCost', 'travelCost', 'streamingCost', 'mealCost'],
}

function applyTemplateToMonthSection(
  month: MonthlyPlan,
  template: MonthlyPlanTemplate,
  section: TimelineSection,
): MonthlyPlan {
  const nextMonth = {
    ...month,
  }

  timelineSectionKeys[section].forEach((key) => {
    nextMonth[key] = template[key]
  })

  if (section === 'sales') {
    nextMonth.includeMaterialCost = template.includeMaterialCost
  }

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
  const [inputsTab, setInputsTab] = useState<InputsTab>('team')
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

  function updateOperating(key: keyof ModelConfig['operating'], value: number) {
    setConfig((current) => ({
      ...current,
      operating: {
        ...current.operating,
        [key]: value,
      },
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

  function updateTimelineTemplate(key: TimelineTemplateNumberKey, value: number) {
    setConfig((current) => ({
      ...current,
      timelineTemplate: {
        ...current.timelineTemplate,
        [key]: value,
      },
    }))
  }

  function updateTimelineTemplateMaterial(value: boolean) {
    setConfig((current) => ({
      ...current,
      timelineTemplate: {
        ...current.timelineTemplate,
        includeMaterialCost: value,
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
        months: syncMonthsToPlanning(current.months, nextPlanning, 'workspace', current.timelineTemplate),
      }
    })
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
    setInputsTab('team')
    setDashboardTab('overview')
    setWorkspaceOpen(false)
    setBanner({ tone: 'info', message: '已重置为新的草稿工作区。' })
  }

  function handleApplyTemplateToAll(section: TimelineSection) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) => applyTemplateToMonthSection(month, current.timelineTemplate, section)),
    }))

    setBanner({ tone: 'success', message: '已将默认模板应用到全部月份，你可以再逐月调整差异。' })
  }

  function handleResetMonthFromTemplate(id: string, section: TimelineSection) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) =>
        month.id === id ? applyTemplateToMonthSection(month, current.timelineTemplate, section) : month,
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
                    description="先看悲观 / 基准 / 乐观的上下界，再决定要不要回到左侧的输入模块里继续修模型。"
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
                    initialInvestment={config.operating.initialInvestment}
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
                {inputsTab === 'team' ? (
                  <div className="space-y-4">
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

                {inputsTab === 'operating' ? (
                  <OperatingWorkbench
                    operating={config.operating}
                    planning={config.planning}
                    onOperatingChange={updateOperating}
                    onPlanningChange={updatePlanning}
                  />
                ) : null}

                {inputsTab === 'timeline' ? (
                  <TimelineEditor
                    template={config.timelineTemplate}
                    months={config.months}
                    onTemplateNumberChange={updateTimelineTemplate}
                    onTemplateMaterialToggle={updateTimelineTemplateMaterial}
                    onTextChange={(id, key, value) =>
                      updateMonth(id, (month) => ({
                        ...month,
                        [key]: value,
                      }))
                    }
                    onNumberChange={(id, key, value) =>
                      updateMonth(id, (month) => ({
                        ...month,
                        [key]: value,
                      }))
                    }
                    onMaterialToggle={(id, value) =>
                      updateMonth(id, (month) => ({
                        ...month,
                        includeMaterialCost: value,
                      }))
                    }
                    onApplyTemplateToAll={handleApplyTemplateToAll}
                    onResetMonthFromTemplate={handleResetMonthFromTemplate}
                  />
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
