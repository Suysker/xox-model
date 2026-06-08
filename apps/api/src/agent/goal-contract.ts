import type {
  AgentAutomationLevel,
  AgentEvaluationFinding,
  AgentEvaluationResult,
  AgentEvaluationStatus,
  AgentGoalContract,
  AgentGoalFacts,
  AgentGoalRecord,
  AgentGoalStatus,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { jsonString, parseJson } from '../db/database.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { CurrentUser } from '../modules/auth.js'
import { sanitizeAgentGoalFacts } from './runtime-goal-facts.js'

const DEFAULT_GOAL_PAGES: AgentGoalContract['scope']['pages'] = ['model', 'ledger', 'variance', 'versions', 'share']
const DEFAULT_CAPABILITIES = ['data', 'draft', 'import_export', 'ledger', 'memory', 'share', 'version']

function defaultCriteria(): AgentGoalContract['acceptanceCriteria'] {
  return [
    {
      id: 'policy.no_forbidden_actions',
      label: '没有越权或账号类自动动作',
      description: 'Agent 不得自动执行账号影响、跨工作区、锁账违规、派生分录直接编辑等禁止动作。',
      kind: 'policy',
      required: true,
    },
    {
      id: 'graph.visible_steps',
      label: '运行图可见',
      description: '每轮规划、只读观察、确认卡、执行和 readiness findings 必须写入服务端运行图。',
      kind: 'action_graph',
      required: true,
    },
    {
      id: 'graph.write_actions_have_cards',
      label: '写入动作有确认卡',
      description: '所有写入动作必须先创建可编辑确认卡；任何自动化级别都不能绕过用户确认。',
      kind: 'action_graph',
      required: true,
    },
    {
      id: 'domain.executed_actions_match_outcome',
      label: '执行结果落到领域状态',
      description: '已执行写入必须能在工作区草稿、账本、版本、分享或审计结果中被验证。',
      kind: 'domain',
      required: true,
    },
    {
      id: 'domain.goal_facts_match_outcome',
      label: '原始目标事实已满足',
      description: '复杂目标中的成员数量、预测周期、工作区名称、禁止发布等硬事实必须从领域状态和运行图中验证。',
      kind: 'domain',
      required: true,
    },
    {
      id: 'context.memory_scoped',
      label: '记忆作用域正确',
      description: '注入和沉淀的记忆必须限定在当前用户、工作区和线程允许范围内。',
      kind: 'context',
      required: true,
    },
  ]
}

export function buildInitialGoalContract(input: {
  goalId: string
  threadId: string
  runId: string
  workspace: Row<'workspaces'>
  user: CurrentUser
  objective: string
  automationLevel: AgentAutomationLevel
  goalFacts?: AgentGoalFacts | null
}): AgentGoalContract {
  return {
    goalId: input.goalId,
    threadId: input.threadId,
    runId: input.runId,
    userId: input.user.id,
    workspaceId: input.workspace.id,
    objective: input.objective,
    scope: {
      workspace: 'current',
      pages: DEFAULT_GOAL_PAGES,
      allowedCapabilities: DEFAULT_CAPABILITIES,
    },
    acceptanceCriteria: defaultCriteria(),
    facts: sanitizeAgentGoalFacts(input.goalFacts),
    forbiddenActions: [
      {
        id: 'account.manual_only',
        label: '账号动作只能手动完成',
        reason: '登录、退出、注销、删除账号、改密码等账号影响动作不进入 Agent 自动执行面。',
      },
      {
        id: 'tenant.current_workspace_only',
        label: '只能操作当前工作区',
        reason: '模型和 memory 不能选择或扩大 userId/workspaceId。',
      },
    ],
    humanCheckpoints: [],
    automationLevel: input.automationLevel,
    maxIterations: 5,
    contextStrategy: {
      memoryScopes: ['user', 'workspace', 'thread'],
      compactionMode: 'summary',
    },
  }
}

export function serializeGoal(row: Row<'agent_goals'>): AgentGoalRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    status: normalizeGoalStatus(row.status) ?? 'failed',
    contract: parseJson<AgentGoalContract>(row.contract_json, {
      goalId: row.id,
      threadId: row.thread_id,
      runId: row.run_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      objective: row.objective,
      scope: { workspace: 'current', pages: DEFAULT_GOAL_PAGES, allowedCapabilities: DEFAULT_CAPABILITIES },
      acceptanceCriteria: defaultCriteria(),
      facts: {},
      forbiddenActions: [],
      humanCheckpoints: [],
      automationLevel: 'manual',
      maxIterations: 5,
      contextStrategy: { memoryScopes: ['user', 'workspace', 'thread'], compactionMode: 'summary' },
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    blockedReason: row.blocked_reason,
  }
}

export function serializeEvaluation(row: Row<'agent_evaluations'>): AgentEvaluationResult {
  return {
    id: row.id,
    goalId: row.goal_id,
    threadId: row.thread_id,
    runId: row.run_id,
    iteration: row.iteration_no,
    status: normalizeEvaluationStatus(row.status),
    confidence: row.confidence,
    satisfiedCriteria: parseJson<string[]>(row.satisfied_json, []),
    unsatisfiedCriteria: parseJson<AgentEvaluationFinding[]>(row.unsatisfied_json, []),
    policyFindings: parseJson<AgentEvaluationFinding[]>(row.policy_json, []),
    nextPlannerBrief: row.next_planner_brief,
    userQuestion: row.user_question,
    blocker: row.blocker,
    createdAt: row.created_at,
  }
}

export function normalizeGoalStatus(value: string | null): AgentGoalStatus | null {
  if (
    value === 'interpreting' ||
    value === 'planning' ||
    value === 'waiting_for_confirmation' ||
    value === 'evaluating' ||
    value === 'repairing' ||
    value === 'completed' ||
    value === 'needs_clarification' ||
    value === 'blocked' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  return null
}

function normalizeEvaluationStatus(value: string): AgentEvaluationStatus {
  if (
    value === 'pass' ||
    value === 'continue' ||
    value === 'needs_confirmation' ||
    value === 'needs_clarification' ||
    value === 'blocked' ||
    value === 'failed'
  ) {
    return value
  }
  return 'failed'
}

export async function createGoalContract(input: {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
  objective: string
  automationLevel: AgentAutomationLevel
  goalFacts?: AgentGoalFacts | null
}) {
  const goalId = newId()
  const now = utcNow()
  const contract = buildInitialGoalContract({ ...input, goalId })
  await input.db
    .insertInto('agent_goals')
    .values({
      id: goalId,
      thread_id: input.threadId,
      run_id: input.runId,
      workspace_id: input.workspace.id,
      user_id: input.user.id,
      status: 'planning',
      objective: input.objective,
      contract_json: jsonString(contract),
      created_at: now,
      updated_at: now,
      completed_at: null,
      blocked_reason: null,
    })
    .execute()
  await input.db.updateTable('agent_runs').set({ goal_status: 'planning' }).where('id', '=', input.runId).execute()
  return input.db.selectFrom('agent_goals').selectAll().where('id', '=', goalId).executeTakeFirstOrThrow()
}

export async function getGoalForRun(db: Kysely<Database>, runId: string) {
  return db.selectFrom('agent_goals').selectAll().where('run_id', '=', runId).orderBy('created_at', 'desc').executeTakeFirst()
}

export async function updateGoalStatus(
  db: Kysely<Database>,
  goal: Row<'agent_goals'>,
  status: AgentGoalStatus,
  input: { blockedReason?: string | null } = {},
) {
  const now = utcNow()
  await db
    .updateTable('agent_goals')
    .set({
      status,
      updated_at: now,
      completed_at: status === 'completed' || status === 'blocked' || status === 'failed' || status === 'cancelled' ? now : goal.completed_at,
      blocked_reason: input.blockedReason ?? goal.blocked_reason,
    })
    .where('id', '=', goal.id)
    .execute()
  await db.updateTable('agent_runs').set({ goal_status: status }).where('id', '=', goal.run_id).execute()
  return db.selectFrom('agent_goals').selectAll().where('id', '=', goal.id).executeTakeFirstOrThrow()
}

export async function addEvaluationResult(
  db: Kysely<Database>,
  goal: Row<'agent_goals'>,
  input: Omit<AgentEvaluationResult, 'id' | 'goalId' | 'threadId' | 'runId' | 'createdAt'>,
) {
  const id = newId()
  await db
    .insertInto('agent_evaluations')
    .values({
      id,
      goal_id: goal.id,
      thread_id: goal.thread_id,
      run_id: goal.run_id,
      iteration_no: input.iteration,
      status: input.status,
      confidence: input.confidence,
      satisfied_json: jsonString(input.satisfiedCriteria),
      unsatisfied_json: jsonString(input.unsatisfiedCriteria),
      policy_json: jsonString(input.policyFindings),
      next_planner_brief: input.nextPlannerBrief,
      user_question: input.userQuestion,
      blocker: input.blocker,
      created_at: utcNow(),
    })
    .execute()
  return db.selectFrom('agent_evaluations').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
