import { Globe2, LockKeyhole, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PublicShareResponse } from '../../lib/api'
import { api } from '../../lib/api'
import { cx, formatCurrency, formatDateTime, formatPaybackMonths, formatPercent } from '../../lib/format'
import type { ScenarioKey } from '../../types'
import { Panel, SectionTitle, SegmentTabs, StatCard } from '../common/ui'

const scenarioTabs: Array<{ value: ScenarioKey; label: string }> = [
  { value: 'pessimistic', label: 'Conservative' },
  { value: 'base', label: 'Base' },
  { value: 'optimistic', label: 'Upside' },
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
      { label: 'Horizon', value: `${share.config.planning.horizonMonths} months` },
      { label: 'Shareholders', value: `${share.config.shareholders.length}` },
      { label: 'Team members', value: `${share.config.teamMembers.length}` },
      { label: 'Employees', value: `${share.config.employees.length}` },
      { label: 'Offline price', value: formatCurrency(share.config.operating.offlineUnitPrice) },
      { label: 'Online price', value: formatCurrency(share.config.operating.onlineUnitPrice) },
    ]
  }, [share])

  if (loading) {
    return (
      <ShareShell>
        <Panel>
          <SectionTitle icon={Globe2} eyebrow="Shared release" title="Loading shared forecast" />
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
            eyebrow="Shared release"
            title="Share link unavailable"
            description={error ?? 'This share link is invalid, revoked, or no longer available.'}
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
            eyebrow="Shared release"
            title={share.versionName}
            description="This link exposes a read-only published forecast. Draft edits, bookkeeping operations, and version actions stay private."
            dark
            aside={
              <a
                href="/"
                className="inline-flex items-center rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
              >
                Open app
              </a>
            }
          />

          <div className="mt-6 grid gap-3 md:grid-cols-4">
            <StatCard label="Workspace" value={share.workspaceName} dark />
            <StatCard label="Version" value={`#${share.versionNo}`} dark />
            <StatCard label="Published" value={formatDateTime(share.createdAt)} dark />
            <StatCard label="Shared" value={formatDateTime(share.sharedAt)} dark />
          </div>
        </Panel>

        <Panel>
          <SectionTitle
            icon={LockKeyhole}
            eyebrow="Assumptions"
            title="Published planning baseline"
            description="The recipient sees the exact released configuration and its frozen result set."
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
            eyebrow="Scenario"
            title={`${scenario.label} scenario summary`}
            description="The shared page stays read-only and always reads from the published result payload."
          />

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Revenue" value={formatCurrency(scenario.grossSales)} />
            <StatCard label="Cost" value={formatCurrency(scenario.totalCost)} />
            <StatCard label="Profit" value={formatCurrency(scenario.totalProfit)} />
            <StatCard label="Ending cash" value={formatCurrency(scenario.netCashAfterInvestment)} />
            <StatCard label="ROI" value={formatPercent(scenario.roi)} />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <StatCard label="Payback" value={formatPaybackMonths(scenario.paybackMonthIndex)} />
            <StatCard label="Total events" value={`${scenario.totalEvents}`} />
            <StatCard label="Average units/event" value={`${scenario.averageUnitsPerEvent.toFixed(1)}`} />
          </div>
        </Panel>

        <Panel>
          <SectionTitle
            icon={Table2}
            eyebrow="Monthly view"
            title="Monthly released results"
            description="Revenue, cost, profit, and cumulative cash are frozen at the moment this release was published."
          />

          <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell>Month</HeaderCell>
                  <HeaderCell>Events</HeaderCell>
                  <HeaderCell>Revenue</HeaderCell>
                  <HeaderCell>Cost</HeaderCell>
                  <HeaderCell>Profit</HeaderCell>
                  <HeaderCell>Cumulative cash</HeaderCell>
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
