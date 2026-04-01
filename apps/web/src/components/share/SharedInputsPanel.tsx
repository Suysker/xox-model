import { CalendarRange, Coins, Settings2, Users2 } from 'lucide-react'
import { BodyCell, HeaderCell, Panel, SectionTitle, StatCard } from '../common/ui'
import { formatCurrency, formatDecimal, formatPercent } from '../../lib/format'
import { getScenarioLabel } from '../../lib/scenarios'
import type { ModelConfig, ScenarioKey, ScenarioResult } from '../../types'

export function SharedInputsPanel(props: {
  config: ModelConfig
  selectedScenario: ScenarioKey
  selectedScenarioResult: ScenarioResult
}) {
  const totalInvestment = props.config.shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)
  const totalMonthlyFixed = props.config.operating.monthlyFixedCosts.reduce((sum, item) => sum + item.amount, 0)
  const totalPerEvent = props.config.operating.perEventCosts.reduce((sum, item) => sum + item.amount, 0)
  const totalPerUnit = props.config.operating.perUnitCosts.reduce((sum, item) => sum + item.amount, 0)

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
        <Panel>
          <SectionTitle
            icon={Settings2}
            eyebrow="模型输入"
            title={`核心经营假设 · ${getScenarioLabel(props.selectedScenario, props.selectedScenarioResult.label)}`}
          />

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="启动月份" value={`${props.config.planning.startMonth}月`} />
            <StatCard label="规划周期" value={`${props.config.planning.horizonMonths}个月`} />
            <StatCard label="线下单价" value={formatCurrency(props.config.operating.offlineUnitPrice)} />
            <StatCard label="线上单价" value={formatCurrency(props.config.operating.onlineUnitPrice)} />
            <StatCard label="拍立得损耗率" value={formatPercent(props.config.operating.polaroidLossRate)} />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-3">
            <StatCard label="总投资" value={formatCurrency(totalInvestment)} />
            <StatCard label="场次总数" value={`${props.selectedScenarioResult.totalEvents}`} />
            <StatCard label="投资回报率" value={formatPercent(props.selectedScenarioResult.roi)} />
          </div>
        </Panel>

        <Panel>
          <SectionTitle icon={Coins} eyebrow="资金结构" title="股东与分红" />

          <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead className="bg-stone-100/90 text-stone-700">
                <tr className="border-b border-stone-900/10">
                  <HeaderCell align="left">股东</HeaderCell>
                  <HeaderCell align="right">投资额</HeaderCell>
                  <HeaderCell align="right">分红占比</HeaderCell>
                </tr>
              </thead>
              <tbody>
                {props.config.shareholders.map((shareholder) => (
                  <tr key={shareholder.id} className="border-b border-stone-900/10 last:border-none">
                    <BodyCell align="left" className="font-semibold text-stone-950">
                      {shareholder.name}
                    </BodyCell>
                    <BodyCell align="right">{formatCurrency(shareholder.investmentAmount)}</BodyCell>
                    <BodyCell align="right">{formatPercent(shareholder.dividendRate)}</BodyCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <Panel>
          <SectionTitle icon={Users2} eyebrow="人力配置" title="成员与员工" />

          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-stone-950">成员</h3>
                <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
                  {props.config.teamMembers.length} 人
                </span>
              </div>

              <div className="mt-4 grid gap-2">
                {props.config.teamMembers.map((member) => (
                  <div key={member.id} className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-stone-950">{member.name}</p>
                      <span
                        className={
                          member.employmentType === 'salary'
                            ? 'rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700'
                            : 'rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700'
                        }
                      >
                        {member.employmentType === 'salary' ? '底薪' : '兼职'}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-stone-600 md:grid-cols-3">
                      <span>底薪 {formatCurrency(member.monthlyBasePay)}</span>
                      <span>提成 {formatPercent(member.commissionRate)}</span>
                      <span>每场 {formatDecimal(member.unitsPerEvent[props.selectedScenario])} 张</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[24px] border border-stone-900/10 bg-stone-50/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-stone-950">员工</h3>
                <span className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-600">
                  {props.config.employees.length} 人
                </span>
              </div>

              <div className="mt-4 grid gap-2">
                {props.config.employees.map((employee) => (
                  <div key={employee.id} className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-stone-950">{employee.name}</p>
                      <span className="rounded-full border border-stone-900/10 bg-stone-50 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                        {employee.role}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-stone-600 md:grid-cols-2">
                      <span>月薪 {formatCurrency(employee.monthlyBasePay)}</span>
                      <span>场次 {formatCurrency(employee.perEventCost)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </Panel>

        <Panel>
          <SectionTitle icon={Coins} eyebrow="成本结构" title="经营成本口径" />

          <div className="mt-5 grid gap-3">
            <StatCard label="每月固定成本" value={formatCurrency(totalMonthlyFixed)} />
            <StatCard label="每场成本" value={formatCurrency(totalPerEvent)} />
            <StatCard label="每张成本" value={formatCurrency(totalPerUnit)} />
          </div>

          <div className="mt-5 grid gap-4">
            <CostListBlock title="每月固定" items={props.config.operating.monthlyFixedCosts.map((item) => `${item.name} ${formatCurrency(item.amount)}`)} />
            <CostListBlock title="每场" items={props.config.operating.perEventCosts.map((item) => `${item.name} ${formatCurrency(item.amount)}`)} />
            <CostListBlock title="每张" items={props.config.operating.perUnitCosts.map((item) => `${item.name} ${formatCurrency(item.amount)}`)} />
            <CostListBlock
              title="专项项目"
              items={props.config.stageCostItems.map((item) => `${item.name} · ${stageModeLabel(item.mode)}`)}
            />
          </div>
        </Panel>
      </div>

      <Panel>
        <SectionTitle
          icon={CalendarRange}
          eyebrow="排期"
          title="月度经营输入"
        />

        <div className="mt-5 overflow-hidden rounded-[24px] border border-stone-900/10">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead className="bg-stone-100/90 text-stone-700">
              <tr className="border-b border-stone-900/10">
                <HeaderCell align="left">月份</HeaderCell>
                <HeaderCell align="right">场次</HeaderCell>
                <HeaderCell align="right">销量系数</HeaderCell>
                <HeaderCell align="right">线上系数</HeaderCell>
                <HeaderCell align="right">排练</HeaderCell>
                <HeaderCell align="right">老师</HeaderCell>
                <HeaderCell align="left">专项</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {props.config.months.map((month) => (
                <tr key={month.id} className="border-b border-stone-900/10 last:border-none">
                  <BodyCell align="left" className="font-semibold text-stone-950">
                    {month.label}
                  </BodyCell>
                  <BodyCell align="right">{month.events}</BodyCell>
                  <BodyCell align="right">{formatDecimal(month.salesMultiplier)}x</BodyCell>
                  <BodyCell align="right">{formatDecimal(month.onlineSalesFactor)}x</BodyCell>
                  <BodyCell align="right">
                    {month.rehearsalCount} 次 / {formatCurrency(month.rehearsalCost)}
                  </BodyCell>
                  <BodyCell align="right">
                    {month.teacherCount} 次 / {formatCurrency(month.teacherCost)}
                  </BodyCell>
                  <BodyCell align="left">{formatSpecialCosts(month.specialCosts, props.config.stageCostItems)}</BodyCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  )
}

function CostListBlock(props: {
  title: string
  items: string[]
}) {
  return (
    <section className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-stone-950">{props.title}</h3>
        <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-500">
          {props.items.length} 项
        </span>
      </div>
      {props.items.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {props.items.map((item) => (
            <span key={item} className="rounded-full border border-stone-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700">
              {item}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-stone-500">未配置</p>
      )}
    </section>
  )
}

function formatSpecialCosts(
  values: ModelConfig['months'][number]['specialCosts'],
  items: ModelConfig['stageCostItems'],
) {
  const itemMap = new Map(items.map((item) => [item.id, item]))

  const labels = values
    .filter((value) => value.amount > 0)
    .map((value) => {
      const item = itemMap.get(value.itemId)
      if (!item) {
        return null
      }

      const suffix = item.mode === 'perEvent' ? ` × ${formatDecimal(value.count)}` : ''
      return `${item.name} ${formatCurrency(value.amount)}${suffix}`
    })
    .filter((label): label is string => Boolean(label))

  return labels.length > 0 ? labels.join(' / ') : '无'
}

function stageModeLabel(mode: ModelConfig['stageCostItems'][number]['mode']) {
  if (mode === 'monthly') {
    return '按月'
  }

  if (mode === 'perEvent') {
    return '按场'
  }

  return '按张'
}
