import { Globe2, LockKeyhole } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MemberContributionList } from '../analysis/MemberContributionList'
import { type ChartMetricKey } from '../analysis/MetricBandChart'
import { MonthlyResultsTable } from '../analysis/MonthlyResultsTable'
import { OverviewPanel } from '../analysis/OverviewPanel'
import { ScenarioDeck } from '../analysis/ScenarioDeck'
import { Panel, SectionTitle, SegmentTabs, StatCard } from '../common/ui'
import { SharedInputsPanel } from './SharedInputsPanel'
import type { PublicShareResponse } from '../../lib/api'
import { api } from '../../lib/api'
import { formatCurrency, formatDateTime, formatPaybackMonths, formatPercent } from '../../lib/format'
import type { ScenarioKey } from '../../types'

type SharedView = 'analysis' | 'months' | 'members' | 'inputs'

const scenarioTabs: Array<{ value: ScenarioKey; label: string }> = [
  { value: 'pessimistic', label: '悲观' },
  { value: 'base', label: '基准' },
  { value: 'optimistic', label: '乐观' },
]

const viewTabs: Array<{ value: SharedView; label: string }> = [
  { value: 'analysis', label: '看经营' },
  { value: 'months', label: '看月份' },
  { value: 'members', label: '看成员' },
  { value: 'inputs', label: '看输入' },
]

const chartMetricTabs: Array<{ value: ChartMetricKey; label: string }> = [
  { value: 'cash', label: '累计现金' },
  { value: 'profit', label: '利润' },
  { value: 'revenue', label: '收入' },
  { value: 'cost', label: '总成本' },
]

export function SharedVersionScreen(props: {
  shareToken: string
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [share, setShare] = useState<PublicShareResponse | null>(null)
  const [selectedScenario, setSelectedScenario] = useState<ScenarioKey>('base')
  const [selectedView, setSelectedView] = useState<SharedView>('analysis')
  const [selectedMonthId, setSelectedMonthId] = useState('')
  const [chartMetric, setChartMetric] = useState<ChartMetricKey>('cash')

  useEffect(() => {
    let active = true

    async function loadShare() {
      setLoading(true)
      try {
        const nextShare = await api.getSharedVersion(props.shareToken)
        if (!active) {
          return
        }
        setShare(nextShare)
        setError(null)
      } catch (loadError) {
        if (!active) {
          return
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadShare()

    return () => {
      active = false
    }
  }, [props.shareToken])

  const scenarios = share?.result.scenarios ?? []
  const scenario = scenarios.find((item) => item.key === selectedScenario) ?? scenarios[0] ?? null
  const selectedMonthResult = scenario?.months.find((month) => month.monthId === selectedMonthId) ?? scenario?.months[0] ?? null
  const selectedMonthPlan = share?.config.months.find((month) => month.id === selectedMonthResult?.monthId) ?? share?.config.months[0] ?? null

  useEffect(() => {
    if (!scenario) {
      return
    }

    if (!scenario.months.some((month) => month.monthId === selectedMonthId)) {
      setSelectedMonthId(scenario.months[0]?.monthId ?? '')
    }
  }, [scenario, selectedMonthId])

  const heroStats = useMemo(() => {
    if (!share || !scenario) {
      return []
    }

    const totalInvestment = share.config.shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)

    return [
      { label: '工作区', value: share.workspaceName },
      { label: '版本', value: `#${share.versionNo}` },
      { label: '发布时间', value: formatDateTime(share.createdAt) },
      { label: '总投资', value: formatCurrency(totalInvestment) },
      { label: '投资回报率', value: formatPercent(scenario.roi) },
      { label: '回本周期', value: formatPaybackMonths(scenario.paybackMonthIndex) },
    ]
  }, [scenario, share])

  if (loading) {
    return (
      <ShareShell>
        <Panel>
          <SectionTitle icon={Globe2} eyebrow="分享版本" title="正在加载分享测算" />
        </Panel>
      </ShareShell>
    )
  }

  if (!share || !scenario || !selectedMonthResult || !selectedMonthPlan) {
    return (
      <ShareShell>
        <Panel>
          <SectionTitle
            icon={LockKeyhole}
            eyebrow="分享版本"
            title="分享链接不可用"
            description={error ?? '该分享链接无效、已撤销或已失效。'}
          />
        </Panel>
      </ShareShell>
    )
  }

  return (
    <ShareShell>
      <div className="grid gap-4">
        <Panel className="overflow-hidden bg-[linear-gradient(135deg,rgba(28,25,23,0.96),rgba(68,64,60,0.94))] text-white">
          <SectionTitle
            icon={Globe2}
            eyebrow="分享版本"
            title={share.versionName}
            description="只读查看发布版测算、经营分析和模型输入。"
            dark
            aside={
              <a
                href="/"
                className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                打开应用
              </a>
            }
          />

          <div className="mt-6 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {heroStats.map((item) => (
              <StatCard key={item.label} label={item.label} value={item.value} dark />
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <SegmentTabs value={selectedView} items={viewTabs} onChange={setSelectedView} />
            <SegmentTabs value={selectedScenario} items={scenarioTabs} onChange={setSelectedScenario} compact />
          </div>
        </Panel>

        {selectedView === 'analysis' ? (
          <>
            <ScenarioDeck scenarios={share.result.scenarios} selectedKey={selectedScenario} onSelect={setSelectedScenario} />
            <OverviewPanel
              scenarios={share.result.scenarios}
              selectedScenarioResult={scenario}
              chartMetric={chartMetric}
              chartMetricTabs={chartMetricTabs}
              onChartMetricChange={setChartMetric}
              months={share.config.months}
              selectedMonthPlan={selectedMonthPlan}
              selectedMonthResult={selectedMonthResult}
              onSelectMonth={setSelectedMonthId}
            />
          </>
        ) : null}

        {selectedView === 'months' ? (
          <MonthlyResultsTable months={scenario.months} selectedMonthId={selectedMonthId} onSelectMonth={setSelectedMonthId} />
        ) : null}

        {selectedView === 'members' ? (
          <MemberContributionList months={scenario.months} selectedMonthId={selectedMonthId} onSelectMonth={setSelectedMonthId} />
        ) : null}

        {selectedView === 'inputs' ? (
          <SharedInputsPanel
            config={share.config}
            selectedScenario={selectedScenario}
            selectedScenarioResult={scenario}
          />
        ) : null}
      </div>
    </ShareShell>
  )
}

function ShareShell(props: {
  children: ReactNode
}) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(251,191,36,0.18),transparent_40%),linear-gradient(180deg,#f8fafc_0%,#f5f5f4_100%)] px-4 py-6 text-stone-900 md:px-6 md:py-8">
      <main className="mx-auto w-full max-w-7xl">{props.children}</main>
    </div>
  )
}
