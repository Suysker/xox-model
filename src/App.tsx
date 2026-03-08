import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard,
  LineChart,
  Settings2,
  Vault,
  type LucideIcon,
} from 'lucide-react'
import { MemberContributionList } from './components/analysis/MemberContributionList'
import { MetricBandChart, type ChartMetricKey } from './components/analysis/MetricBandChart'
import { MonthlyResultsTable } from './components/analysis/MonthlyResultsTable'
import { OverviewPanel } from './components/analysis/OverviewPanel'
import { ScenarioDeck } from './components/analysis/ScenarioDeck'
import { NoticeBanner, type NoticeTone } from './components/common/NoticeBanner'
import { Panel, SectionTitle, SegmentTabs, StatCard } from './components/common/ui'
import { OperatingWorkbench } from './components/inputs/OperatingWorkbench'
import { TeamMembersTable } from './components/inputs/TeamMembersTable'
import { TimelineEditor } from './components/inputs/TimelineEditor'
import { MainTabsNav } from './components/layout/MainTabsNav'
import { ProductHero } from './components/layout/ProductHero'
import { WorkspacePanel } from './components/workspace/WorkspacePanel'
import { WorkspaceToolbar } from './components/workspace/WorkspaceToolbar'
import { useWorkspace } from './hooks/useWorkspace'
import { createMember, createMonth } from './lib/defaults'
import { formatCurrency } from './lib/format'
import { projectModel } from './lib/model'
import { parseWorkspaceBundle, serializeWorkspaceBundle } from './lib/storage'
import type { ModelConfig, MonthlyPlan, ScenarioKey, WorkspaceSnapshot } from './types'

type MainTab = 'dashboard' | 'inputs' | 'workspace'
type DashboardTab = 'overview' | 'months' | 'members'
type InputsTab = 'team' | 'operating' | 'timeline'
type BannerState = { tone: NoticeTone; message: string }

const mainTabs: Array<{ value: MainTab; label: string; description: string; icon: LucideIcon }> = [
  {
    value: 'dashboard',
    label: '经营分析',
    description: '先看三档场景、月度现金流和回本节奏。',
    icon: LayoutDashboard,
  },
  {
    value: 'inputs',
    label: '模型输入',
    description: '按成员、经营底盘和月度排期逐层调整。',
    icon: Settings2,
  },
  {
    value: 'workspace',
    label: '版本工作区',
    description: '管理快照、发布版，以及导入导出。',
    icon: Vault,
  },
]

const dashboardTabs: Array<{ value: DashboardTab; label: string }> = [
  { value: 'overview', label: '总览' },
  { value: 'months', label: '月度表' },
  { value: 'members', label: '成员拆解' },
]

const inputTabs: Array<{ value: InputsTab; label: string }> = [
  { value: 'team', label: '团队成员' },
  { value: 'operating', label: '经营底盘' },
  { value: 'timeline', label: '月度排期' },
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

  function updateMonth(id: string, updater: (month: MonthlyPlan) => MonthlyPlan) {
    setConfig((current) => ({
      ...current,
      months: current.months.map((month) => (month.id === id ? updater(month) : month)),
    }))
  }

  function handleAddMember() {
    setConfig((current) => {
      const nextIndex = current.teamMembers.length + 1
      const nextMember = createMember(`${Date.now()}`, {
        name: `成员 ${nextIndex}`,
      })

      return {
        ...current,
        teamMembers: [...current.teamMembers, nextMember],
      }
    })
  }

  function handleRemoveMember(id: string) {
    setConfig((current) => ({
      ...current,
      teamMembers: current.teamMembers.length > 1
        ? current.teamMembers.filter((member) => member.id !== id)
        : current.teamMembers,
    }))
  }

  function handleAddMonth() {
    const nextMonth = createMonth(`${Date.now()}`, {
      label: `第${config.months.length + 1}月`,
    })

    setConfig((current) => ({
      ...current,
      months: [...current.months, nextMonth],
    }))
    setSelectedMonthId(nextMonth.id)
  }

  function handleRemoveMonth(id: string) {
    setConfig((current) => {
      if (current.months.length === 1) {
        return current
      }

      return {
        ...current,
        months: current.months.filter((month) => month.id !== id),
      }
    })
  }

  function handleSaveSnapshot() {
    saveSnapshot()
    setBanner({ tone: 'success', message: '已保存当前草稿快照。' })
  }

  function handlePublishRelease() {
    publishRelease()
    setBanner({ tone: 'success', message: '已发布当前版本，后续可作为里程碑基线回滚。' })
  }

  function handleLoadSnapshot(id: string) {
    const snapshot = findSnapshot(snapshots, id)

    loadSnapshot(id)
    setMainTab('dashboard')
    setDashboardTab('overview')
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

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
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
    setBanner({ tone: 'info', message: '已重置为新的草稿工作区。' })
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.12),_transparent_28%),linear-gradient(180deg,_#fbf8f1_0%,_#f3ede3_100%)] px-4 py-5 text-stone-900 md:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <ProductHero
          workspaceName={workspaceName}
          scenario={selectedScenarioResult}
          memberCount={config.teamMembers.length}
          monthCount={config.months.length}
          snapshotCount={snapshots.length}
        />

        <WorkspaceToolbar
          workspaceName={workspaceName}
          snapshotCount={snapshots.length}
          lastSavedAt={lastSavedAt}
          onNameChange={setWorkspaceName}
          onSaveSnapshot={handleSaveSnapshot}
          onPublishRelease={handlePublishRelease}
          onExport={handleExportBundle}
          onImportClick={() => importInputRef.current?.click()}
          onReset={handleResetWorkspace}
        />

        {banner ? (
          <NoticeBanner tone={banner.tone} message={banner.message} onDismiss={() => setBanner(null)} />
        ) : null}

        <MainTabsNav tabs={mainTabs} value={mainTab} onChange={setMainTab} />

        {mainTab === 'dashboard' ? (
          <div className="grid gap-4">
            <Panel>
              <SectionTitle
                icon={LineChart}
                eyebrow="Analysis"
                title="三档场景总览"
                description="先切换悲观 / 基准 / 乐观判断口径，再查看月度表和成员拆解。灰色带表示上下界，彩色线表示三档路径。"
              />
              <div className="mt-5">
                <ScenarioDeck
                  scenarios={projection.scenarios}
                  selectedKey={selectedScenario}
                  onSelect={setSelectedScenario}
                />
              </div>
            </Panel>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <SegmentTabs value={dashboardTab} items={dashboardTabs} onChange={setDashboardTab} />
            </div>

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
                onSelectMonth={(id) => {
                  setSelectedMonthId(id)
                  setDashboardTab('members')
                }}
              />
            ) : null}

            {dashboardTab === 'members' ? (
              <MemberContributionList
                months={selectedScenarioResult.months}
                selectedMonthId={selectedMonthId}
                onSelectMonth={setSelectedMonthId}
              />
            ) : null}
          </div>
        ) : null}

        {mainTab === 'inputs' ? (
          <div className="grid gap-4">
            <Panel className="p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">Inputs</p>
                  <h2 className="mt-2 text-2xl font-bold text-stone-950">模型输入工作台</h2>
                  <p className="mt-2 text-sm leading-7 text-stone-600">
                    把输入拆成三个层级：成员是收入引擎，经营底盘定义成本结构，月度排期决定现金流节奏。
                  </p>
                </div>
                <SegmentTabs value={inputsTab} items={inputTabs} onChange={setInputsTab} />
              </div>
            </Panel>

            {inputsTab === 'team' ? (
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
                onAllowanceChange={(id, value) =>
                  updateMember(id, (member) => ({ ...member, eventAllowance: value }))
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
            ) : null}

            {inputsTab === 'operating' ? (
              <OperatingWorkbench operating={config.operating} onChange={updateOperating} />
            ) : null}

            {inputsTab === 'timeline' ? (
              <TimelineEditor
                months={config.months}
                selectedMonthId={selectedMonthId}
                onSelect={setSelectedMonthId}
                onAddMonth={handleAddMonth}
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
                onRemove={handleRemoveMonth}
              />
            ) : null}
          </div>
        ) : null}

        {mainTab === 'workspace' ? (
          <div className="grid gap-4">
            <WorkspacePanel
              snapshots={snapshots}
              onLoadSnapshot={handleLoadSnapshot}
              onDeleteSnapshot={handleDeleteSnapshot}
              onPromoteToRelease={handlePromoteSnapshot}
            />

            <Panel>
              <SectionTitle
                icon={Vault}
                eyebrow="Workspace"
                title="导入、发布与协作口径"
                description="工作区不是附属功能。快照适合做试算存档，发布版适合锁定给投资人、合伙人或团队内部同步的统一口径。"
              />

              <div className="mt-5 grid gap-3 md:grid-cols-4">
                <StatCard label="当前工作区" value={workspaceName} />
                <StatCard label="成员数量" value={`${config.teamMembers.length} 人`} />
                <StatCard label="规划月份" value={`${config.months.length} 个月`} />
                <StatCard label="初始投入" value={formatCurrency(config.operating.initialInvestment)} />
              </div>

              <div className="mt-5 grid gap-3 lg:grid-cols-3">
                <WorkspaceGuide
                  title="保存快照"
                  text="每次改完成员假设或月度排期，先保存快照，避免回不到上一版口径。"
                />
                <WorkspaceGuide
                  title="发布版本"
                  text="准备对外讨论时，再把当前模型发布成里程碑版本，和普通草稿分开。"
                />
                <WorkspaceGuide
                  title="导出 JSON"
                  text="把当前工作区导出给别人，或者留作本地备份。导入后会完整恢复当前模型和历史版本。"
                />
              </div>
            </Panel>
          </div>
        ) : null}
      </div>

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

function WorkspaceGuide(props: {
  title: string
  text: string
}) {
  return (
    <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 px-4 py-4">
      <p className="text-sm font-semibold text-stone-950">{props.title}</p>
      <p className="mt-2 text-sm leading-7 text-stone-600">{props.text}</p>
    </div>
  )
}
