import { BadgeDollarSign } from 'lucide-react'
import { Panel, SectionTitle, NumberField } from '../common/ui'

export function RevenueWorkbench(props: {
  unitPrice: number
  onUnitPriceChange: (value: number) => void
}) {
  return (
    <Panel>
      <SectionTitle
        icon={BadgeDollarSign}
        eyebrow="Inputs"
        title="收入底盘"
        description="先定单价，再把成员卖张能力和月度收入节奏拼起来。"
      />

      <div className="mt-5 grid gap-4 md:grid-cols-[280px_1fr]">
        <NumberField
          label="单张售价"
          helper="默认按对话里的 88 元，可以按票品或客单价策略调整。"
          value={props.unitPrice}
          step={1}
          min={0}
          suffix="元"
          onChange={props.onUnitPriceChange}
        />

        <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 px-4 py-4 text-sm leading-7 text-stone-600">
          收入分成两部分：
          线下由「成员单场张数 × 场次 × 单张售价」驱动；
          线上 / 电切等额外渠道收入，在下方的月度收入节奏里按月份补入。
        </div>
      </div>
    </Panel>
  )
}
