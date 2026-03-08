export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  maximumFractionDigits: 0,
})

const decimalFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

const percentFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'percent',
  maximumFractionDigits: 1,
})

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatCurrency(value: number) {
  return currencyFormatter.format(value)
}

export function formatPercent(value: number) {
  return percentFormatter.format(value)
}

export function formatDecimal(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return '-'
  }

  return decimalFormatter.format(value)
}

export function formatCompactNumber(value: number) {
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)

  if (absolute >= 10000) {
    return `${sign}${(absolute / 10000).toFixed(1)}w`
  }

  if (absolute >= 1000) {
    return `${sign}${(absolute / 1000).toFixed(1)}k`
  }

  return `${sign}${Math.round(absolute)}`
}

export function formatDateTime(value: string | null) {
  if (!value) {
    return '未保存'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return '未保存'
  }

  return dateTimeFormatter.format(date)
}

export function formatPaybackMonths(paybackMonthIndex: number | null) {
  if (paybackMonthIndex === null) {
    return '周期内未回本'
  }

  return `${paybackMonthIndex}个月回本`
}
