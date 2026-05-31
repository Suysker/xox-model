import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'

export type AgentTurnLane = 'direct_answer' | 'agent_goal'

export type AgentTurnIntakeResolution = {
  lane: AgentTurnLane
  reason: string
}

const DIRECT_EXACT_MESSAGES = new Set([
  '你好',
  '您好',
  '嗨',
  'hi',
  'hello',
  '在吗',
  '你是谁',
  '告诉我你是谁',
  '你能做什么',
  '这个系统能做什么',
  '你能帮我做哪些事',
])

const DOMAIN_GOAL_HINTS = [
  '成员',
  '员工',
  '股东',
  '工作区',
  '模型',
  '记账',
  '入账',
  '账本',
  '回本',
  '利润',
  '收入',
  '成本',
  '预测',
  '测算',
  '发布',
  '恢复',
  '分享',
  '版本',
  '确认卡',
  '保存',
  '修改',
  '新增',
  '删除',
  '导入',
  '导出',
]

function normalizeMessage(message: string) {
  return message.replace(/\s+/g, ' ').trim()
}

function hasDomainGoalHint(message: string) {
  const lower = message.toLowerCase()
  return DOMAIN_GOAL_HINTS.some((hint) => lower.includes(hint.toLowerCase()))
}

function isDateOrTimeQuestion(message: string) {
  const text = message.toLowerCase()
  return (
    (text.includes('今天') && (text.includes('几月几号') || text.includes('日期') || text.includes('星期'))) ||
    text.includes('今天是几号') ||
    text.includes('今天几号') ||
    text.includes('现在几点') ||
    text.includes('当前时间') ||
    text.includes('current date') ||
    text.includes('current time') ||
    text.includes('what date is it') ||
    text.includes('what time is it')
  )
}

async function hasPendingAction(input: {
  db: Kysely<Database>
  thread: Row<'agent_threads'>
  workspace: Row<'workspaces'>
  user: CurrentUser
}) {
  const pending = await input.db
    .selectFrom('agent_action_requests')
    .select('id')
    .where('thread_id', '=', input.thread.id)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('status', '=', 'pending')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

async function hasPendingClarification(input: {
  db: Kysely<Database>
  thread: Row<'agent_threads'>
}) {
  const pending = await input.db
    .selectFrom('agent_goals')
    .select('id')
    .where('thread_id', '=', input.thread.id)
    .where('status', '=', 'needs_clarification')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return Boolean(pending)
}

function directAnswerReason(message: string): string | null {
  const normalized = normalizeMessage(message)
  if (!normalized) return null
  if (normalized.length > 80) return null
  if (hasDomainGoalHint(normalized)) return null
  if (DIRECT_EXACT_MESSAGES.has(normalized) || DIRECT_EXACT_MESSAGES.has(normalized.toLowerCase())) {
    return 'ordinary_chat'
  }
  if (isDateOrTimeQuestion(normalized)) return 'ambient_session_fact'
  return null
}

export async function resolveTurnIntake(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  thread: Row<'agent_threads'>
  message: string
}): Promise<AgentTurnIntakeResolution> {
  if (await hasPendingAction(input)) {
    return { lane: 'agent_goal', reason: 'pending_action_requires_goal_harness' }
  }
  if (await hasPendingClarification(input)) {
    return { lane: 'agent_goal', reason: 'pending_clarification_requires_goal_harness' }
  }
  const reason = directAnswerReason(input.message)
  return reason
    ? { lane: 'direct_answer', reason }
    : { lane: 'agent_goal', reason: 'requires_goal_harness_or_uncertain' }
}
