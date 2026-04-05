import type { MonthlyPlan } from '../types'
import type { PeriodResponse } from './api'

function padDatePart(value: number) {
  return String(value).padStart(2, '0')
}

function parseMonthNumber(monthLabel: string) {
  const match = monthLabel.match(/^(\d{1,2})月$/)
  if (!match) return null

  const month = Number(match[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return null
  return month
}

function parseInputMonthNumber(dateValue: string) {
  const match = dateValue.match(/^\d{4}-(\d{2})-\d{2}$/)
  if (!match) return null

  const month = Number(match[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return null
  return month
}

export function getTodayInputDate() {
  const now = new Date()
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 10)
}

export function findPeriodIdForSelectedMonth(
  periods: PeriodResponse[],
  months: MonthlyPlan[],
  selectedMonthId: string,
) {
  const fallbackPeriodId = periods[0]?.id ?? ''
  const monthIndex = months.findIndex((month) => month.id === selectedMonthId) + 1
  if (monthIndex <= 0) return fallbackPeriodId
  return periods.find((period) => period.monthIndex === monthIndex)?.id ?? fallbackPeriodId
}

export function findMonthIdForPeriod(periods: PeriodResponse[], months: MonthlyPlan[], periodId: string) {
  const period = periods.find((item) => item.id === periodId)
  if (!period) return months[0]?.id ?? ''
  return months[period.monthIndex - 1]?.id ?? months[0]?.id ?? ''
}

export function findPeriodIdForDateValue(
  periods: PeriodResponse[],
  dateValue: string,
  fallbackPeriodId = '',
) {
  const fallbackResolved = fallbackPeriodId || periods[0]?.id || ''
  const targetMonth = parseInputMonthNumber(dateValue)
  if (targetMonth === null) return fallbackResolved

  const fallbackPeriod = periods.find((period) => period.id === fallbackResolved) ?? null
  if (fallbackPeriod && parseMonthNumber(fallbackPeriod.monthLabel) === targetMonth) {
    return fallbackPeriod.id
  }

  return periods.find((period) => parseMonthNumber(period.monthLabel) === targetMonth)?.id ?? fallbackResolved
}

export function syncInputDateToPeriodMonth(dateValue: string, monthLabel: string, fallbackDate: string) {
  const targetMonth = parseMonthNumber(monthLabel)
  if (targetMonth === null) return dateValue || fallbackDate

  const baseDate = dateValue || fallbackDate
  const [yearText, , dayText] = baseDate.split('-')
  const year = Number(yearText)
  const day = Number(dayText)

  if (!Number.isFinite(year) || !Number.isFinite(day)) {
    return baseDate
  }

  const lastDayOfMonth = new Date(year, targetMonth, 0).getDate()
  const nextDay = Math.min(Math.max(1, day), lastDayOfMonth)
  return `${year}-${padDatePart(targetMonth)}-${padDatePart(nextDay)}`
}

export function syncInputDateForPeriodChange(
  dateValue: string,
  previousPeriodId: string | null,
  nextPeriodId: string | null,
  monthLabel: string,
  fallbackDate: string,
) {
  if (!previousPeriodId || !nextPeriodId || previousPeriodId === nextPeriodId) {
    return dateValue || fallbackDate
  }

  return syncInputDateToPeriodMonth(dateValue, monthLabel, fallbackDate)
}
