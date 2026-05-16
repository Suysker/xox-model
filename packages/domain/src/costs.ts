import type { StageCostItem, StageCostValue } from './types.js'

export function clampToNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function sumCostItems(items: Array<{ amount: number }>) {
  return items.reduce((sum, item) => sum + clampToNonNegative(item.amount), 0)
}

export function getStageCostValue(values: StageCostValue[], itemId: string) {
  return values.find((value) => value.itemId === itemId)
}

export function getStageCostTotals(items: StageCostItem[], values: StageCostValue[]) {
  return items.reduce(
    (summary, item) => {
      const value = getStageCostValue(values, item.id)
      const amount = clampToNonNegative(value?.amount ?? 0)
      const count = clampToNonNegative(value?.count ?? 0)

      if (item.mode === 'monthly') {
        summary.monthly += amount
      } else if (item.mode === 'perEvent') {
        summary.perEventLike += amount * count
      } else {
        summary.perUnitLike += amount
      }

      return summary
    },
    { monthly: 0, perEventLike: 0, perUnitLike: 0 },
  )
}
