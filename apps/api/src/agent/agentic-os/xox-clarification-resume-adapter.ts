import type {
  ClarificationResumeScaffoldCopy,
} from '@agentic-os/core'
import { buildClarificationResumeScaffold } from '@agentic-os/core'
import type { Kysely } from 'kysely'
import { parseJson } from '../../db/database.js'
import type { Database, Row } from '../../db/schema.js'
import type { CurrentUser } from '../../modules/auth.js'
import { redactSecretLikeContent } from '../memory.js'
import type { AgentToolCapability } from '../tool-catalog.js'

type ResumeContextInput = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  thread: Row<'agent_threads'>
  runId: string
  message: string
}

export type XoxClarificationResumeContext = {
  resumedGoalId: string
  resumedRunId: string
  objective: string
  satisfiedActionCapabilities: AgentToolCapability[]
}

type FindingLike = {
  message?: string
}

const XOX_CLARIFICATION_RESUME_COPY = {
  heading: '继续上一轮等待澄清的 Agent 目标。',
  userSupplement: (message) => `用户本轮补充：${message}`,
  previousQuestion: (question) => `上一轮澄清问题：${question}`,
  openFindings: (findings) =>
    `本轮只补齐上一轮仍未满足的事实或执行结果：${findings.join('；')}。`,
  noOpenFindings: '本轮补齐上一轮澄清问题依赖的业务动作。',
  pendingActions: (count) =>
    `上一轮已有 ${count} 张待确认写入卡，继续保留，不要重复生成。`,
  noPendingActions: '上一轮没有已保留的待确认写入卡。',
  historyInstruction:
    '同一线程历史里有原始目标和上一轮模型输出，只用于解析指代；不要重复已有确认卡。',
  continuationInstruction:
    '所有写入仍必须生成可编辑确认卡；如果补充后仍缺少必要信息，继续调用 ask_user_clarification。',
} satisfies ClarificationResumeScaffoldCopy

function clarificationQuestion(step: Row<'agent_plan_steps'> | undefined) {
  if (!step) return null
  const args = parseJson<any>(step.tool_arguments_json, null)
  if (typeof args?.question === 'string' && args.question.trim()) return args.question.trim()
  return step.description.trim() || null
}

function pendingActionCount(actions: Row<'agent_action_requests'>[]) {
  return actions.filter((action) => action.status === 'pending').length
}

function actionCapability(action: Row<'agent_action_requests'>): AgentToolCapability | null {
  if (action.kind === 'workspace.update_draft' || action.kind === 'workspace.rename') return 'draft'
  if (action.kind.startsWith('ledger.')) return 'ledger'
  if (action.kind.startsWith('share.')) return 'share'
  if (action.kind === 'workspace.import_bundle') return 'import_export'
  if (
    action.kind === 'workspace.save_snapshot' ||
    action.kind === 'workspace.publish_release' ||
    action.kind === 'workspace.promote_version' ||
    action.kind === 'workspace.rollback_version' ||
    action.kind === 'workspace.delete_version' ||
    action.kind === 'workspace.reset_draft'
  ) {
    return 'version'
  }
  return null
}

function satisfiedActionCapabilities(actions: Row<'agent_action_requests'>[]): AgentToolCapability[] {
  return [...new Set(actions
    .filter((action) => action.status === 'executed' || action.status === 'pending')
    .map(actionCapability)
    .filter((capability): capability is AgentToolCapability => capability !== null))]
}

export async function buildXoxClarificationResumeContext(
  input: ResumeContextInput,
): Promise<XoxClarificationResumeContext | null> {
  let previousGoal = await input.db
    .selectFrom('agent_goals')
    .selectAll()
    .where('thread_id', '=', input.thread.id)
    .where('workspace_id', '=', input.workspace.id)
    .where('user_id', '=', input.user.id)
    .where('run_id', '!=', input.runId)
    .where('status', '=', 'needs_clarification')
    .orderBy('updated_at', 'desc')
    .executeTakeFirst()

  previousGoal ??= await input.db
    .selectFrom('agent_goals')
    .innerJoin('agent_evaluations', 'agent_evaluations.goal_id', 'agent_goals.id')
    .selectAll('agent_goals')
    .where('agent_goals.thread_id', '=', input.thread.id)
    .where('agent_goals.workspace_id', '=', input.workspace.id)
    .where('agent_goals.user_id', '=', input.user.id)
    .where('agent_goals.run_id', '!=', input.runId)
    .where('agent_evaluations.status', '=', 'needs_clarification')
    .orderBy('agent_evaluations.created_at', 'desc')
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
  const scaffold = buildClarificationResumeScaffold({
    userMessage: input.message,
    clarificationQuestion: clarificationQuestion(latestClarificationStep),
    openFindingMessages: findings.map((finding) => finding.message),
    pendingActionCount: pendingActionCount(previousActions),
    redactor: redactSecretLikeContent,
    copy: XOX_CLARIFICATION_RESUME_COPY,
  })

  return {
    resumedGoalId: previousGoal.id,
    resumedRunId: previousGoal.run_id,
    objective: scaffold.objective,
    satisfiedActionCapabilities: satisfiedActionCapabilities(previousActions),
  }
}
