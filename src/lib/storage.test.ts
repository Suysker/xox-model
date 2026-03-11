import { createProductDefaultModel } from './defaults'
import { createSnapshot, parseWorkspaceBundle, serializeWorkspaceBundle } from './storage'
import type { WorkspaceBundle } from '../types'

describe('workspace storage bundle', () => {
  it('serializes and parses a valid workspace bundle', () => {
    const currentConfig = createProductDefaultModel()
    currentConfig.teamMembers[0]!.departureMonthIndex = 4
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
    expect(parsed?.currentConfig.shareholders).toHaveLength(2)
    expect(parsed?.currentConfig.employees).toHaveLength(2)
    expect(parsed?.currentConfig.stageCostItems).toHaveLength(7)
    expect(parsed?.currentConfig.teamMembers[0]?.departureMonthIndex).toBe(4)
    expect(parsed?.currentConfig.stageCostItems.some((item) => item.id === 'stage-cost-material')).toBe(true)
  })

  it('migrates legacy departure months into cycle-linked month indexes', () => {
    const defaults = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 8,
      workspaceName: '离团月份迁移',
      currentConfig: {
        ...defaults,
        teamMembers: defaults.teamMembers.map((member, index) =>
          index === 0 ? { ...member, departureMonth: 6 } : member,
        ),
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))

    expect(parsed?.schemaVersion).toBe(9)
    expect(parsed?.currentConfig.teamMembers[0]?.departureMonthIndex).toBe(4)
  })

  it('rejects malformed import data', () => {
    const parsed = parseWorkspaceBundle(JSON.stringify({ workspaceName: 'bad data' }))

    expect(parsed).toBeNull()
  })

  it('migrates older bundles that do not contain planning config', () => {
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '旧工作区',
      currentConfig: {
        operating: {
          unitPrice: 88,
          monthlyFixedCost: 1200,
          perEventOperatingCost: 500,
          materialCostPerUnit: 6,
          initialInvestment: 85000,
        },
        teamMembers: createProductDefaultModel().teamMembers.map((member, index) =>
          index < 2 ? { ...member, eventAllowance: 300 } : member,
        ),
        months: createProductDefaultModel().months.map(({ specialCosts: _specialCosts, ...month }) => month),
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))

    expect(parsed).not.toBeNull()
    expect(parsed?.currentConfig.planning.startMonth).toBe(3)
    expect(parsed?.currentConfig.planning.horizonMonths).toBe(12)
    expect(parsed?.currentConfig.timelineTemplate.events).toBeGreaterThan(0)
    expect(parsed?.currentConfig.shareholders[0]?.investmentAmount).toBe(85000)
    expect(parsed?.currentConfig.employees).toHaveLength(2)
    expect(parsed?.currentConfig.employees[0]?.perEventCost).toBe(300)
    expect(parsed?.currentConfig.operating.offlineUnitPrice).toBe(88)
    expect(parsed?.currentConfig.operating.onlineUnitPrice).toBe(88)
    expect(parsed?.currentConfig.operating.monthlyFixedCosts[0]?.amount).toBe(1200)
    expect(parsed?.currentConfig.operating.perEventCosts[0]?.amount).toBe(500)
    expect(parsed?.currentConfig.operating.perUnitCosts[0]?.amount).toBe(6)
  })

  it('migrates legacy extra channel revenue into online units with dual prices', () => {
    const defaults = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '线上收入迁移',
      currentConfig: {
        shareholders: defaults.shareholders,
        operating: {
          unitPrice: 88,
          monthlyFixedCosts: defaults.operating.monthlyFixedCosts,
          perEventCosts: defaults.operating.perEventCosts,
          perUnitCosts: defaults.operating.perUnitCosts,
        },
        teamMembers: defaults.teamMembers,
        employees: defaults.employees,
        stageCostItems: defaults.stageCostItems,
        months: defaults.months.map(({ specialCosts: _specialCosts, onlineSalesFactor: _onlineSalesFactor, ...month }, index) =>
          index === 0
            ? {
                ...month,
                extraChannelRevenue: 8800,
              }
            : month,
        ),
        timelineTemplate: {
          ...(() => {
            const { onlineSalesFactor: _onlineSalesFactor, ...template } = defaults.timelineTemplate
            return template
          })(),
          extraChannelRevenue: 1760,
        },
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))

    expect(parsed?.currentConfig.operating.offlineUnitPrice).toBe(88)
    expect(parsed?.currentConfig.operating.onlineUnitPrice).toBe(88)
    expect(parsed?.currentConfig.timelineTemplate.onlineSalesFactor).toBeCloseTo(20 / (152 * 6 * 1.32), 6)
    expect(parsed?.currentConfig.months[0]?.onlineSalesFactor).toBeCloseTo(100 / (152 * 6 * 0.66), 6)
  })

  it('migrates legacy fixed special-cost fields into dynamic stage cost items and counts', () => {
    const defaults = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '专项迁移',
      currentConfig: {
        shareholders: defaults.shareholders,
        operating: defaults.operating,
        teamMembers: defaults.teamMembers,
        employees: defaults.employees,
        stageCostItems: [
          { id: 'stage-cost-vj', name: 'VJ/月', mode: 'monthly' },
          { id: 'stage-cost-original-song', name: '原创/月', mode: 'monthly' },
          { id: 'stage-cost-makeup', name: '化妆/场', mode: 'perEvent' },
          { id: 'stage-cost-streaming', name: '推流/场', mode: 'perEvent' },
          { id: 'stage-cost-meal', name: '聚餐/场', mode: 'perEvent' },
          { id: 'stage-cost-team-building', name: '团建/场', mode: 'perEvent' },
        ],
        months: defaults.months.map(({ specialCosts: _specialCosts, ...month }, index) =>
          index === 0
            ? {
                ...month,
                events: 4,
                makeupPerEventCost: 300,
                streamingPerEventCost: 200,
                mealPerEventCost: 150,
              }
            : month,
        ),
        timelineTemplate: {
          ...defaults.timelineTemplate,
          vjCost: 1200,
          originalSongCost: 0,
          makeupPerEventCost: 300,
          streamingPerEventCost: 0,
          mealPerEventCost: 100,
        },
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))
    const march = parsed?.currentConfig.months[0]
    const template = parsed?.currentConfig.timelineTemplate

    expect(parsed).not.toBeNull()
    expect(parsed?.currentConfig.stageCostItems.some((item) => item.name === '化妆')).toBe(true)
    expect(parsed?.currentConfig.stageCostItems.some((item) => item.name === '团建')).toBe(true)
    expect(parsed?.currentConfig.stageCostItems.some((item) => item.name === '耗材')).toBe(true)
    expect(march?.specialCosts.find((item) => item.itemId === 'stage-cost-makeup')).toEqual({
      itemId: 'stage-cost-makeup',
      amount: 300,
      count: 4,
    })
    expect(march?.specialCosts.find((item) => item.itemId === 'stage-cost-streaming')).toEqual({
      itemId: 'stage-cost-streaming',
      amount: 200,
      count: 4,
    })
    expect(march?.specialCosts.find((item) => item.itemId === 'stage-cost-meal')).toEqual({
      itemId: 'stage-cost-meal',
      amount: 150,
      count: 4,
    })
    expect(template?.specialCosts.find((item) => item.itemId === 'stage-cost-vj')).toEqual({
      itemId: 'stage-cost-vj',
      amount: 1200,
      count: 1,
    })
  })

  it('migrates legacy material include flags into per-unit stage costs', () => {
    const defaults = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '耗材迁移',
      currentConfig: {
        shareholders: defaults.shareholders,
        operating: {
          ...defaults.operating,
          perUnitCosts: [{ id: 'cost-material-polaroid', name: '拍立得相纸', amount: 6 }],
        },
        teamMembers: defaults.teamMembers,
        employees: defaults.employees,
        stageCostItems: defaults.stageCostItems
          .filter((item) => item.id !== 'stage-cost-material')
          .map((item) => ({
            ...item,
            name:
              item.mode === 'monthly'
                ? `${item.name}/月`
                : item.mode === 'perEvent'
                  ? `${item.name}/场`
                  : `${item.name}/张`,
          })),
        months: defaults.months.map(({ specialCosts: _specialCosts, ...month }, index) =>
          index === 0
            ? {
                ...month,
                includeMaterialCost: false,
              }
            : {
                ...month,
                includeMaterialCost: true,
              },
        ),
        timelineTemplate: {
          ...defaults.timelineTemplate,
          includeMaterialCost: true,
        },
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))
    const templateMaterial = parsed?.currentConfig.timelineTemplate.specialCosts.find(
      (item) => item.itemId === 'stage-cost-material',
    )
    const marchMaterial = parsed?.currentConfig.months[0]?.specialCosts.find(
      (item) => item.itemId === 'stage-cost-material',
    )
    const aprilMaterial = parsed?.currentConfig.months[1]?.specialCosts.find(
      (item) => item.itemId === 'stage-cost-material',
    )

    expect(templateMaterial?.amount).toBe(6)
    expect(marchMaterial?.amount).toBe(0)
    expect(aprilMaterial?.amount).toBe(6)
    expect(parsed?.currentConfig.operating.perUnitCosts).toHaveLength(0)
    expect(parsed?.currentConfig.stageCostItems.find((item) => item.id === 'stage-cost-material')?.mode).toBe(
      'perUnit',
    )
    expect(parsed?.currentConfig.stageCostItems.find((item) => item.id === 'stage-cost-streaming')?.name).toBe(
      '推流',
    )
  })

  it('migrates legacy extra event and fixed fields into dynamic stage-cost columns', () => {
    const defaults = createProductDefaultModel()
    const legacyBundle = {
      schemaVersion: 1,
      workspaceName: '额外成本迁移',
      currentConfig: {
        shareholders: defaults.shareholders,
        operating: defaults.operating,
        teamMembers: defaults.teamMembers,
        employees: defaults.employees,
        stageCostItems: defaults.stageCostItems,
        months: defaults.months.map(({ specialCosts: _specialCosts, ...month }, index) =>
          index === 0
            ? {
                ...month,
                events: 4,
                extraPerEventCost: 180,
                extraFixedCost: 900,
              }
            : month,
        ),
        timelineTemplate: {
          ...defaults.timelineTemplate,
          extraPerEventCost: 120,
          extraFixedCost: 600,
        },
      },
      snapshots: [],
      lastSavedAt: null,
    }

    const parsed = parseWorkspaceBundle(JSON.stringify(legacyBundle))
    const march = parsed?.currentConfig.months[0]
    const template = parsed?.currentConfig.timelineTemplate

    expect(parsed?.currentConfig.stageCostItems.some((item) => item.id === 'stage-cost-legacy-other-event')).toBe(
      true,
    )
    expect(parsed?.currentConfig.stageCostItems.some((item) => item.id === 'stage-cost-legacy-other-monthly')).toBe(
      true,
    )
    expect(template?.specialCosts.find((item) => item.itemId === 'stage-cost-legacy-other-event')).toEqual({
      itemId: 'stage-cost-legacy-other-event',
      amount: 120,
      count: 6,
    })
    expect(template?.specialCosts.find((item) => item.itemId === 'stage-cost-legacy-other-monthly')).toEqual({
      itemId: 'stage-cost-legacy-other-monthly',
      amount: 600,
      count: 1,
    })
    expect(march?.specialCosts.find((item) => item.itemId === 'stage-cost-legacy-other-event')).toEqual({
      itemId: 'stage-cost-legacy-other-event',
      amount: 180,
      count: 4,
    })
    expect(march?.specialCosts.find((item) => item.itemId === 'stage-cost-legacy-other-monthly')).toEqual({
      itemId: 'stage-cost-legacy-other-monthly',
      amount: 900,
      count: 1,
    })
  })
})
