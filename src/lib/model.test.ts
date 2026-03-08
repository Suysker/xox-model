import { createProductDefaultModel } from './defaults'
import { getScenarioResult, projectModel } from './model'

describe('monthly underground-idol investment model', () => {
  it('calculates monthly rows for the base scenario', () => {
    const config = createProductDefaultModel()
    const result = getScenarioResult(config, 'base')

    expect(result.months).toHaveLength(6)

    expect(result.months[0]?.label).toBe('3月')
    expect(result.months[0]?.totalUnitsPerEvent).toBeCloseTo(100.32, 2)
    expect(result.months[0]?.grossSales).toBeCloseTo(52968.96, 2)
    expect(result.months[0]?.employeeEventCost).toBeCloseTo(3600, 2)
    expect(result.months[0]?.members[1]?.basePayCost).toBe(0)
    expect(result.months[0]?.operatingCostTotal).toBeCloseTo(9100, 2)
    expect(result.months[0]?.totalCost).toBeCloseTo(25408.86, 2)
    expect(result.months[0]?.monthlyProfit).toBeCloseTo(27560.1, 1)

    expect(result.months[1]?.label).toBe('4月')
    expect(result.months[1]?.grossSales).toBeCloseTo(80256, 2)
    expect(result.months[1]?.fixedCostTotal).toBeCloseTo(3500, 2)
    expect(result.months[1]?.eventLinkedCostTotal).toBeCloseTo(3600, 2)
    expect(result.months[1]?.monthlyProfit).toBeCloseTo(48445.6, 2)

    expect(result.months[2]?.label).toBe('5月')
    expect(result.months[2]?.unitLinkedCostTotal).toBeCloseTo(7113.6, 2)
    expect(result.months[2]?.monthlyProfit).toBeCloseTo(57995.68, 2)
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

    expect(base.paybackMonthIndex).toBe(3)
    expect(base.paybackMonthLabel).toBe('5月')
    expect(base.months[0]?.cumulativeCash).toBeLessThan(0)
    expect(base.months[1]?.cumulativeCash).toBeLessThan(0)
    expect(base.months[2]?.cumulativeCash).toBeGreaterThan(0)
    expect(base.months[5]?.cumulativeCash).toBeCloseTo(base.netCashAfterInvestment, 2)
  })
})
