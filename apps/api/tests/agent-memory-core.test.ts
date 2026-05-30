import {
  buildMemoryCitation,
  buildMemoryFlushPlan,
  compactMemoryForBudget,
  formatMemoryCitation,
  rankShortTermPromotionCandidates,
  takeBudgetedMemoryItems,
  applyMmr,
  lexicalRelevance,
} from '@xox/agent-memory-core'
import { AGENT_TOOL_REGISTRY, toolCallToPlannerStep } from '../src/agent/tool-catalog.js'

describe('OpenClaw-derived agent-memory-core', () => {
  it('compacts only auto-promoted memory sections and preserves user-authored content', () => {
    const existing = [
      '# Long-Term Memory',
      '',
      'User-authored durable preference.',
      '## Promoted From Short-Term Memory (2026-05-01)',
      'old promoted section '.repeat(20),
      '## Promoted From Short-Term Memory (2026-05-02)',
      'newer promoted section',
    ].join('\n')
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: 'fresh section '.repeat(20),
      budgetChars: 260,
    })
    expect(result.compacted).toContain('User-authored durable preference.')
    expect(result.compacted).not.toContain('old promoted section')
    expect(result.droppedDates).toContain('2026-05-01')
  })

  it('takes memory items under an injection budget', () => {
    const result = takeBudgetedMemoryItems([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'bravo bravo' },
      { id: 'c', text: 'charlie' },
    ], 16)
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(result.usedChars).toBeLessThanOrEqual(16)
  })

  it('builds a SaaS daily-note flush plan without filesystem targets', () => {
    const plan = buildMemoryFlushPlan({ nowMs: Date.UTC(2026, 4, 31), timezone: 'UTC' })
    expect(plan.noteDate).toBe('2026-05-31')
    expect(plan.prompt).toContain('tenant-scoped daily/session memory notes')
    expect(plan.prompt).toContain('<SILENT_MEMORY_FLUSH>')
    expect(plan.prompt).not.toContain('MEMORY.md')
  })

  it('scores promotion candidates with OpenClaw-style recall frequency and query diversity gates', () => {
    const ranked = rankShortTermPromotionCandidates({
      nowMs: Date.UTC(2026, 4, 31),
      signals: [
        {
          memoryId: 'weak',
          snippet: 'only once',
          recallCount: 1,
          totalScore: 0.95,
          maxScore: 0.95,
          uniqueQueries: 1,
          recallDays: ['2026-05-31'],
          firstRecalledAt: '2026-05-31T00:00:00.000Z',
          lastRecalledAt: '2026-05-31T00:00:00.000Z',
        },
        {
          memoryId: 'strong',
          snippet: 'stable workflow',
          recallCount: 5,
          totalScore: 4.5,
          maxScore: 0.96,
          uniqueQueries: 3,
          recallDays: ['2026-05-29', '2026-05-30', '2026-05-31'],
          firstRecalledAt: '2026-05-29T00:00:00.000Z',
          lastRecalledAt: '2026-05-31T00:00:00.000Z',
          conceptTags: ['workflow', 'ledger'],
          consolidationHits: 2,
        },
      ],
    })
    expect(ranked.map((item) => item.memoryId)).toEqual(['strong'])
    expect(ranked[0]?.components.frequency).toBeGreaterThan(0)
  })

  it('keeps retrieval reranking diverse and CJK-aware', () => {
    const query = '默认记账成员'
    const relevance = lexicalRelevance(query, '默认记账成员是 成员 1')
    expect(relevance.reasons.some((reason) => reason.startsWith('token_overlap:'))).toBe(true)
    const ranked = applyMmr([
      { id: 'a', key: '默认成员', value: '默认记账成员是 成员 1', score: 0.9 },
      { id: 'b', key: '默认成员复制', value: '默认记账成员是 成员 1', score: 0.89 },
      { id: 'c', key: '审批人', value: '默认审批人是 李雷', score: 0.7 },
    ])
    expect(ranked[0]?.id).toBe('a')
    expect(ranked.slice(0, 2).map((item) => item.id)).toContain('c')
  })

  it('formats tenant-scoped memory citations without file paths', () => {
    const citation = buildMemoryCitation({
      memoryId: 'mem-1',
      layer: 'durable',
      score: 0.88,
      evidenceRefs: ['audit:audit-1', 'action:action-1'],
    })
    expect(formatMemoryCitation(citation)).toBe('[memory:mem-1 layer=durable score=0.880 evidence=audit:audit-1,action:action-1]')
  })

  it('exposes OpenClaw-style memory search/get as first-class read tools', () => {
    const registry = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))
    expect(registry.get('memory_search')?.capability).toBe('memory')
    expect(registry.get('memory_search')?.riskLevel).toBe('read')
    expect(registry.get('memory_search')?.confirmationMode).toBe('never')
    expect(registry.get('memory_get')?.capability).toBe('memory')
    expect(registry.get('memory_get')?.riskLevel).toBe('read')
    expect(toolCallToPlannerStep('memory_search', { query: '默认记账成员' })?.intent).toBe('memory.search')
    expect(toolCallToPlannerStep('memory_get', { memoryId: 'mem-1' })?.intent).toBe('memory.get')
  })
})
