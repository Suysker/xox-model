import { createProductDefaultModel, createStageCostItem, createStageCostValues } from './defaults'
import { getScenarioResult, projectModel } from './model'

describe('monthly underground-idol investment model', () => {
  it('calculates monthly rows for the base scenario', () => {
    const config = createProductDefaultModel()
    const result = getScenarioResult(config, 'base')

    expect(result.months).toHaveLength(12)

    expect(result.months[0]?.label).toBe('3月')
    expect(result.months[0]?.totalUnitsPerEvent).toBeCloseTo(100.32, 2)
    expect(result.months[0]?.grossSales).toBeCloseTo(52968.96, 2)
    expect(result.months[0]?.employeeEventCost).toBeCloseTo(2400, 2)
    expect(result.months[0]?.members[1]?.basePayCost).toBe(0)
    expect(result.months[0]?.operatingCostTotal).toBeCloseTo(7900, 2)
    expect(result.months[0]?.totalCost).toBeCloseTo(24208.86, 2)
    expect(result.months[0]?.monthlyProfit).toBeCloseTo(28760.1, 1)

    expect(result.months[1]?.label).toBe('4月')
    expect(result.months[1]?.grossSales).toBeCloseTo(105937.92, 2)
    expect(result.months[1]?.monthlyFixedCostTotal).toBeCloseTo(3500, 2)
    expect(result.months[1]?.perEventCostTotal).toBeCloseTo(2400, 2)
    expect(result.months[1]?.monthlyProfit).toBeCloseTo(67420.19, 2)

    expect(result.months[2]?.label).toBe('5月')
    expect(result.months[2]?.unitLinkedCostTotal).toBeCloseTo(7223.04, 2)
    expect(result.months[2]?.monthlyProfit).toBeCloseTo(60197.15, 2)
  })

  it('keeps pessimistic, base and optimistic scenarios ordered', () => {
    const projection = projectModel(createProductDefaultModel())
    const pessimistic = projection.scenarios.find((item) => item.key === 'pessimistic')
    const base = projection.scenarios.find((item) => item.key === 'base')
    const optimistic = projection.scenarios.find((item) => item.key === 'optimistic')

    expect(projection.scenarios).toHaveLength(3)
    expect(pessimistic?.averageUnitsPerEvent).toBeLessThan(base?.averageUnitsPerEvent ?? 0)
    expect(base?.averageUnitsPerEvent).toBeLessThan(optimistic?.averageUnitsPerEvent ?? 0)
    expect(pessimistic?.totalProfit).toBeLessThan(base?.totalProfit ?? 0)
    expect(base?.totalProfit).toBeLessThan(optimistic?.totalProfit ?? 0)
    expect((optimistic?.paybackMonthIndex ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      base?.paybackMonthIndex ?? Number.POSITIVE_INFINITY,
    )
    expect((base?.paybackMonthIndex ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(
      pessimistic?.paybackMonthIndex ?? Number.POSITIVE_INFINITY,
    )
  })

  it('tracks cumulative cash until payback', () => {
    const config = createProductDefaultModel()
    const base = getScenarioResult(config, 'base')

    expect(base.totalInvestment).toBe(95000)
    expect(base.paybackMonthIndex).toBe(2)
    expect(base.paybackMonthLabel).toBe('4月')
    expect(base.months[0]?.cumulativeCash).toBeLessThan(0)
    expect(base.months[1]?.cumulativeCash).toBeGreaterThan(0)
    expect(base.months[2]?.cumulativeCash).toBeGreaterThan(0)
    expect(base.months[11]?.cumulativeCash).toBeCloseTo(base.netCashAfterInvestment, 2)
  })

  it('adds online revenue on top of member-driven offline sales', () => {
    const config = createProductDefaultModel()
    config.operating.onlineUnitPrice = 100
    config.months[0]!.onlineSalesFactor = 0.2

    const base = getScenarioResult(config, 'base')

    expect(base.months[0]?.memberGrossSales).toBeCloseTo(52968.96, 2)
    expect(base.months[0]?.onlineSalesFactor).toBe(0.2)
    expect(base.months[0]?.onlineRevenue).toBeCloseTo(12038.4, 2)
    expect(base.months[0]?.grossSales).toBeCloseTo(65007.36, 2)
    expect(base.months[0]?.monthlyProfit).toBeCloseTo(40798.5, 1)
  })

  it('stops counting a member after the configured departure month', () => {
    const config = createProductDefaultModel()
    config.teamMembers[0]!.departureMonthIndex = 4

    const base = getScenarioResult(config, 'base')
    const june = base.months[3]
    const july = base.months[4]

    expect(june?.members[0]?.monthlyUnits).toBeGreaterThan(0)
    expect(june?.members[0]?.basePayCost).toBe(1500)
    expect(july?.members[0]?.monthlyUnits).toBe(0)
    expect(july?.members[0]?.grossSales).toBe(0)
    expect(july?.members[0]?.basePayCost).toBe(0)
    expect(july?.members[0]?.travelCost).toBe(0)
  })

  it('aggregates configurable cost items by monthly, per-event and per-unit buckets', () => {
    const config = createProductDefaultModel()
    config.operating.monthlyFixedCosts = [
      { id: 'monthly-rent', name: '场地月租', amount: 2400 },
      { id: 'monthly-admin', name: '行政杂费', amount: 600 },
    ]
    config.operating.perEventCosts = [{ id: 'event-makeup', name: '化妆', amount: 200 }]
    config.operating.perUnitCosts = [
      { id: 'unit-film', name: '拍立得相纸', amount: 6 },
      { id: 'unit-bag', name: '耗材袋', amount: 1 },
    ]
    config.timelineTemplate.specialCosts = createStageCostValues(
      config.stageCostItems,
      config.timelineTemplate.specialCosts.map((item) =>
        item.itemId === 'stage-cost-material' ? { ...item, amount: 0, count: 1 } : item,
      ),
    )
    config.months = config.months.map((month) => ({
      ...month,
      specialCosts: createStageCostValues(
        config.stageCostItems,
        month.specialCosts.map((item) =>
          item.itemId === 'stage-cost-material' ? { ...item, amount: 0, count: 1 } : item,
        ),
      ),
    }))

    const base = getScenarioResult(config, 'base')

    expect(base.months[1]?.monthlyOperatingCost).toBe(3000)
    expect(base.months[1]?.perEventOperatingCost).toBe(1200)
    expect(base.months[2]?.unitLinkedCostTotal).toBeCloseTo((base.months[2]?.totalUnitsPerMonth ?? 0) * 7, 2)
  })

  it('supports dynamic stage cost items and per-month counted occurrences', () => {
    const config = createProductDefaultModel()
    const teamBuilding = createStageCostItem('team-building-custom', { name: '团建', mode: 'perEvent' })

    config.stageCostItems = [...config.stageCostItems, teamBuilding]
    config.timelineTemplate.specialCosts = createStageCostValues(
      config.stageCostItems,
      config.timelineTemplate.specialCosts,
    )
    config.months = config.months.map((month) => ({
      ...month,
      events: month.id === config.months[0]?.id ? 4 : month.events,
      specialCosts: createStageCostValues(config.stageCostItems, month.specialCosts),
    }))

    const march = config.months[0]!
    march.specialCosts = createStageCostValues(config.stageCostItems, [
      { itemId: 'stage-cost-makeup', amount: 300, count: 0 },
      { itemId: 'stage-cost-streaming', amount: 200, count: 4 },
      { itemId: 'stage-cost-meal', amount: 150, count: 3 },
      { itemId: teamBuilding.id, amount: 180, count: 1 },
      { itemId: 'stage-cost-material', amount: 0, count: 1 },
    ])

    const base = getScenarioResult(config, 'base')

    expect(base.months[0]?.events).toBe(4)
    expect(base.months[0]?.perEventCostTotal).toBeCloseTo(3030, 2)
    expect(base.months[0]?.specialProjectCost).toBe(0)
  })
})
