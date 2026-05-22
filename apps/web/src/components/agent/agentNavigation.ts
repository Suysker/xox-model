import type { AgentNavigationEvent } from '../../lib/api'

const mainTabLabels: Record<AgentNavigationEvent['route']['mainTab'], string> = {
  dashboard: '看测算',
  inputs: '调模型',
  bookkeeping: '记实际',
  variance: '看偏差',
}

const secondaryTabLabels: Record<string, string> = {
  overview: '总览',
  months: '月份',
  members: '成员',
  capital: '资金',
  revenue: '收入',
  cost: '成本',
  entries: '账本',
  analysis: '偏差',
}

const panelLabels: Record<string, string> = {
  workspace: '版本管理',
}

export function formatAgentNavigationTarget(event: AgentNavigationEvent | null | undefined) {
  if (!event) return null
  const routeLabel = mainTabLabels[event.route.mainTab]
  const secondary = event.route.secondaryTab ? secondaryTabLabels[event.route.secondaryTab] ?? event.route.secondaryTab : null
  const panel = event.panel ? panelLabels[event.panel] ?? event.panel : null
  const focus = event.focusRecordId ? '定位记录' : null
  return [routeLabel, secondary, panel, focus].filter(Boolean).join(' / ')
}
