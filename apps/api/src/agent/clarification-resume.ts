import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { parseJson } from '../db/database.js'
import { redactSecretLikeContent } from './memory.js'

type ResumeContextInput = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  thread: Row<'agent_threads'>
  runId: string
  message: string
}

export type ClarificationResumeContext = {
  resumedGoalId: string
  resumedRunId: string
  objective: string
}

type FindingLike = {
  message?: string
}

function clarificationQuestion(step: Row<'agent_plan_steps'> | undefined) {
  if (!step) return null
  const args = parseJson<any>(step.tool_arguments_json, null)
  if (typeof args?.question === 'string' && args.question.trim()) return args.question.trim()
  return step.description.trim() || null
}

function pendingActionSummary(actions: Row<'agent_action_requests'>[]) {
  const pendingCount = actions.filter((action) => action.status === 'pending').length
  if (pendingCount <= 0) return '上一轮没有已保留的待确认写入卡。'
  return `上一轮已有 ${pendingCount} 张待确认写入卡，继续保留，不要重复生成。`
}

export async function buildClarificationResumeContext(input: ResumeContextInput): Promise<ClarificationResumeContext | null> {
  const previousGoal = await input.db
    .selectFrom('agent_goals')
    .selectAll()
    .where('thread_id', '=', input.thread.id)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('run_id', '!=', input.runId)
    .where('status', '=', 'needs_clarification')
    .orderBy('updated_at', 'desc')
    .executeTakeFirst()

  if (!previousGoal) return null

  const [latestEvaluation, latestClarificationStep, previousActions] = await Promise.all([
    input.db
      .selectFrom('agent_evaluations')
      .selectAll()
      .where('goal_id', '=', previousGoal.id)
      .orderBy('iteration_no', 'desc')
      .executeTakeFirst(),
    input.db
      .selectFrom('agent_plan_steps')
      .selectAll()
      .where('run_id', '=', previousGoal.run_id)
      .where('title', '=', '需要补充信息')
      .orderBy('sequence_no', 'desc')
      .executeTakeFirst(),
    input.db
      .selectFrom('agent_action_requests')
      .selectAll()
      .where('run_id', '=', previousGoal.run_id)
      .orderBy('created_at', 'asc')
      .execute(),
  ])

  const findings = latestEvaluation
    ? parseJson<FindingLike[]>(latestEvaluation.unsatisfied_json, [])
    : []
  const question = clarificationQuestion(latestClarificationStep)
  const openFindings = findings
    .map((finding) => typeof finding.message === 'string' ? finding.message.trim() : '')
    .filter((message) => message.length > 0)
  const missingLine = openFindings.length > 0
    ? `本轮只补齐上一轮仍未满足的事实或执行结果：${openFindings.join('；')}。`
    : '本轮补齐上一轮澄清问题依赖的业务动作。'

  const objective = [
    '继续上一轮等待澄清的 Agent 目标。',
    `用户本轮补充：${redactSecretLikeContent(input.message).trim()}`,
    question ? `上一轮澄清问题：${redactSecretLikeContent(question)}` : null,
    missingLine,
    pendingActionSummary(previousActions),
    '同一线程历史里有原始目标和上一轮模型输出，只用于解析指代；不要重复已有确认卡。',
    '所有写入仍必须生成可编辑确认卡；如果补充后仍缺少必要信息，继续调用 ask_user_clarification。',
  ].filter((line): line is string => Boolean(line && line.trim())).join('\n')

  return {
    resumedGoalId: previousGoal.id,
    resumedRunId: previousGoal.run_id,
    objective,
  }
}
