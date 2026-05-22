import type { AgentNavigationEvent } from '../../lib/api'
import { formatAgentNavigationTarget } from './agentNavigation'

function navigation(overrides: Partial<AgentNavigationEvent> = {}): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'dashboard', secondaryTab: 'overview' },
    panel: null,
    focusRecordId: null,
    reason: '打开页面',
    ...overrides,
  }
}

describe('agentNavigation', () => {
  it('formats route, panel, and focused record labels', () => {
    expect(formatAgentNavigationTarget(navigation({
      panel: 'workspace',
      focusRecordId: 'version-1',
    }))).toBe('看测算 / 总览 / 版本管理 / 定位记录')
  })
})
