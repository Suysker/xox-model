import type { ScenarioKey } from '../types'

const scenarioMeta: Record<
  ScenarioKey,
  {
    label: string
    description: string
  }
> = {
  pessimistic: {
    label: '悲观',
    description: '按更保守的销量与排期预估，查看现金流下界。',
  },
  base: {
    label: '基准',
    description: '按当前最可能发生的经营方案，作为主要判断口径。',
  },
  optimistic: {
    label: '乐观',
    description: '按更好的销量与排期表现，查看经营上界。',
  },
}

export function getScenarioLabel(key: ScenarioKey, fallback?: string) {
  return scenarioMeta[key]?.label ?? fallback ?? key
}

export function getScenarioDescription(key: ScenarioKey, fallback?: string) {
  return scenarioMeta[key]?.description ?? fallback ?? ''
}
