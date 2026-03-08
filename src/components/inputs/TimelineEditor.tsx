import { CalendarRange, Plus } from 'lucide-react'
import { useState } from 'react'
import type { MonthlyPlan } from '../../types'
import { formatCurrency } from '../../lib/format'
import {
  InlinePairField,
  NumberField,
  Panel,
  SectionTitle,
  SegmentTabs,
  StatCard,
  TextAreaField,
} from '../common/ui'

type MonthNumberKey =
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

type MonthTextKey = 'label' | 'notes'
type DetailTab = 'rhythm' | 'coreCost' | 'specialCost' | 'notes'

function getSpecialCostTotal(month: MonthlyPlan) {
  return (
    month.extraFixedCost +
    month.vjCost +
    month.originalSongCost +
    month.makeupCost +
    month.travelCost +
    month.streamingCost +
    month.mealCost
  )
}

export function TimelineEditor(props: {
  months: MonthlyPlan[]
  selectedMonthId: string
  onSelect: (id: string) => void
  onAddMonth: () => void
  onTextChange: (id: string, key: MonthTextKey, value: string) => void
  onNumberChange: (id: string, key: MonthNumberKey, value: number) => void
  onMaterialToggle: (id: string, value: boolean) => void
  onRemove: (id: string) => void
}) {
  const [detailTab, setDetailTab] = useState<DetailTab>('rhythm')
  const selectedMonth = props.months.find((month) => month.id === props.selectedMonthId) ?? props.months[0]

  if (!selectedMonth) {
    return null
  }

  return (
    <Panel>
      <SectionTitle
        icon={CalendarRange}
        eyebrow="Inputs"
        title="月度经营排期"
        description="这里不再用长表单堆满屏幕，而是按月份切换编辑。每个月都能单独配置场次、销售系数和专项成本。"
        aside={
          <button
            type="button"
            onClick={props.onAddMonth}
            className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800"
          >
            <Plus className="h-4 w-4" />
            添加月份
          </button>
        }
      />

      <div className="mt-5 flex gap-3 overflow-x-auto pb-1">
        {props.months.map((month) => {
          const active = month.id === selectedMonth.id

          return (
            <div
              key={month.id}
              className={
                active
                  ? 'min-w-44 rounded-[22px] border border-amber-300 bg-amber-100/90 p-4 text-stone-950 shadow-[0_12px_30px_rgba(70,52,17,0.08)]'
                  : 'min-w-44 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-4 text-stone-700'
              }
            >
              <button
                type="button"
                onClick={() => props.onSelect(month.id)}
                className="w-full text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{month.label}</p>
                    <p className="mt-1 text-xs text-stone-600">
                      {month.events} 场 · 销售系数 {month.salesMultiplier}x
                    </p>
                  </div>
                  <span
                    className={
                      active
                        ? 'rounded-full border border-amber-300 bg-white/70 px-2 py-1 text-[11px] font-semibold text-amber-800'
                        : 'rounded-full border border-stone-900/10 bg-white/80 px-2 py-1 text-[11px] font-semibold text-stone-500'
                    }
                  >
                    {active ? '当前' : '查看'}
                  </span>
                </div>
              </button>

              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-stone-600">
                <span>{month.includeMaterialCost ? '计入耗材' : '不计耗材'}</span>
                <button
                  type="button"
                  onClick={() => props.onRemove(month.id)}
                  disabled={props.months.length === 1}
                  className="rounded-full border border-stone-900/10 bg-white px-2 py-1 text-[11px] font-semibold text-stone-600 disabled:opacity-40"
                >
                  删除
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="当前月份" value={selectedMonth.label} />
        <StatCard label="特殊成本合计" value={formatCurrency(getSpecialCostTotal(selectedMonth))} />
        <StatCard label="耗材开关" value={selectedMonth.includeMaterialCost ? '计入' : '不计入'} />
      </div>

      <div className="mt-5">
        <SegmentTabs<DetailTab>
          value={detailTab}
          items={[
            { value: 'rhythm', label: '节奏' },
            { value: 'coreCost', label: '核心成本' },
            { value: 'specialCost', label: '专项成本' },
            { value: 'notes', label: '备注' },
          ]}
          onChange={setDetailTab}
        />
      </div>

      {detailTab === 'rhythm' ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-2">
            <span className="text-sm font-semibold text-stone-800">月份标签</span>
            <input
              className="h-11 rounded-2xl border border-stone-900/10 bg-stone-100/80 px-4 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
              value={selectedMonth.label}
              onChange={(event) => props.onTextChange(selectedMonth.id, 'label', event.target.value)}
            />
          </div>
          <NumberField
            label="场次"
            value={selectedMonth.events}
            min={0}
            step={1}
            suffix="场"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'events', value)}
          />
          <NumberField
            label="销售系数"
            helper="1.0 表示按成员基准张数原样执行。"
            value={selectedMonth.salesMultiplier}
            min={0}
            step="any"
            suffix="x"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'salesMultiplier', value)}
          />
          <div className="grid gap-2">
            <span className="text-sm font-semibold text-stone-800">耗材是否计入</span>
            <button
              type="button"
              onClick={() => props.onMaterialToggle(selectedMonth.id, !selectedMonth.includeMaterialCost)}
              className={
                selectedMonth.includeMaterialCost
                  ? 'h-11 rounded-2xl border border-emerald-200 bg-emerald-100 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-200'
                  : 'h-11 rounded-2xl border border-stone-900/10 bg-stone-100/80 text-sm font-semibold text-stone-600 transition hover:bg-white'
              }
            >
              {selectedMonth.includeMaterialCost ? '当前计入耗材' : '当前不计耗材'}
            </button>
          </div>
        </div>
      ) : null}

      {detailTab === 'coreCost' ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-2">
            <span className="text-sm font-semibold text-stone-800">排练</span>
            <InlinePairField
              leftLabel="次"
              rightLabel="元"
              leftValue={selectedMonth.rehearsalCount}
              rightValue={selectedMonth.rehearsalCost}
              leftStep={1}
              rightStep={50}
              onLeftChange={(value) => props.onNumberChange(selectedMonth.id, 'rehearsalCount', value)}
              onRightChange={(value) => props.onNumberChange(selectedMonth.id, 'rehearsalCost', value)}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-semibold text-stone-800">老师</span>
            <InlinePairField
              leftLabel="次"
              rightLabel="元"
              leftValue={selectedMonth.teacherCount}
              rightValue={selectedMonth.teacherCost}
              leftStep={1}
              rightStep={50}
              onLeftChange={(value) => props.onNumberChange(selectedMonth.id, 'teacherCount', value)}
              onRightChange={(value) => props.onNumberChange(selectedMonth.id, 'teacherCost', value)}
            />
          </div>
          <NumberField
            label="额外场次成本 / 场"
            value={selectedMonth.extraPerEventCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'extraPerEventCost', value)}
          />
          <NumberField
            label="额外固定成本"
            value={selectedMonth.extraFixedCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'extraFixedCost', value)}
          />
        </div>
      ) : null}

      {detailTab === 'specialCost' ? (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <NumberField
            label="VJ"
            value={selectedMonth.vjCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'vjCost', value)}
          />
          <NumberField
            label="原创制作"
            value={selectedMonth.originalSongCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'originalSongCost', value)}
          />
          <NumberField
            label="化妆"
            value={selectedMonth.makeupCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'makeupCost', value)}
          />
          <NumberField
            label="路费"
            value={selectedMonth.travelCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'travelCost', value)}
          />
          <NumberField
            label="推流"
            value={selectedMonth.streamingCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'streamingCost', value)}
          />
          <NumberField
            label="聚餐"
            value={selectedMonth.mealCost}
            min={0}
            step={100}
            suffix="元"
            onChange={(value) => props.onNumberChange(selectedMonth.id, 'mealCost', value)}
          />
        </div>
      ) : null}

      {detailTab === 'notes' ? (
        <div className="mt-5">
          <TextAreaField
            label="备注"
            helper="记录这个月的特殊情况，例如启动月、上新歌、巡演或休整。"
            value={selectedMonth.notes}
            onChange={(value) => props.onTextChange(selectedMonth.id, 'notes', value)}
          />
        </div>
      ) : null}
    </Panel>
  )
}
