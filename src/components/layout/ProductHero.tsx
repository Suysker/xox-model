import { Sparkles, Target, TrendingUp, Vault } from 'lucide-react'
import type { ScenarioResult } from '../../types'
import { formatCurrency, formatPercent } from '../../lib/format'
import { StatCard } from '../common/ui'

export function ProductHero(props: {
  workspaceName: string
  scenario: ScenarioResult
  memberCount: number
  monthCount: number
  snapshotCount: number
}) {
  return (
    <section className="overflow-hidden rounded-[32px] bg-stone-950 p-6 text-white shadow-[0_24px_80px_rgba(41,37,36,0.28)]">
      <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-stone-300">
            <Sparkles className="h-4 w-4 text-amber-300" />
            地下偶像经营工作台
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
            {props.workspaceName}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-stone-300 md:text-base">
            围绕“场次 x 成员单场张数 x 成本结构”来做月度现金流判断。先看回本节奏，再回到输入页修正成员假设和月度排期。
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-3 xl:min-w-[360px]">
          <Highlight icon={Target} label="当前场景" value={props.scenario.label} />
          <Highlight
            icon={Vault}
            label="回本判断"
            value={props.scenario.paybackMonthLabel ? `${props.scenario.paybackMonthLabel} 回本` : '周期内未回本'}
          />
          <Highlight icon={TrendingUp} label="当前 ROI" value={formatPercent(props.scenario.roi)} />
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard dark label="成员数量" value={`${props.memberCount} 人`} />
        <StatCard dark label="规划月份" value={`${props.monthCount} 个月`} />
        <StatCard dark label="版本快照" value={`${props.snapshotCount} 个`} />
        <StatCard dark label="期末现金" value={formatCurrency(props.scenario.netCashAfterInvestment)} />
      </div>
    </section>
  )
}

function Highlight(props: {
  icon: typeof Sparkles
  label: string
  value: string
}) {
  const Icon = props.icon

  return (
    <div className="rounded-[20px] border border-white/10 bg-white/5 px-3 py-3 backdrop-blur">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-stone-400">
        <Icon className="h-4 w-4 text-amber-300" />
        {props.label}
      </div>
      <p className="mt-2 text-sm font-semibold text-white md:text-base">{props.value}</p>
    </div>
  )
}
