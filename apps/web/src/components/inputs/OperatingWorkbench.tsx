import { Coins, Plus, Trash2 } from 'lucide-react'
import { monthLabelOptions } from '../../lib/defaults'
import { cx, formatCurrency, formatPercent } from '../../lib/format'
import type { PlanningConfig, Shareholder } from '../../types'
import { BodyCell, CompactNumberInput, DenseFieldInput, DenseFieldSelect, HeaderCell, InlineStatPill, Panel, SectionTitle } from '../common/ui'
import { actionText, label } from '../common/typography'

export function OperatingWorkbench(props: {
  shareholders: Shareholder[]
  planning: PlanningConfig
  onPlanningChange: (key: keyof PlanningConfig, value: number) => void
  onShareholderAdd: () => void
  onShareholderRemove: (id: string) => void
  onShareholderNameChange: (id: string, value: string) => void
  onShareholderInvestmentChange: (id: string, value: number) => void
  onShareholderDividendChange: (id: string, value: number) => void
}) {
  const totalInvestment = props.shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)
  const totalDividendRate = props.shareholders.reduce((sum, shareholder) => sum + shareholder.dividendRate, 0)

  return (
    <Panel>
      <SectionTitle
        icon={Coins}
        eyebrow="输入"
        title="股东投资"
        aside={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <label className="inline-flex min-w-[220px] items-center justify-between gap-3 rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
              <span className={cx('text-stone-600', label)}>经营开始月份</span>
              <DenseFieldSelect
                fieldSize="xs"
                surface="white"
                className="h-10 w-[110px] shrink-0 rounded-xl px-3"
                value={props.planning.startMonth}
                onChange={(event) => props.onPlanningChange('startMonth', Number(event.target.value))}
              >
                {monthLabelOptions.map((label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ))}
              </DenseFieldSelect>
            </label>

            <label className="inline-flex min-w-[190px] items-center justify-between gap-3 rounded-[18px] border border-stone-900/10 bg-stone-50/90 px-4 py-3">
              <span className={cx('text-stone-600', label)}>规划月数</span>
              <CompactNumberInput
                value={props.planning.horizonMonths}
                min={1}
                max={24}
                step={1}
                size="sm"
                align="center"
                suffix="月"
                className="h-10 w-[108px] shrink-0 rounded-xl bg-white"
                onChange={(value) => props.onPlanningChange('horizonMonths', value)}
              />
            </label>

            <InlineStatPill label="总投资" value={formatCurrency(totalInvestment)} />
            <InlineStatPill label="股东人数" value={`${props.shareholders.length} 人`} className="min-w-[150px]" />
            <InlineStatPill
              label="分红比例合计"
              value={formatPercent(totalDividendRate)}
              tone={Math.abs(totalDividendRate - 1) <= 0.001 ? 'ok' : 'warn'}
              className="min-w-[188px]"
            />

            <button
              type="button"
              onClick={props.onShareholderAdd}
              className={cx(
                'inline-flex h-[54px] items-center justify-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-5 text-white transition hover:bg-stone-800',
                actionText,
              )}
            >
              <Plus className="h-4 w-4" />
              添加股东
            </button>
          </div>
        }
      />

      <div className="mt-5 rounded-[24px] border border-stone-900/10 bg-white">
        <table className="w-full table-fixed">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[26%]" />
            <col className="w-[26%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="bg-stone-100/90 text-stone-700">
            <tr className="border-b border-stone-900/10">
              <HeaderCell>股东</HeaderCell>
              <HeaderCell>投资额</HeaderCell>
              <HeaderCell>分红比例</HeaderCell>
              <HeaderCell>删除</HeaderCell>
            </tr>
          </thead>
          <tbody>
            {props.shareholders.map((shareholder) => (
              <tr key={shareholder.id} className="border-b border-stone-900/10 last:border-none">
                <BodyCell>
                  <DenseFieldInput
                    value={shareholder.name}
                    onChange={(event) => props.onShareholderNameChange(shareholder.id, event.target.value)}
                    fieldSize="xs"
                    align="center"
                  />
                </BodyCell>
                <BodyCell className="px-1.5 py-1.5">
                  <CompactNumberInput
                    value={shareholder.investmentAmount}
                    min={0}
                    step={1000}
                    size="xs"
                    align="center"
                    onChange={(value) => props.onShareholderInvestmentChange(shareholder.id, value)}
                  />
                </BodyCell>
                <BodyCell className="px-1.5 py-1.5">
                  <CompactNumberInput
                    value={shareholder.dividendRate * 100}
                    min={0}
                    max={100}
                    step={0.1}
                    size="xs"
                    align="center"
                    onChange={(value) => props.onShareholderDividendChange(shareholder.id, value / 100)}
                  />
                </BodyCell>
                <BodyCell className="px-1.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => props.onShareholderRemove(shareholder.id)}
                    disabled={props.shareholders.length === 1}
                    aria-label={`删除 ${shareholder.name}`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-600 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </BodyCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
