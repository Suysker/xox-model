import { describe, expect, it } from 'vitest'
import { AGENT_TOOL_REGISTRY } from '../src/agent/tool-catalog.js'
import { buildToolContextPack } from '../src/agent/tool-surface-manifest.js'
import { buildRuntimeToolCatalogProjection } from '../src/agent/tool-catalog.js'

describe('Progressive Tool Discovery Runtime', () => {
  it('materializes a small fact-first pack for simple payback questions', () => {
    const pack = buildToolContextPack({
      registry: AGENT_TOOL_REGISTRY,
      selectedCapabilities: ['data'],
      message: '我们几个月才能回本？',
    })

    expect(pack.strategy).toBe('progressive_tool_discovery')
    expect(pack.toolNames).toContain('data_query_workspace')
    expect(pack.toolNames).toContain('rg')
    expect(pack.toolNames.length).toBeLessThanOrEqual(6)
    expect(pack.toolNames).not.toContain('workspace_patch_config')
    expect(pack.toolDescriptors.find((descriptor) => descriptor.name === 'data_query_workspace')).toMatchObject({
      title: '查询工作区数据',
    })
  })

  it('discovers the same payback data tool for English wording', () => {
    const pack = buildToolContextPack({
      registry: AGENT_TOOL_REGISTRY,
      selectedCapabilities: ['data'],
      message: 'How many months until payback?',
    })

    expect(pack.strategy).toBe('progressive_tool_discovery')
    expect(pack.toolNames).toContain('data_query_workspace')
    expect(pack.toolNames).toContain('rg')
    expect(pack.toolNames.length).toBeLessThanOrEqual(6)
  })

  it('fuses capability disclosure and retrieval for cross-domain SaaS goals', () => {
    const pack = buildToolContextPack({
      registry: AGENT_TOOL_REGISTRY,
      selectedCapabilities: ['data', 'ledger', 'draft'],
      message: '我们几个月才能回本？帮我记一笔成员A的今天的线上10张，然后帮我第一个股东注资100w',
    })

    expect(pack.toolNames.length).toBeLessThanOrEqual(10)
    expect(pack.toolNames).toEqual(expect.arrayContaining([
      'data_query_workspace',
      'ledger_create_member_income',
      'workspace_patch_config',
    ]))
    expect(pack.toolNames.indexOf('data_query_workspace')).toBeLessThan(pack.toolNames.indexOf('ledger_create_member_income'))
    expect(pack.toolNames).not.toContain('workspace_publish_release')
    expect(pack.toolNames).not.toContain('share_create')
    expect(pack.discoveryTrace.materializedToolNames).toEqual(pack.toolNames)
    expect(pack.discoveryTrace.rankedCandidates.length).toBeGreaterThan(0)
  })

  it('reserves fact-prerequisite tools even when draft tools fill the pack', () => {
    const pack = buildToolContextPack({
      registry: AGENT_TOOL_REGISTRY,
      selectedCapabilities: ['draft'],
      message: '给我预测一下，如果目前的通胀率是5%，我的投资回报率是多少？我是第一个股东，我投入的钱都是银行贷款出来的，银行利率是年利率5%',
      routerReason: '用户在做假设性参数试算，询问投资回报率预测。',
    })

    expect(pack.toolNames).toContain('data_query_workspace')
    expect(pack.toolNames).toContain('workspace_patch_config')
    expect(pack.toolNames).toContain('rg')
    expect(pack.toolNames.length).toBeLessThanOrEqual(8)
    expect(pack.discoveryTrace.materializedToolNames).toEqual(pack.toolNames)
  })

  it('keeps full schemas out of descriptors while preserving real provider tools', () => {
    const pack = buildToolContextPack({
      registry: AGENT_TOOL_REGISTRY,
      selectedCapabilities: ['ledger'],
      message: '把 5 月成员 1 线上 10 张入账',
    })
    const descriptor = pack.toolDescriptors.find((item) => item.name === 'ledger_create_member_income')
    const providerTool = pack.tools.find((tool) => tool.function.name === 'ledger_create_member_income')

    expect(descriptor?.parameterNames).toContain('memberName')
    expect(JSON.stringify(descriptor)).not.toContain('additionalProperties')
    expect(providerTool?.function.parameters.properties).toHaveProperty('memberName')
  })

  it('routes gateway model-selected capabilities through progressive discovery', () => {
    const projection = buildRuntimeToolCatalogProjection({
      selectedCapabilities: ['ledger'],
      message: '把 3 月成员 A 线下 1 张入账',
    })

    expect(projection.strategy).toBe('progressive_tool_discovery')
    expect(projection.inventorySnapshot.source).toBe('progressive_tool_discovery')
    expect(projection.toolNames).toContain('ledger_create_member_income')
    expect(projection.toolNames).toContain('data_query_workspace')
    expect(projection.toolNames).not.toContain('workspace_publish_release')
    expect(projection.discoveryTrace?.strategy).toBe('progressive_tool_discovery')
  })

  it('uses local retrieval for a small fast-first pack when capability hints are empty', () => {
    const projection = buildRuntimeToolCatalogProjection({
      selectedCapabilities: [],
      routerReason: 'local-progressive-discovery',
      message: '给我预测一下，如果目前的通胀率是5%，我的投资回报率是多少？我是第一个股东，我投入的钱都是银行贷款出来的，银行利率是年利率5%',
    })

    expect(projection.strategy).toBe('progressive_tool_discovery')
    expect(projection.selectedCapabilities).toEqual([])
    expect(projection.visibleToolNames).toEqual(expect.arrayContaining([
      'account_forbidden',
      'ask_user_clarification',
      'data_query_workspace',
      'rg',
      'sandbox_run_code',
    ]))
    expect(projection.kernelToolNames).toEqual(expect.arrayContaining([
      'account_forbidden',
      'ask_user_clarification',
      'data_query_workspace',
      'rg',
      'sandbox_run_code',
    ]))
    expect(projection.visibleToolNames).toContain('workspace_patch_config')
    expect(projection.visibleToolNames).toContain('tool_discover')
    expect(projection.visibleToolNames.length).toBeLessThanOrEqual(10)
    expect(projection.visibleToolNames).not.toContain('share_create')
    expect(projection.visibleToolNames).not.toContain('workspace_publish_release')
    expect(projection.surfacePlan?.schemaVersion).toBe('xox.tool_surface.v2')
    expect(projection.inventorySnapshot.source).toBe('progressive_tool_discovery')
    expect(projection.inventorySnapshot.freshness).toBe('fresh')
  })

  it('keeps high-confidence retrieved actions in a narrow pack when capability hints are empty', () => {
    const projection = buildRuntimeToolCatalogProjection({
      selectedCapabilities: [],
      routerReason: 'router-empty-restricted-surface',
      message: '新增股东 C，投资 10000，占分红 10%',
    })

    expect(projection.strategy).toBe('progressive_tool_discovery')
    expect(projection.selectedCapabilities).toEqual([])
    expect(projection.visibleToolNames).toEqual(expect.arrayContaining([
      'data_query_workspace',
      'rg',
      'sandbox_run_code',
      'ask_user_clarification',
      'account_forbidden',
      'tool_discover',
    ]))
    expect(projection.visibleToolNames).toContain('shareholder_add')
    expect(projection.visibleToolNames.length).toBeLessThanOrEqual(10)
    expect(projection.visibleToolNames).not.toContain('share_create')
    expect(projection.visibleToolNames).not.toContain('workspace_publish_release')
  })

  it('materializes model-discovered tools as an additive narrow surface', () => {
    const projection = buildRuntimeToolCatalogProjection({
      selectedCapabilities: [],
      routerReason: 'local-progressive-discovery',
      message: '继续完成刚才发现的股东写入工具',
      requiredToolNames: ['shareholder_add', 'workspace_patch_config'],
    })

    expect(projection.visibleToolNames).toEqual(expect.arrayContaining([
      'tool_discover',
      'data_query_workspace',
      'sandbox_run_code',
      'shareholder_add',
      'workspace_patch_config',
    ]))
    expect(projection.visibleToolNames).not.toContain('workspace_publish_release')
    expect(projection.materializableToolNames).not.toContain('shareholder_add')
    expect(projection.materializableToolNames).not.toContain('workspace_patch_config')
  })
})
