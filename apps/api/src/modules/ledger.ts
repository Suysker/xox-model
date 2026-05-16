import type { Kysely } from 'kysely'
import { buildForecastLineItems, hydrateModelConfig, projectModel, type ModelConfig, type ModelResult, type TeamMember } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { conflict, forbidden, notFound, unprocessable } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'
import type { CurrentUser } from './auth.js'
import { draftContext, getWorkspaceDraft, syncPeriodsWithCurrentDraft } from './workspace.js'

export type AllocationInput = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  amount: number
}

const bookkeepingSubjects = [
  {
    subjectKey: 'cost.other.refund',
    subjectName: '退费退款',
    subjectType: 'revenue' as const,
    subjectGroup: 'other',
    entityType: null,
    entityId: null,
    plannedAmount: 0,
  },
]

function baseMonths(result: ModelResult) {
  return (result.scenarios.find((item) => item.key === 'base') ?? result.scenarios[0])?.months ?? []
}

function monthNumberFromLabel(monthLabel: string | null | undefined) {
  if (!monthLabel?.endsWith('月')) return null
  const month = Number(monthLabel.slice(0, -1))
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : null
}

function coerceDate(value: string | Date) {
  return value instanceof Date ? value : new Date(value)
}

const defaultOccurredAtGraceMs = 5 * 60 * 1000

function entryHasExplicitOccurredAt(entry: Row<'actual_entries'>) {
  if (!entry.posted_at) return true
  return Math.abs(coerceDate(entry.occurred_at).getTime() - coerceDate(entry.posted_at).getTime()) > defaultOccurredAtGraceMs
}

async function currentDraftContext(db: Kysely<Database>, workspace: Row<'workspaces'>) {
  const draft = await getWorkspaceDraft(db, workspace)
  return draftContext(draft)
}

async function activePeriods(db: Kysely<Database>, workspace: Row<'workspaces'>, result?: ModelResult) {
  const context = result ? { result } : await currentDraftContext(db, workspace)
  await syncPeriodsWithCurrentDraft(db, workspace.id, context.result)
  const monthIndexes = new Set(baseMonths(context.result).map((month) => month.monthIndex))
  const periods = await db
    .selectFrom('ledger_periods')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .orderBy('month_index', 'asc')
    .execute()
  return periods.filter((period) => monthIndexes.has(period.month_index))
}

async function getPeriod(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: string) {
  const period = await db.selectFrom('ledger_periods').selectAll().where('id', '=', periodId).executeTakeFirst()
  if (!period) throw notFound('Ledger period not found')
  if (period.workspace_id !== workspace.id) throw forbidden()
  return period
}

function resolvePeriodForOccurredAt(periods: Row<'ledger_periods'>[], occurredAt: string, fallbackPeriod?: Row<'ledger_periods'> | null) {
  const targetMonth = coerceDate(occurredAt).getUTCMonth() + 1
  const matching = periods.filter((period) => monthNumberFromLabel(period.month_label) === targetMonth)
  if (matching.length === 0) return fallbackPeriod ?? null
  if (fallbackPeriod) {
    return matching.find((period) => period.id === fallbackPeriod.id) ?? matching.toSorted((a, b) => Math.abs(a.month_index - fallbackPeriod.month_index) - Math.abs(b.month_index - fallbackPeriod.month_index))[0] ?? fallbackPeriod
  }
  return matching[0] ?? null
}

async function realignEntriesToOccurredAt(db: Kysely<Database>, workspace: Row<'workspaces'>, periods?: Row<'ledger_periods'>[]) {
  const active = periods ?? (await activePeriods(db, workspace))
  const periodById = new Map(active.map((period) => [period.id, period]))
  const entries = await db
    .selectFrom('actual_entries')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute()
  const entryById = new Map(entries.map((entry) => [entry.id, entry]))
  let changed = false

  for (const entry of entries) {
    let targetPeriodId: string | null = null
    let nextOccurredAt = entry.occurred_at

    if (entry.entry_origin === 'derived' && entry.source_entry_id) {
      const source = entryById.get(entry.source_entry_id)
      if (!source) continue
      targetPeriodId = source.ledger_period_id
      nextOccurredAt = source.occurred_at
    } else {
      const current = periodById.get(entry.ledger_period_id) ?? null
      if (current && !entryHasExplicitOccurredAt(entry)) continue
      const target = resolvePeriodForOccurredAt(active, entry.occurred_at, current)
      targetPeriodId = target?.id ?? null
    }

    const updates: Partial<Row<'actual_entries'>> = {}
    if (targetPeriodId && targetPeriodId !== entry.ledger_period_id) {
      updates.ledger_period_id = targetPeriodId
    }
    if (nextOccurredAt !== entry.occurred_at) {
      updates.occurred_at = nextOccurredAt
    }
    if (Object.keys(updates).length > 0) {
      await db.updateTable('actual_entries').set(updates).where('id', '=', entry.id).execute()
      changed = true
    }
  }

  return changed
}

async function subjectsForPeriodByKey(db: Kysely<Database>, workspace: Row<'workspaces'>, period: Row<'ledger_periods'>) {
  const { config } = await currentDraftContext(db, workspace)
  const subjects = new Map<string, {
    subjectKey: string
    subjectName: string
    subjectType: 'revenue' | 'cost'
    subjectGroup: string
    entityType: string | null
    entityId: string | null
    plannedAmount: number
  }>()

  for (const row of buildForecastLineItems(config)) {
    if (row.scenarioKey !== 'base' || row.monthIndex !== period.month_index) continue
    const existing = subjects.get(row.subjectKey)
    if (existing) {
      existing.plannedAmount += row.plannedAmount
    } else {
      subjects.set(row.subjectKey, {
        subjectKey: row.subjectKey,
        subjectName: row.subjectName,
        subjectType: row.subjectType,
        subjectGroup: row.subjectGroup,
        entityType: row.entityType ?? null,
        entityId: row.entityId ?? null,
        plannedAmount: row.plannedAmount,
      })
    }
  }

  for (const subject of bookkeepingSubjects) {
    if (!subjects.has(subject.subjectKey)) subjects.set(subject.subjectKey, { ...subject })
  }

  return subjects
}

function relatedEntityCatalog(config: ModelConfig) {
  return {
    teamMember: new Map(config.teamMembers.map((member) => [member.id, member.name])),
    employee: new Map(config.employees.map((employee) => [employee.id, employee.name])),
  }
}

function monthResultForPeriod(result: ModelResult, period: Row<'ledger_periods'>) {
  return baseMonths(result).find((month) => month.monthIndex === period.month_index) ?? null
}

async function serializeEntry(db: Kysely<Database>, entry: Row<'actual_entries'>) {
  const allocations = await db
    .selectFrom('actual_entry_allocations')
    .selectAll()
    .where('actual_entry_id', '=', entry.id)
    .execute()
  return {
    id: entry.id,
    ledgerPeriodId: entry.ledger_period_id,
    direction: entry.direction as 'income' | 'expense',
    amount: entry.amount,
    occurredAt: entry.occurred_at,
    postedAt: entry.posted_at,
    counterparty: entry.counterparty,
    description: entry.description,
    relatedEntityType: entry.related_entity_type as 'teamMember' | 'employee' | null,
    relatedEntityId: entry.related_entity_id,
    relatedEntityName: entry.related_entity_name,
    sourceEntryId: entry.source_entry_id,
    entryOrigin: entry.entry_origin,
    derivedKind: entry.derived_kind,
    status: entry.status,
    allocations: allocations.map((allocation) => ({
      subjectKey: allocation.subject_key,
      subjectName: allocation.subject_name,
      subjectType: allocation.subject_type as 'revenue' | 'cost',
      amount: allocation.amount,
    })),
  }
}

async function periodSummary(db: Kysely<Database>, workspace: Row<'workspaces'>, period: Row<'ledger_periods'>, result?: ModelResult) {
  const context = result ? { result } : await currentDraftContext(db, workspace)
  const month = monthResultForPeriod(context.result, period)
  const allocations = await db
    .selectFrom('actual_entry_allocations')
    .innerJoin('actual_entries', 'actual_entries.id', 'actual_entry_allocations.actual_entry_id')
    .select(['actual_entry_allocations.subject_type as subject_type', 'actual_entry_allocations.amount as amount'])
    .where('actual_entries.ledger_period_id', '=', period.id)
    .where('actual_entries.status', '=', 'posted')
    .execute()
  let actualRevenue = 0
  let actualCost = 0
  for (const allocation of allocations) {
    if (allocation.subject_type === 'revenue') actualRevenue += allocation.amount
    else actualCost += allocation.amount
  }

  return {
    plannedRevenue: month?.grossSales ?? 0,
    plannedCost: month?.totalCost ?? 0,
    actualRevenue,
    actualCost,
  }
}

async function cumulativeSummary(db: Kysely<Database>, workspace: Row<'workspaces'>, throughMonthIndex: number, result: ModelResult) {
  const periods = await db
    .selectFrom('ledger_periods')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('month_index', '<=', throughMonthIndex)
    .orderBy('month_index', 'asc')
    .execute()
  const totals = { plannedRevenue: 0, plannedCost: 0, actualRevenue: 0, actualCost: 0 }
  for (const period of periods) {
    const summary = await periodSummary(db, workspace, period, result)
    totals.plannedRevenue += summary.plannedRevenue
    totals.plannedCost += summary.plannedCost
    totals.actualRevenue += summary.actualRevenue
    totals.actualCost += summary.actualCost
  }
  return totals
}

export async function listPeriods(db: Kysely<Database>, workspace: Row<'workspaces'>) {
  const { result } = await currentDraftContext(db, workspace)
  const periods = await activePeriods(db, workspace, result)
  await realignEntriesToOccurredAt(db, workspace, periods)
  const rows = []
  for (const period of periods) {
    rows.push({
      id: period.id,
      monthIndex: period.month_index,
      monthLabel: period.month_label,
      status: period.status,
      baselineVersionId: null,
      baselineVersionName: null,
      ...(await periodSummary(db, workspace, period, result)),
    })
  }
  return rows
}

export async function listSubjectsForPeriod(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: string) {
  const period = await getPeriod(db, workspace, periodId)
  return [...(await subjectsForPeriodByKey(db, workspace, period)).values()].sort((a, b) =>
    `${a.subjectType}:${a.subjectGroup}:${a.subjectName}`.localeCompare(`${b.subjectType}:${b.subjectGroup}:${b.subjectName}`),
  )
}

export async function listEntries(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: string) {
  await getPeriod(db, workspace, periodId)
  const periods = await activePeriods(db, workspace)
  await realignEntriesToOccurredAt(db, workspace, periods)
  const entries = await db
    .selectFrom('actual_entries')
    .selectAll()
    .where('ledger_period_id', '=', periodId)
    .orderBy('posted_at', 'desc')
    .orderBy('occurred_at', 'desc')
    .orderBy('created_at', 'desc')
    .execute()
  return Promise.all(entries.map((entry) => serializeEntry(db, entry)))
}

function memberForConfig(config: ModelConfig, memberId: string): TeamMember | null {
  return config.teamMembers.find((member) => member.id === memberId) ?? null
}

async function normalizeEntryPayload(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    period: Row<'ledger_periods'>
    direction: string
    amount: number
    relatedEntityType?: string | null
    relatedEntityId?: string | null | undefined
    relatedEntityName?: string | null | undefined
    allocations: AllocationInput[]
  },
) {
  if (input.amount <= 0) throw unprocessable('Amount must be positive')
  if (input.allocations.length === 0) throw unprocessable('At least one allocation is required')
  if (input.allocations.some((allocation) => allocation.amount <= 0)) throw unprocessable('Allocation amounts must be positive')
  if (Math.round(input.allocations.reduce((sum, item) => sum + item.amount, 0) * 100) !== Math.round(input.amount * 100)) {
    throw unprocessable('Allocations must equal the entry amount')
  }

  const expectedSubjectType = input.direction === 'income' ? 'revenue' : 'cost'
  const { config } = await currentDraftContext(db, input.workspace)
  const availableSubjects = await subjectsForPeriodByKey(db, input.workspace, input.period)
  const entityCatalog = relatedEntityCatalog(config)
  const totalsBySubject = new Map<string, number>()

  for (const allocation of input.allocations) {
    const canonical = availableSubjects.get(allocation.subjectKey)
    if (!canonical) throw unprocessable(`Unknown forecast subject: ${allocation.subjectKey}`)
    if (canonical.subjectType !== expectedSubjectType) throw unprocessable('Entry direction does not match allocation subject type')
    if (input.direction === 'expense' && allocation.subjectKey === 'cost.member.commission') {
      throw unprocessable('Member commission is derived automatically from posted member revenue')
    }
    totalsBySubject.set(allocation.subjectKey, (totalsBySubject.get(allocation.subjectKey) ?? 0) + allocation.amount)
  }

  const normalizedAllocations = [...totalsBySubject.entries()].map(([subjectKey, amount]) => {
    const canonical = availableSubjects.get(subjectKey)
    if (!canonical) throw unprocessable(`Unknown forecast subject: ${subjectKey}`)
    return {
      subjectKey: canonical.subjectKey,
      subjectName: canonical.subjectName,
      subjectType: canonical.subjectType,
      amount: Math.round(amount * 100) / 100,
    }
  })

  if ((input.relatedEntityType || input.relatedEntityId || input.relatedEntityName) && !(input.relatedEntityType && input.relatedEntityId)) {
    throw unprocessable('Related entity selection is incomplete')
  }

  let canonicalRelatedName: string | null = null
  if (input.relatedEntityType && input.relatedEntityId) {
    if (input.relatedEntityType !== 'teamMember' && input.relatedEntityType !== 'employee') throw unprocessable('Unsupported related entity type')
    canonicalRelatedName = entityCatalog[input.relatedEntityType].get(input.relatedEntityId) ?? null
    if (!canonicalRelatedName) throw unprocessable('Related entity not found in the current draft')
  }

  return { config, availableSubjects, normalizedAllocations, totalsBySubject, canonicalRelatedName }
}

async function replaceEntryAllocations(db: Kysely<Database>, entryId: string, allocations: Array<{ subjectKey: string; subjectName: string; subjectType: string; amount: number }>) {
  await db.deleteFrom('actual_entry_allocations').where('actual_entry_id', '=', entryId).execute()
  for (const allocation of allocations) {
    await db
      .insertInto('actual_entry_allocations')
      .values({
        id: newId(),
        actual_entry_id: entryId,
        subject_key: allocation.subjectKey,
        subject_name: allocation.subjectName,
        subject_type: allocation.subjectType,
        amount: allocation.amount,
      })
      .execute()
  }
}

function memberIncomeTotal(totalsBySubject: Map<string, number>) {
  return Math.round(((totalsBySubject.get('revenue.offline_sales') ?? 0) + (totalsBySubject.get('revenue.online_sales') ?? 0)) * 100) / 100
}

async function syncDerivedMemberCommissionEntry(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    period: Row<'ledger_periods'>
    actorId: string
    sourceEntry: Row<'actual_entries'>
    sourceAmount: number
    relatedEntityId?: string | null
    relatedEntityName?: string | null | undefined
    availableSubjects: Map<string, { subjectKey: string; subjectName: string; subjectType: 'revenue' | 'cost' }>
    timestamp: string
  },
) {
  const existing = await db
    .selectFrom('actual_entries')
    .selectAll()
    .where('source_entry_id', '=', input.sourceEntry.id)
    .where('derived_kind', '=', 'member_commission')
    .orderBy('created_at', 'asc')
    .execute()
  const primary = existing[0] ?? null
  for (const extra of existing.slice(1)) {
    await db.updateTable('actual_entries').set({ status: 'voided', updated_at: utcNow() }).where('id', '=', extra.id).execute()
  }

  if (input.sourceAmount <= 0 || !input.relatedEntityId || !input.relatedEntityName) {
    if (primary) await db.updateTable('actual_entries').set({ status: 'voided', updated_at: utcNow() }).where('id', '=', primary.id).execute()
    return null
  }

  const { config } = await currentDraftContext(db, input.workspace)
  const member = memberForConfig(config, input.relatedEntityId)
  if (!member) throw unprocessable('Related entity not found in the current draft')
  const commissionSubject = input.availableSubjects.get('cost.member.commission')
  if (!commissionSubject) throw unprocessable('Current draft does not expose member commission subject')
  const commissionAmount = Math.round(input.sourceAmount * Math.max(0, member.commissionRate) * 100) / 100
  if (commissionAmount <= 0) {
    if (primary) await db.updateTable('actual_entries').set({ status: 'voided', updated_at: utcNow() }).where('id', '=', primary.id).execute()
    return null
  }

  let entry = primary
  if (!entry) {
    const entryId = newId()
    await db
      .insertInto('actual_entries')
      .values({
        id: entryId,
        workspace_id: input.workspace.id,
        ledger_period_id: input.period.id,
        direction: 'expense',
        amount: commissionAmount,
        occurred_at: input.sourceEntry.occurred_at,
        counterparty: null,
        description: `${input.relatedEntityName} 提成自动计提`,
        related_entity_type: 'teamMember',
        related_entity_id: input.relatedEntityId,
        related_entity_name: input.relatedEntityName,
        source_entry_id: input.sourceEntry.id,
        entry_origin: 'derived',
        derived_kind: 'member_commission',
        status: 'posted',
        created_by: input.actorId,
        posted_at: input.timestamp,
        created_at: input.timestamp,
        updated_at: input.timestamp,
      })
      .execute()
    await recordAudit(db, {
      workspaceId: input.workspace.id,
      actorId: input.actorId,
      action: 'ledger.entry_auto_derived',
      entityType: 'actual_entry',
      entityId: entryId,
      meta: { ledgerPeriodId: input.period.id, sourceEntryId: input.sourceEntry.id, derivedKind: 'member_commission', amount: commissionAmount },
    })
    entry = await db.selectFrom('actual_entries').selectAll().where('id', '=', entryId).executeTakeFirstOrThrow()
  } else {
    await db
      .updateTable('actual_entries')
      .set({
        ledger_period_id: input.period.id,
        amount: commissionAmount,
        occurred_at: input.sourceEntry.occurred_at,
        description: `${input.relatedEntityName} 提成自动计提`,
        related_entity_type: 'teamMember',
        related_entity_id: input.relatedEntityId,
        related_entity_name: input.relatedEntityName,
        status: 'posted',
        posted_at: entry.posted_at ?? input.timestamp,
        updated_at: utcNow(),
      })
      .where('id', '=', entry.id)
      .execute()
  }

  await replaceEntryAllocations(db, entry.id, [
    {
      subjectKey: commissionSubject.subjectKey,
      subjectName: commissionSubject.subjectName,
      subjectType: commissionSubject.subjectType,
      amount: commissionAmount,
    },
  ])
  return entry
}

export async function createActualEntry(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    actor: CurrentUser
    ledgerPeriodId: string
    direction: 'income' | 'expense'
    amount: number
    occurredAt?: string | null | undefined
    counterparty?: string | null | undefined
    description?: string | null | undefined
    relatedEntityType?: 'teamMember' | 'employee' | null | undefined
    relatedEntityId?: string | null | undefined
    relatedEntityName?: string | null | undefined
    allocations: AllocationInput[]
  },
) {
  const fallbackPeriod = await getPeriod(db, input.workspace, input.ledgerPeriodId)
  const periods = await activePeriods(db, input.workspace)
  const timestamp = utcNow()
  const effectiveOccurredAt = input.occurredAt ?? timestamp
  const period = input.occurredAt ? resolvePeriodForOccurredAt(periods, input.occurredAt, fallbackPeriod) ?? fallbackPeriod : fallbackPeriod
  if (period.status === 'locked') throw unprocessable('Ledger period is locked')
  const normalized = await normalizeEntryPayload(db, { ...input, period, relatedEntityType: input.relatedEntityType ?? null, relatedEntityId: input.relatedEntityId ?? null, relatedEntityName: input.relatedEntityName ?? null })
  const entryId = newId()

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('actual_entries')
      .values({
        id: entryId,
        workspace_id: input.workspace.id,
        ledger_period_id: period.id,
        direction: input.direction,
        amount: input.amount,
        occurred_at: effectiveOccurredAt,
        counterparty: input.counterparty ?? null,
        description: input.description ?? null,
        related_entity_type: input.relatedEntityType ?? null,
        related_entity_id: input.relatedEntityId ?? null,
        related_entity_name: normalized.canonicalRelatedName ?? input.relatedEntityName ?? null,
        source_entry_id: null,
        entry_origin: 'manual',
        derived_kind: null,
        status: 'posted',
        created_by: input.actor.id,
        posted_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .execute()
    await replaceEntryAllocations(trx, entryId, normalized.normalizedAllocations)
    await recordAudit(trx, {
      workspaceId: input.workspace.id,
      actorId: input.actor.id,
      action: 'ledger.entry_posted',
      entityType: 'actual_entry',
      entityId: entryId,
      meta: { ledgerPeriodId: period.id, direction: input.direction, amount: input.amount, relatedEntityType: input.relatedEntityType, relatedEntityId: input.relatedEntityId },
    })
  })

  let entry = await db.selectFrom('actual_entries').selectAll().where('id', '=', entryId).executeTakeFirstOrThrow()
  if (input.direction === 'income' && input.relatedEntityType === 'teamMember' && input.relatedEntityId) {
    await syncDerivedMemberCommissionEntry(db, {
      workspace: input.workspace,
      period,
      actorId: input.actor.id,
      sourceEntry: entry,
      sourceAmount: memberIncomeTotal(normalized.totalsBySubject),
      relatedEntityId: input.relatedEntityId,
      relatedEntityName: normalized.canonicalRelatedName ?? input.relatedEntityName,
      availableSubjects: normalized.availableSubjects,
      timestamp,
    })
    entry = await db.selectFrom('actual_entries').selectAll().where('id', '=', entryId).executeTakeFirstOrThrow()
  }
  return serializeEntry(db, entry)
}

export async function updateActualEntry(
  db: Kysely<Database>,
  input: {
    workspace: Row<'workspaces'>
    actor: CurrentUser
    entryId: string
    amount: number
    occurredAt?: string | null | undefined
    counterparty?: string | null | undefined
    description?: string | null | undefined
    relatedEntityType?: 'teamMember' | 'employee' | null | undefined
    relatedEntityId?: string | null | undefined
    relatedEntityName?: string | null | undefined
    allocations: AllocationInput[]
  },
) {
  const entry = await getEntry(db, input.workspace, input.entryId)
  if (entry.entry_origin === 'derived') throw conflict('System-generated entry must be edited from its source entry')
  if (entry.status === 'voided') throw conflict('Voided entry cannot be edited')
  const periods = await activePeriods(db, input.workspace)
  const fallbackPeriod = await db.selectFrom('ledger_periods').selectAll().where('id', '=', entry.ledger_period_id).executeTakeFirst()
  const period = input.occurredAt ? resolvePeriodForOccurredAt(periods, input.occurredAt, fallbackPeriod) ?? fallbackPeriod : fallbackPeriod
  if (!period) throw notFound('Ledger period not found')
  if (period.status === 'locked') throw conflict('Ledger period is locked')
  const normalized = await normalizeEntryPayload(db, { ...input, direction: entry.direction, period, relatedEntityType: input.relatedEntityType ?? null, relatedEntityId: input.relatedEntityId ?? null, relatedEntityName: input.relatedEntityName ?? null })
  const now = utcNow()
  await db
    .updateTable('actual_entries')
    .set({
      amount: input.amount,
      ledger_period_id: period.id,
      occurred_at: input.occurredAt ?? entry.occurred_at,
      counterparty: input.counterparty ?? null,
      description: input.description ?? null,
      related_entity_type: input.relatedEntityType ?? null,
      related_entity_id: input.relatedEntityId ?? null,
      related_entity_name: normalized.canonicalRelatedName ?? input.relatedEntityName ?? null,
      updated_at: now,
    })
    .where('id', '=', entry.id)
    .execute()
  await replaceEntryAllocations(db, entry.id, normalized.normalizedAllocations)
  const updated = await getEntry(db, input.workspace, input.entryId)
  if (entry.direction === 'income' && input.relatedEntityType === 'teamMember' && input.relatedEntityId) {
    await syncDerivedMemberCommissionEntry(db, {
      workspace: input.workspace,
      period,
      actorId: input.actor.id,
      sourceEntry: updated,
      sourceAmount: memberIncomeTotal(normalized.totalsBySubject),
      relatedEntityId: input.relatedEntityId,
      relatedEntityName: normalized.canonicalRelatedName ?? input.relatedEntityName,
      availableSubjects: normalized.availableSubjects,
      timestamp: now,
    })
  } else {
    await syncDerivedMemberCommissionEntry(db, {
      workspace: input.workspace,
      period,
      actorId: input.actor.id,
      sourceEntry: updated,
      sourceAmount: 0,
      relatedEntityId: null,
      relatedEntityName: null,
      availableSubjects: normalized.availableSubjects,
      timestamp: now,
    })
  }
  await recordAudit(db, {
    workspaceId: input.workspace.id,
    actorId: input.actor.id,
    action: 'ledger.entry_updated',
    entityType: 'actual_entry',
    entityId: entry.id,
    meta: { ledgerPeriodId: period.id, direction: entry.direction, amount: input.amount, relatedEntityType: input.relatedEntityType, relatedEntityId: input.relatedEntityId },
  })
  return serializeEntry(db, await getEntry(db, input.workspace, input.entryId))
}

async function getEntry(db: Kysely<Database>, workspace: Row<'workspaces'>, entryId: string) {
  const entry = await db.selectFrom('actual_entries').selectAll().where('id', '=', entryId).executeTakeFirst()
  if (!entry) throw notFound('Entry not found')
  if (entry.workspace_id !== workspace.id) throw forbidden()
  return entry
}

export async function voidEntry(db: Kysely<Database>, workspace: Row<'workspaces'>, entryId: string, actorId: string) {
  const entry = await getEntry(db, workspace, entryId)
  const period = await db.selectFrom('ledger_periods').selectAll().where('id', '=', entry.ledger_period_id).executeTakeFirst()
  if (period?.status === 'locked') throw conflict('Ledger period is locked')
  if (entry.entry_origin === 'derived') throw conflict('System-generated entry must be voided from its source entry')
  const now = utcNow()
  const derived = await db.selectFrom('actual_entries').selectAll().where('source_entry_id', '=', entry.id).where('status', '=', 'posted').execute()
  await db.updateTable('actual_entries').set({ status: 'voided', updated_at: now }).where('id', '=', entry.id).execute()
  for (const derivedEntry of derived) {
    await db.updateTable('actual_entries').set({ status: 'voided', updated_at: now }).where('id', '=', derivedEntry.id).execute()
  }
  await recordAudit(db, {
    workspaceId: workspace.id,
    actorId,
    action: 'ledger.entry_voided',
    entityType: 'actual_entry',
    entityId: entry.id,
    meta: { ledgerPeriodId: entry.ledger_period_id, derivedEntryIds: derived.map((item) => item.id) },
  })
}

export async function restoreEntry(db: Kysely<Database>, workspace: Row<'workspaces'>, entryId: string, actorId: string) {
  const entry = await getEntry(db, workspace, entryId)
  if (entry.entry_origin === 'derived') throw conflict('System-generated entry must be restored from its source entry')
  if (entry.status !== 'voided') throw conflict('Entry is not voided')
  const periods = await activePeriods(db, workspace)
  const fallback = await db.selectFrom('ledger_periods').selectAll().where('id', '=', entry.ledger_period_id).executeTakeFirst()
  const period = entryHasExplicitOccurredAt(entry) || !fallback ? resolvePeriodForOccurredAt(periods, entry.occurred_at, fallback) ?? fallback : fallback
  if (period?.status === 'locked') throw conflict('Ledger period is locked')
  const now = utcNow()
  await db.updateTable('actual_entries').set({ status: 'posted', ledger_period_id: period?.id ?? entry.ledger_period_id, updated_at: now }).where('id', '=', entry.id).execute()
  const derived = await db.selectFrom('actual_entries').selectAll().where('source_entry_id', '=', entry.id).orderBy('created_at', 'desc').execute()
  const restored: string[] = []
  const primary = derived[0]
  if (primary) {
    await db
      .updateTable('actual_entries')
      .set({ status: 'posted', ledger_period_id: period?.id ?? entry.ledger_period_id, occurred_at: entry.occurred_at, posted_at: primary.posted_at ?? entry.posted_at, updated_at: now })
      .where('id', '=', primary.id)
      .execute()
    restored.push(primary.id)
    for (const extra of derived.slice(1)) {
      await db.updateTable('actual_entries').set({ status: 'voided', updated_at: now }).where('id', '=', extra.id).execute()
    }
  }
  await recordAudit(db, {
    workspaceId: workspace.id,
    actorId,
    action: 'ledger.entry_restored',
    entityType: 'actual_entry',
    entityId: entry.id,
    meta: { ledgerPeriodId: period?.id ?? entry.ledger_period_id, derivedEntryIds: restored },
  })
}

export async function setPeriodStatus(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: string, actorId: string, statusValue: 'open' | 'locked') {
  const period = await getPeriod(db, workspace, periodId)
  await db.updateTable('ledger_periods').set({ status: statusValue, updated_at: utcNow() }).where('id', '=', period.id).execute()
  await recordAudit(db, {
    workspaceId: workspace.id,
    actorId,
    action: `ledger.period_${statusValue}`,
    entityType: 'ledger_period',
    entityId: period.id,
    meta: { monthIndex: period.month_index, baselineSource: 'draft' },
  })
  const next = await getPeriod(db, workspace, periodId)
  return {
    id: next.id,
    monthIndex: next.month_index,
    monthLabel: next.month_label,
    status: next.status,
    baselineVersionId: null,
    baselineVersionName: null,
    ...(await periodSummary(db, workspace, next)),
  }
}

export async function varianceForPeriod(db: Kysely<Database>, workspace: Row<'workspaces'>, periodId: string) {
  const period = await getPeriod(db, workspace, periodId)
  const { config, result } = await currentDraftContext(db, workspace)
  const periods = await activePeriods(db, workspace, result)
  await realignEntriesToOccurredAt(db, workspace, periods)

  const planned = new Map<string, number>()
  const labels = new Map<string, { subjectName: string; subjectType: string }>()
  for (const row of buildForecastLineItems(config)) {
    if (row.scenarioKey !== 'base' || row.monthIndex !== period.month_index) continue
    planned.set(row.subjectKey, (planned.get(row.subjectKey) ?? 0) + row.plannedAmount)
    labels.set(row.subjectKey, { subjectName: row.subjectName, subjectType: row.subjectType })
  }

  const actual = new Map<string, number>()
  const rows = await db
    .selectFrom('actual_entry_allocations')
    .innerJoin('actual_entries', 'actual_entries.id', 'actual_entry_allocations.actual_entry_id')
    .select(['actual_entry_allocations.subject_key as subject_key', 'actual_entry_allocations.subject_name as subject_name', 'actual_entry_allocations.subject_type as subject_type', 'actual_entry_allocations.amount as amount'])
    .where('actual_entries.ledger_period_id', '=', period.id)
    .where('actual_entries.status', '=', 'posted')
    .execute()
  for (const row of rows) {
    actual.set(row.subject_key, (actual.get(row.subject_key) ?? 0) + row.amount)
    if (!labels.has(row.subject_key)) labels.set(row.subject_key, { subjectName: row.subject_name, subjectType: row.subject_type })
  }

  const subjectKeys = [...new Set([...planned.keys(), ...actual.keys()])].sort()
  const lines = subjectKeys.map((subjectKey) => {
    const plannedAmount = planned.get(subjectKey) ?? 0
    const actualAmount = actual.get(subjectKey) ?? 0
    const varianceAmount = actualAmount - plannedAmount
    const label = labels.get(subjectKey) ?? { subjectName: subjectKey, subjectType: 'cost' }
    return {
      subjectKey,
      subjectName: label.subjectName,
      subjectType: label.subjectType,
      plannedAmount,
      actualAmount,
      varianceAmount,
      varianceRate: plannedAmount ? varianceAmount / plannedAmount : null,
    }
  })

  const summary = await periodSummary(db, workspace, period, result)
  const cumulative = await cumulativeSummary(db, workspace, period.month_index, result)
  return {
    periodId: period.id,
    monthLabel: period.month_label,
    baselineVersionId: null,
    baselineVersionName: null,
    lines,
    ...summary,
    revenueVarianceAmount: summary.actualRevenue - summary.plannedRevenue,
    revenueVarianceRate: summary.plannedRevenue ? (summary.actualRevenue - summary.plannedRevenue) / summary.plannedRevenue : null,
    costVarianceAmount: summary.actualCost - summary.plannedCost,
    costVarianceRate: summary.plannedCost ? (summary.actualCost - summary.plannedCost) / summary.plannedCost : null,
    cumulativePlannedRevenue: cumulative.plannedRevenue,
    cumulativePlannedCost: cumulative.plannedCost,
    cumulativeActualRevenue: cumulative.actualRevenue,
    cumulativeActualCost: cumulative.actualCost,
    cumulativeRevenueVarianceAmount: cumulative.actualRevenue - cumulative.plannedRevenue,
    cumulativeRevenueVarianceRate: cumulative.plannedRevenue ? (cumulative.actualRevenue - cumulative.plannedRevenue) / cumulative.plannedRevenue : null,
    cumulativeCostVarianceAmount: cumulative.actualCost - cumulative.plannedCost,
    cumulativeCostVarianceRate: cumulative.plannedCost ? (cumulative.actualCost - cumulative.plannedCost) / cumulative.plannedCost : null,
  }
}
