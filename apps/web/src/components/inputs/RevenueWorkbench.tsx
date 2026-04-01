import { BadgeDollarSign } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'

export function RevenueWorkbench(props: {
  offlineUnitPrice: number
  onlineUnitPrice: number
  polaroidLossRate: number
  onOfflineUnitPriceChange: (value: number) => void
  onOnlineUnitPriceChange: (value: number) => void
  onPolaroidLossRateChange: (value: number) => void
}) {
  return (
    <Panel>
      <SectionTitle
        icon={BadgeDollarSign}
        eyebrow="输入"
        title="收入底盘"
      />

      <div className="mt-5 grid gap-4 xl:grid-cols-12 xl:items-stretch">
        <div className="grid gap-4 xl:col-span-8 xl:grid-cols-3">
          <ValueField
            label="线下单价"
            helper="线下收入按线下张数乘以线下单价计算。"
            value={props.offlineUnitPrice}
            onChange={props.onOfflineUnitPriceChange}
            min={0}
            step={1}
            suffix="元"
          />

          <ValueField
            label="线上单价"
            helper="线上收入按线下张数乘以线上系数后，再乘线上单价计算。"
            value={props.onlineUnitPrice}
            onChange={props.onOnlineUnitPriceChange}
            min={0}
            step={1}
            suffix="元"
          />

          <ValueField
            label="拍立得损耗率"
            helper="只放大按张成本，例如 10% 表示每卖 100 张按 110 张耗材计。"
            value={props.polaroidLossRate * 100}
            onChange={props.onPolaroidLossRateChange}
            min={0}
            step={0.1}
            suffix="%"
          />
        </div>

        <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 px-4 py-4 text-sm leading-7 text-stone-600 xl:col-span-4">
          线下看单价，线上看系数，拍立得损耗率只影响按张成本，不改变收入张数。
        </div>
      </div>
    </Panel>
  )
}

function ValueField(props: {
  label: string
  helper: string
  value: number
  onChange: (value: number) => void
  min: number
  step: number | 'any'
  suffix: string
}) {
  return (
    <label className="grid h-full gap-2">
      <div className="flex min-h-[72px] flex-col justify-between gap-1">
        <span className="text-sm font-semibold text-stone-800">{props.label}</span>
        <p className="text-xs leading-5 text-stone-500">{props.helper}</p>
      </div>
      <div className="flex h-11 items-center overflow-hidden rounded-2xl border border-stone-900/10 bg-stone-100/80 focus-within:border-emerald-500 focus-within:bg-white">
        <input
          className="h-full flex-1 border-none bg-transparent px-4 text-sm font-medium tabular-nums text-stone-900 outline-none"
          type="number"
          value={Number.isFinite(props.value) ? props.value : 0}
          min={props.min}
          step={props.step}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        <span className="pr-4 text-xs font-semibold tracking-[0.18em] text-stone-500">{props.suffix}</span>
      </div>
    </label>
  )
}
