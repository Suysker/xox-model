import { describe, expect, it } from 'vitest'
import {
  actionExecutionObservation,
  actionFailureObservation,
  actionPreviewObservation,
} from '../src/agent/tool-observation-continuation.js'
import type { Row } from '../src/db/schema.js'

function action(overrides: Partial<Row<'agent_action_requests'>> = {}): Row<'agent_action_requests'> {
  return {
    id: 'act_1',
    thread_id: 'thread_1',
    run_id: 'run_1',
    workspace_id: 'workspace_1',
    user_id: 'user_1',
    kind: 'workspace_update',
    status: 'pending',
    title: '更新工作区',
    summary: '调整工作区名称',
    target_label: '工作区',
    risk_level: 'medium',
    details_json: JSON.stringify({ name: 'North plan' }),
    navigation_json: '{}',
    payload_json: '{}',
    created_at: '2026-06-19T08:00:00.000Z',
    executed_at: null,
    error_message: null,
    ...overrides,
  } as Row<'agent_action_requests'>
}

function modelContent(observation: { modelContent: string }): Record<string, unknown> {
  return JSON.parse(observation.modelContent) as Record<string, unknown>
}

describe('xox action observations through Agentic OS envelopes', () => {
  it('keeps xox preview copy and action fields while using the core envelope', () => {
    const observation = actionPreviewObservation({ action: action() })

    expect(observation.displayPreview).toBe('待确认：更新工作区')
    expect(observation.toolName).toBe('workspace_update')
    expect(observation.status).toBe('completed')
    expect(observation.outcome).toBe('pending_human')
    expect(modelContent(observation)).toMatchObject({
      observationType: 'action_preview',
      displayPreview: '待确认：更新工作区',
      actionRequestId: 'act_1',
      actionKind: 'workspace_update',
      title: '更新工作区',
      summary: '调整工作区名称',
      targetLabel: '工作区',
      riskLevel: 'medium',
      executionState: 'pending_confirmation',
      completed: false,
      editable: true,
      status: 'pending',
      changeSet: { name: 'North plan' },
    })
  })

  it('keeps xox execution result summary compact', () => {
    const observation = actionExecutionObservation({
      action: action({ status: 'executed', executed_at: '2026-06-19T09:00:00.000Z' }),
      result: {
        ok: true,
        id: 'version_1',
        ignoredLargePayload: { rows: [1, 2, 3] },
        version: { id: 'version_1', version_no: 3, name: 'Plan V3', kind: 'forecast' },
        share: { url: 'secret-url' },
      },
    })

    expect(observation.displayPreview).toBe('已执行：更新工作区')
    expect(observation.status).toBe('completed')
    expect(observation.outcome).toBe('completed_valid')
    expect(modelContent(observation)).toMatchObject({
      observationType: 'action_result',
      completed: true,
      executionState: 'executed',
      status: 'executed',
      executedAt: '2026-06-19T09:00:00.000Z',
      result: {
        ok: true,
        id: 'version_1',
        version: { id: 'version_1', versionNo: 3, name: 'Plan V3', kind: 'forecast' },
        share: { ok: true },
      },
    })
    expect(modelContent(observation).result).not.toHaveProperty('ignoredLargePayload')
  })

  it('keeps policy-blocked action observations terminal for the loop', () => {
    const observation = actionFailureObservation({
      action: action({ status: 'failed' }),
      reason: 'manual approval required',
    })

    expect(observation.displayPreview).toBe('动作被策略阻止：更新工作区')
    expect(observation.status).toBe('failed')
    expect(observation.outcome).toBe('policy_blocked')
    expect(modelContent(observation)).toMatchObject({
      observationType: 'action_result',
      actionRequestId: 'act_1',
      actionKind: 'workspace_update',
      status: 'failed',
      completed: false,
      reason: 'manual approval required',
      error: null,
    })
  })
})
