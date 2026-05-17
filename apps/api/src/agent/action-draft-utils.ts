import type { Kysely } from 'kysely'
import { hydrateModelConfig, type ModelConfig } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { parseJson } from '../db/database.js'
import { utcNow } from '../core/time.js'
import { listPeriods } from '../modules/ledger.js'
import { getWorkspaceDraft } from '../modules/workspace.js'

type WorkspaceContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
}

export function periodOccurrenceDate(config: ModelConfig, period: { monthIndex: number }) {
  const startMonth = Math.min(12, Math.max(1, Math.round(config.planning.startMonth || 1)))
  const monthOffset = startMonth - 1 + period.monthIndex - 1
  const year = new Date(utcNow()).getUTCFullYear() + Math.floor(monthOffset / 12)
  const month = monthOffset % 12
  return new Date(Date.UTC(year, month, 1, 12, 0, 0)).toISOString()
}

export async function periodForMonth(ctx: WorkspaceContext, monthLabel: string) {
  const periods = await listPeriods(ctx.db, ctx.workspace)
  return periods.find((period) => period.monthLabel === monthLabel) ?? periods[0] ?? null
}

export async function currentDraftConfig(ctx: WorkspaceContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  return {
    draft,
    config: hydrateModelConfig(parseJson<unknown>(draft.config_json, null)),
  }
}

export function finiteNumber(value: unknown) {
  if (value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function normalizedMemberKey(value: string) {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

export function findTeamMember(config: ModelConfig, input: { memberId?: string | null | undefined; memberName?: string | null | undefined }) {
  const memberId = typeof input.memberId === 'string' ? input.memberId.trim() : ''
  if (memberId) {
    const byId = config.teamMembers.find((member) => member.id === memberId)
    if (byId) return byId
  }

  const memberName = typeof input.memberName === 'string' ? input.memberName.trim() : ''
  if (!memberName) return null
  const normalized = normalizedMemberKey(memberName)
  return config.teamMembers.find((member) => member.id === memberName || normalizedMemberKey(member.name) === normalized) ?? null
}

export function findEmployee(config: ModelConfig, input: { employeeId?: string | null | undefined; employeeName?: string | null | undefined }) {
  const employeeId = typeof input.employeeId === 'string' ? input.employeeId.trim() : ''
  if (employeeId) {
    const byId = config.employees.find((employee) => employee.id === employeeId)
    if (byId) return byId
  }

  const employeeName = typeof input.employeeName === 'string' ? input.employeeName.trim() : ''
  if (!employeeName) return null
  const normalized = normalizedMemberKey(employeeName)
  return config.employees.find((employee) => employee.id === employeeName || normalizedMemberKey(employee.name) === normalized) ?? null
}
