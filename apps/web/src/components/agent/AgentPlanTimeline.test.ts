import type { AgentActionRequest, AgentNavigationEvent, AgentPlanStep } from '../../lib/api'
import { buildAgentTimelineRows, formatAgentNavigationTarget, formatAgentTimelineStatus, summarizeAgentTimeline } from './AgentPlanTimeline'

function buildNavigation(overrides: Partial<AgentNavigationEvent> = {}): AgentNavigationEvent {
  return {
    type: 'navigation',
    route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: 'period-1' },
    panel: null,
    focusRecordId: null,
    reason: '打开记账工作台',
    ...overrides,
  }
}

function buildAction(overrides: Partial<AgentActionRequest> = {}): AgentActionRequest {
  return {
    id: 'action-1',
    threadId: 'thread-1',
    runId: 'run-1',
    kind: 'ledger.create_entry',
    status: 'pending',
    title: '确认记账',
    summary: '成员 A 收入入账',
    targetLabel: '3 月账期',
    riskLevel: 'medium',
    details: [{ label: '金额', value: '176' }],
    navigation: buildNavigation(),
    payload: { amount: 176 },
    createdAt: '2026-05-17T00:00:00.000Z',
    executedAt: null,
    errorMessage: null,
    ...overrides,
  }
}

function buildStep(overrides: Partial<AgentPlanStep> = {}): AgentPlanStep {
  return {
    id: 'step-1',
    threadId: 'thread-1',
    runId: 'run-1',
    actionRequestId: 'action-1',
    sequence: 1,
    title: '记 3 月收入',
    description: '生成确认卡后等待用户确认',
    status: 'ready',
    navigation: null,
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
    ...overrides,
  }
}

describe('AgentPlanTimeline presentation helpers', () => {
  it('formats navigation targets with route, panel, and focused record', () => {
    const label = formatAgentNavigationTarget(
      buildNavigation({
        route: { mainTab: 'dashboard', secondaryTab: 'overview' },
        panel: 'workspace',
        focusRecordId: 'version-1',
      }),
    )

    expect(label).toBe('看测算 / 总览 / 版本管理 / 定位记录')
  })

  it('joins plan steps with action state without inventing a second status source', () => {
    const rows = buildAgentTimelineRows(
      [
        buildStep(),
        buildStep({
          id: 'step-2',
          actionRequestId: null,
          sequence: 2,
          title: '查看偏差',
          description: '打开预实分析',
          status: 'executed',
          navigation: buildNavigation({ route: { mainTab: 'variance', secondaryTab: 'analysis' }, reason: '打开偏差页' }),
        }),
      ],
      [buildAction({ status: 'failed', errorMessage: '当前期间已锁定，不能修改。' })],
    )

    expect(rows[0]).toMatchObject({
      sequence: 1,
      actionLabel: '记账',
      actionStatus: 'failed',
      riskLabel: '中风险',
      errorMessage: '当前期间已锁定，不能修改。',
      navigationLabel: '记实际 / 账本',
    })
    expect(rows[1]).toMatchObject({
      sequence: 2,
      actionLabel: null,
      actionStatus: null,
      navigationLabel: '看偏差 / 偏差',
    })
  })

  it('summarizes executed, cancelled, failed, and pending confirmation counts', () => {
    const rows = buildAgentTimelineRows(
      [
        buildStep({ id: 'step-1', actionRequestId: 'action-1', status: 'ready' }),
        buildStep({ id: 'step-2', actionRequestId: 'action-2', sequence: 2, status: 'cancelled' }),
        buildStep({ id: 'step-3', actionRequestId: null, sequence: 3, status: 'executed' }),
      ],
      [
        buildAction({ id: 'action-1', status: 'pending' }),
        buildAction({ id: 'action-2', status: 'cancelled' }),
      ],
    )

    expect(summarizeAgentTimeline(rows, [buildAction({ id: 'action-1', status: 'pending' })])).toEqual({
      total: 3,
      ready: 1,
      executed: 1,
      cancelled: 1,
      failed: 0,
      pendingActions: 1,
    })
  })

  it('labels pending action requests as confirmation work, not planning work', () => {
    const [row] = buildAgentTimelineRows([buildStep({ status: 'ready' })], [buildAction({ status: 'pending' })])

    expect(row).toBeDefined()
    expect(formatAgentTimelineStatus(row!)).toBe('待确认')
    expect(formatAgentTimelineStatus({ status: 'pending', actionStatus: null })).toBe('规划中')
  })
})
