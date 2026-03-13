import { Globe2, LockKeyhole, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PublicShareResponse } from '../../lib/api'
import { api } from '../../lib/api'
import { cx, formatCurrency, formatDateTime, formatPaybackMonths, formatPercent } from '../../lib/format'
import { getScenarioLabel } from '../../lib/scenarios'
import type { ScenarioKey } from '../../types'
import { Panel, SectionTitle, SegmentTabs, StatCard } from '../common/ui'

const scenarioTabs: Array<{ value: ScenarioKey; label: string }> = [
  { value: 'pessimistic', label: '悲观' },
  { value: 'base', label: '基准' },
  { value: 'optimistic', label: '乐观' },
]

export function SharedVersionScreen(props: {
  shareToken: string
}) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [share, setShare] = useState<PublicShareResponse | null>(null)
  const [selectedScenario, setSelectedScenario] = useState<ScenarioKey>('base')

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

  const scenario =
    share?.result.scenarios.find((item) => item.key === selectedScenario) ?? share?.result.scenarios[0] ?? null

  const assumptionRows = useMemo(() => {
    if (!share) {
      return []
    }

    return [
      { label: '规划周期', value: `${share.config.planning.horizonMonths} 个月` },
      { label: '股东数', value: `${share.config.shareholders.length}` },
      { label: '成员数', value: `${share.config.teamMembers.length}` },
      { label: '员工数', value: `${share.config.employees.length}` },
      { label: '线下单价', value: formatCurrency(share.config.operating.offlineUnitPrice) },
      { label: '线上单价', value: formatCurrency(share.config.operating.onlineUnitPrice) },
    ]
  }, [share])

  if (loading) {
    return (
      <ShareShell>
        <Panel>
          <SectionTitle icon={Globe2} eyebrow="分享版本" title="正在加载分享测算" />
        </Panel>
      </ShareShell>
    )
  }

  if (!share || !scenario) {
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
      <div className="grid gap-6">
        <Panel className="overflow-hidden bg-[linear-gradient(135deg,rgba(28,25,23,0.96),rgba(68,64,60,0.94))] text-white">
          <SectionTitle
            icon={Globe2}
            eyebrow="分享版本"
            title={share.versionName}
            description="该链接展示的是只读发布版测算。草稿编辑、记账操作和版本管理仍保持私有。"
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

          <div className="mt-6 grid gap-3 md:grid-cols-4">
            <StatCard label="工作区" value={share.workspaceName} dark />
            <StatCard label="版本" value={`#${share.versionNo}`} dark />
            <StatCard label="发布时间" value={formatDateTime(share.createdAt)} dark />
            <StatCard label="分享时间" value={formatDateTime(share.sharedAt)} dark />
          </div>
        </Panel>

        <Panel>
          <SectionTitle
            icon={LockKeyhole}
            eyebrow="测算假设"
            title="已发布测算基线"
            description="访问者看到的是发布时冻结的配置和结果。"
            aside={<SegmentTabs value={selectedScenario} items={scenarioTabs} onChange={setSelectedScenario} compact />}
          />

          <div className="mt-5 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            {assumptionRows.map((row) => (
              <StatCard key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionTitle
            icon={Globe2}
            eyebrow="场景"
            title={`${getScenarioLabel(scenario.key, scenario.label)}场景总览`}
            description="分享页始终只读，并且永远读取发布时冻结的结果载荷。"
          />

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="营收" value={formatCurrency(scenario.grossSales)} />
            <StatCard label="成本" value={formatCurrency(scenario.totalCost)} />
            <StatCard label="利润" value={formatCurrency(scenario.totalProfit)} />
            <StatCard label="期末现金" value={formatCurrency(scenario.netCashAfterInvestment)} />
            <StatCard label="投资回报率" value={formatPercent(scenario.roi)} />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <StatCard label="回本周期" value={formatPaybackMonths(scenario.paybackMonthIndex)} />
            <StatCard label="总场次" value={`${scenario.totalEvents}`} />
            <StatCard label="单场平均张数" value={`${scenario.averageUnitsPerEvent.toFixed(1)}`} />
          </div>
        </Panel>

        <Panel>
          <SectionTitle
            icon={Table2}
            eyebrow="月度明细"
            title="发布版月度结果"
            description="收入、成本、利润和累计现金都固定为该版本发布时的结果。"
          />

          <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell>月份</HeaderCell>
                  <HeaderCell>场次</HeaderCell>
                  <HeaderCell>营收</HeaderCell>
                  <HeaderCell>成本</HeaderCell>
                  <HeaderCell>利润</HeaderCell>
                  <HeaderCell>累计现金</HeaderCell>
                </tr>
              </thead>
              <tbody>
                {scenario.months.map((month) => (
                  <tr key={month.monthId} className="border-b border-stone-900/10 last:border-none">
                    <BodyCell className="font-semibold text-stone-950">{month.label}</BodyCell>
                    <BodyCell>{month.events}</BodyCell>
                    <BodyCell>{formatCurrency(month.grossSales)}</BodyCell>
                    <BodyCell>{formatCurrency(month.totalCost)}</BodyCell>
                    <BodyCell className={month.monthlyProfit >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-rose-700'}>
                      {formatCurrency(month.monthlyProfit)}
                    </BodyCell>
                    <BodyCell className={month.cumulativeCash >= 0 ? 'font-semibold text-emerald-700' : 'font-semibold text-stone-700'}>
                      {formatCurrency(month.cumulativeCash)}
                    </BodyCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
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

function HeaderCell(props: {
  children: string
}) {
  return <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-[0.16em]">{props.children}</th>
}

function BodyCell(props: {
  children: ReactNode
  className?: string | undefined
}) {
  return <td className={cx('px-4 py-3 text-center text-stone-700', props.className)}>{props.children}</td>
}
