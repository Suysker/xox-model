import type { Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'

export type AgentAmbientContext = {
  nowIso: string
  localDate: string
  timezone: string
  userDisplayName?: string | null
  workspaceName?: string | null
}

function runtimeTimezone() {
  return process.env.XOX_AGENT_TIMEZONE ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
}

function formatLocalDate(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970'
  const month = parts.find((part) => part.type === 'month')?.value ?? '01'
  const day = parts.find((part) => part.type === 'day')?.value ?? '01'
  return `${year}-${month}-${day}`
}

export function buildAgentAmbientContext(input: {
  user: CurrentUser
  workspace?: Row<'workspaces'> | null
  now?: Date
}): AgentAmbientContext {
  const now = input.now ?? new Date()
  const timezone = runtimeTimezone()
  return {
    nowIso: now.toISOString(),
    localDate: formatLocalDate(now, timezone),
    timezone,
    userDisplayName: input.user.display_name ?? input.user.email ?? null,
    workspaceName: input.workspace?.name ?? null,
  }
}

export function formatChineseLocalDate(localDate: string) {
  const [year, month, day] = localDate.split('-')
  if (!year || !month || !day) return localDate
  return `${Number(year)} 年 ${Number(month)} 月 ${Number(day)} 日`
}
