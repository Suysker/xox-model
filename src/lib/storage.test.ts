import { createProductDefaultModel } from './defaults'
import { createSnapshot, parseWorkspaceBundle, serializeWorkspaceBundle } from './storage'
import type { WorkspaceBundle } from '../types'

describe('workspace storage bundle', () => {
  it('serializes and parses a valid workspace bundle', () => {
    const bundle: WorkspaceBundle = {
      schemaVersion: 1,
      workspaceName: '测试工作区',
      currentConfig: createProductDefaultModel(),
      snapshots: [createSnapshot(createProductDefaultModel(), '基线版本', 'release')],
      lastSavedAt: '2026-03-08T12:00:00.000Z',
    }

    const raw = serializeWorkspaceBundle(bundle)
    const parsed = parseWorkspaceBundle(raw)

    expect(parsed).not.toBeNull()
    expect(parsed?.workspaceName).toBe(bundle.workspaceName)
    expect(parsed?.snapshots).toHaveLength(1)
    expect(parsed?.currentConfig.months[0]?.label).toBe('3月')
  })

  it('rejects malformed import data', () => {
    const parsed = parseWorkspaceBundle(JSON.stringify({ workspaceName: 'bad data' }))

    expect(parsed).toBeNull()
  })
})
