import type { PeriodResponse } from './api'
import type { MonthlyPlan } from '../types'
import {
  findMonthIdForPeriod,
  findPeriodIdForDateValue,
  findPeriodIdForSelectedMonth,
  syncInputDateForPeriodChange,
  syncInputDateToPeriodMonth,
} from './bookkeeping'

function buildMonth(id: string, label: string): MonthlyPlan {
  return {
    id,
    label,
    events: 0,
    salesMultiplier: 0,
    onlineSalesFactor: 0,
    rehearsalCount: 0,
    rehearsalCost: 0,
    teacherCount: 0,
    teacherCost: 0,
    specialCosts: [],
  }
}

const months: MonthlyPlan[] = [buildMonth('month-1', '3月'), buildMonth('month-2', '4月'), buildMonth('month-3', '5月')]

const periods: PeriodResponse[] = [
  {
    id: 'period-1',
    monthIndex: 1,
    monthLabel: '3月',
    status: 'open',
    baselineVersionId: null,
    baselineVersionName: null,
    plannedRevenue: 0,
    plannedCost: 0,
    actualRevenue: 0,
    actualCost: 0,
  },
  {
    id: 'period-2',
    monthIndex: 2,
    monthLabel: '4月',
    status: 'open',
    baselineVersionId: null,
    baselineVersionName: null,
    plannedRevenue: 0,
    plannedCost: 0,
    actualRevenue: 0,
    actualCost: 0,
  },
  {
    id: 'period-3',
    monthIndex: 3,
    monthLabel: '5月',
    status: 'open',
    baselineVersionId: null,
    baselineVersionName: null,
    plannedRevenue: 0,
    plannedCost: 0,
    actualRevenue: 0,
    actualCost: 0,
  },
]

describe('bookkeeping period helpers', () => {
  it('finds the ledger period that matches the currently selected month', () => {
    expect(findPeriodIdForSelectedMonth(periods, months, 'month-2')).toBe('period-2')
  })

  it('maps a selected ledger period back to the same current month id', () => {
    expect(findMonthIdForPeriod(periods, months, 'period-3')).toBe('month-3')
  })

  it('finds the ledger period that matches the business date month', () => {
    expect(findPeriodIdForDateValue(periods, '2026-04-05', 'period-1')).toBe('period-2')
  })

  it('falls back to the provided ledger period when the business date is invalid', () => {
    expect(findPeriodIdForDateValue(periods, '', 'period-3')).toBe('period-3')
  })

  it('syncs business date month to the selected ledger period month while preserving year and day', () => {
    expect(syncInputDateToPeriodMonth('2026-04-05', '3月', '2026-04-05')).toBe('2026-03-05')
  })

  it('clamps the day when the target month has fewer days', () => {
    expect(syncInputDateToPeriodMonth('2026-03-31', '2月', '2026-03-31')).toBe('2026-02-28')
  })

  it('keeps business date on today when there is no previous period yet', () => {
    expect(syncInputDateForPeriodChange('2026-04-05', null, 'period-1', '3月', '2026-04-05')).toBe('2026-04-05')
  })

  it('syncs business date month only after switching to another period', () => {
    expect(syncInputDateForPeriodChange('2026-04-05', 'period-2', 'period-1', '3月', '2026-04-05')).toBe('2026-03-05')
  })
})
