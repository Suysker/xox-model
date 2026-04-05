import type { EntryResponse } from '../../lib/api'
import { summarizePostedAmounts } from './BookkeepingPanel'

function buildEntry(overrides: Partial<EntryResponse>): EntryResponse {
  return {
    id: overrides.id ?? 'entry-1',
    ledgerPeriodId: overrides.ledgerPeriodId ?? 'period-1',
    direction: overrides.direction ?? 'income',
    amount: overrides.amount ?? 0,
    occurredAt: overrides.occurredAt ?? '2026-04-05T00:00:00',
    postedAt: overrides.postedAt ?? '2026-04-05T00:00:00',
    counterparty: overrides.counterparty ?? null,
    description: overrides.description ?? null,
    relatedEntityType: overrides.relatedEntityType ?? null,
    relatedEntityId: overrides.relatedEntityId ?? null,
    relatedEntityName: overrides.relatedEntityName ?? null,
    sourceEntryId: overrides.sourceEntryId ?? null,
    entryOrigin: overrides.entryOrigin ?? 'manual',
    derivedKind: overrides.derivedKind ?? null,
    status: overrides.status ?? 'posted',
    allocations: overrides.allocations ?? [],
  }
}

describe('summarizePostedAmounts', () => {
  it('keeps standalone other income totals separate from member ledger totals', () => {
    const entries: EntryResponse[] = [
      buildEntry({
        id: 'member-income',
        amount: 88,
        relatedEntityType: 'teamMember',
        relatedEntityId: 'member-a',
        relatedEntityName: '成员 A',
        allocations: [
          {
            subjectKey: 'revenue.offline_sales',
            subjectName: '线下营收',
            subjectType: 'revenue',
            amount: 88,
          },
        ],
      }),
      buildEntry({
        id: 'other-income',
        amount: 100,
        allocations: [
          {
            subjectKey: 'revenue.offline_sales',
            subjectName: '线下营收',
            subjectType: 'revenue',
            amount: 100,
          },
        ],
      }),
      buildEntry({
        id: 'refund',
        direction: 'income',
        amount: 20,
        allocations: [
          {
            subjectKey: 'cost.other.refund',
            subjectName: '退费退款',
            subjectType: 'revenue',
            amount: 20,
          },
        ],
      }),
      buildEntry({
        id: 'voided-other-income',
        amount: 66,
        status: 'voided',
        allocations: [
          {
            subjectKey: 'revenue.offline_sales',
            subjectName: '线下营收',
            subjectType: 'revenue',
            amount: 66,
          },
        ],
      }),
    ]

    const totals = summarizePostedAmounts(entries)

    expect(totals.bySubject.get('revenue.offline_sales')).toBe(188)
    expect(totals.bySubjectAndEntity.get('revenue.offline_sales:member-a')).toBe(88)
    expect(totals.standaloneBySubject.get('revenue.offline_sales')).toBe(100)
    expect(totals.standaloneBySubject.get('cost.other.refund')).toBe(20)
  })
})
