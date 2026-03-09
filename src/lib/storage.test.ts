import { createProductDefaultModel } from './defaults'
import { createSnapshot, parseWorkspaceBundle, serializeWorkspaceBundle } from './storage'
import type { WorkspaceBundle } from '../types'

describe('workspace storage bundle', () => {
  it('serializes and parses a valid workspace bundle', () => {
    const currentConfig = createProductDefaultModel()
    const bundle: WorkspaceBundle = {
      schemaVersion: 1,
      workspaceName: '测试工作区',
      currentConfig,
      snapshots: [createSnapshot(currentConfig, '基线版本', 'release')],
      lastSavedAt: '2026-03-08T12:00:00.000Z',
    }

    const raw = serializeWorkspaceBundle(bundle)
    const parsed = parseWorkspaceBundle(raw)

    expect(parsed).not.toBeNull()
    expect(parsed?.workspaceName).toBe(bundle.workspaceName)
    expect(parsed?.snapshots).toHaveLength(1)
    expect(parsed?.currentConfig.months[0]?.label).toBe('3月')
    expect(parsed?.currentConfig.shareholders).toHaveLength(3)
    expect(parsed?.currentConfig.employees).toHaveLength(2)
  })

  it('rejects malformed import data', () => {
    const parsed = parseWorkspaceBundle(JSON.stringify({ workspaceName: 'bad data' }))

    expect(parsed).toBeNull()
  })

  it('migrates older bundles that do not contain planning config', () => {
    const legacyDefault = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '旧工作区',
      currentConfig: {
        operating: {
          ...legacyDefault.operating,
          initialInvestment: 85000,
        },
        teamMembers: legacyDefault.teamMembers.map((member, index) =>
          index < 2 ? { ...member, eventAllowance: 300 } : member,
        ),
        months: legacyDefault.months,
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))

    expect(parsed).not.toBeNull()
    expect(parsed?.currentConfig.planning.startMonth).toBe(3)
    expect(parsed?.currentConfig.planning.horizonMonths).toBe(6)
    expect(parsed?.currentConfig.timelineTemplate.events).toBeGreaterThan(0)
    expect(parsed?.currentConfig.shareholders[0]?.investmentAmount).toBe(85000)
    expect(parsed?.currentConfig.employees).toHaveLength(2)
    expect(parsed?.currentConfig.employees[0]?.perEventCost).toBe(300)
  })
})
