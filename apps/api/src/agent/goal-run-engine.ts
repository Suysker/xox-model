import type { AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { createGoalContract, serializeEvaluation } from './goal-contract.js'
import { evaluateAgentGoal } from './completion-evaluator.js'
import {
  consolidateAgentMemoryCandidates,
  consolidateExecutedActionMemory,
  flushThreadContextToMemoryIfNeeded,
} from './memory-kernel.js'
import {
  memoryCandidateFromCompletedGoal,
  memoryCandidateFromEvaluatorFinding,
} from './memory-candidate-detector.js'
import { planResponse } from './planner.js'
import { addRunEvent } from './run-events.js'
import { addMessage } from './thread-store.js'
import { continueModelAfterToolObservations } from './tool-observation-continuation.js'

export type AgentGoalRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
}

function evaluationSummary(evaluation: ReturnType<typeof serializeEvaluation>) {
  if (evaluation.status === 'pass') return 'Completion Evaluator 已确认当前目标满足验收条件。'
  if (evaluation.status === 'needs_confirmation') return 'Completion Evaluator 已暂停后续规划，等待用户处理确认卡。'
  if (evaluation.status === 'continue') return 'Completion Evaluator 发现仍有未满足项，已准备下一轮修复规划。'
  if (evaluation.status === 'blocked') return `Completion Evaluator 已阻断目标：${evaluation.blocker ?? '存在策略阻断。'}`
  if (evaluation.status === 'failed') return `Completion Evaluator 判定目标失败：${evaluation.blocker ?? '存在失败步骤。'}`
  return 'Completion Evaluator 需要补充信息。'
}

export async function executeAgentGoalRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgentGoalRunResult | null> {
  const goal = await createGoalContract({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    objective: ctx.message,
    automationLevel: ctx.automationLevel,
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'goal_contract_created',
    title: '目标契约已建立',
    message: 'Goal Run Engine 已建立目标契约，后续会用 Completion Evaluator 判定是否完成。',
    status: 'info',
    data: { goalId: goal.id, maxIterations: JSON.parse(goal.contract_json).maxIterations },
  })

  let plannerSource: AgentPlannerSource = 'rules'
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const assistantParts: string[] = []
  let nextMessage = ctx.message
  const maxIterations = Math.max(1, Math.min(8, Number(JSON.parse(goal.contract_json).maxIterations ?? 5)))

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'goal_iteration_started',
      title: `目标循环 ${iteration}`,
      message: iteration === 1 ? '开始第一轮模型规划。' : '根据 evaluator findings 开始下一轮修复规划。',
      status: 'running',
      data: { goalId: goal.id, iteration },
    })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'model_planning',
      title: '模型规划中',
      message: '正在调用配置的模型，并等待 provider-native tool calls。',
      status: 'running',
      data: { provider: ctx.settings.llmProvider, iteration },
    })

    const planned = await planResponse({ ...ctx, message: nextMessage, planningTurn: iteration === 1 ? 'user_objective' : 'evaluator_repair' })
    if (!(await options.beforeStateWrite())) return null
    plannerSource = planned.plannerSource
    navigationEvents.push(...planned.navigationEvents)
    actionRows.push(...planned.actionRows)
    planRows.push(...planned.planRows)
    if (planned.assistantText?.trim()) {
      assistantParts.push(planned.assistantText.trim())
    } else if (planned.observations.length > 0 && planned.actionRows.every((row) => row.status !== 'pending')) {
      const continuation = await continueModelAfterToolObservations(ctx, planned.observations)
      if (!(await options.beforeStateWrite())) return null
      if (continuation.status === 'answered') {
        assistantParts.push(continuation.assistantText.trim())
      } else if (continuation.status === 'failed') {
        planRows.push(continuation.planStep)
      }
    }

    const evaluationRow = await evaluateAgentGoal({
      db: ctx.db,
      workspace: ctx.workspace,
      goal,
      iteration,
    })
    if (!(await options.beforeStateWrite())) return null
    const evaluation = serializeEvaluation(evaluationRow)
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'goal_evaluated',
      title: 'Completion Evaluator 已运行',
      message: evaluationSummary(evaluation),
      status:
        evaluation.status === 'pass'
          ? 'completed'
          : evaluation.status === 'needs_confirmation'
            ? 'blocked'
            : evaluation.status === 'continue'
              ? 'running'
              : evaluation.status === 'blocked' || evaluation.status === 'failed'
                ? 'failed'
                : 'info',
      data: {
        goalId: goal.id,
        iteration,
        evaluationStatus: evaluation.status,
        satisfiedCriteria: evaluation.satisfiedCriteria,
        unsatisfiedCount: evaluation.unsatisfiedCriteria.length,
        nextPlannerBrief: evaluation.nextPlannerBrief,
      },
    })
    const evaluatorCandidate = memoryCandidateFromEvaluatorFinding({ runId: ctx.runId, evaluation: evaluationRow })
    if (evaluatorCandidate) {
      await consolidateAgentMemoryCandidates({
        db: ctx.db,
        workspace: ctx.workspace,
        user: ctx.user,
        threadId: ctx.thread.id,
        runId: ctx.runId,
        candidates: [evaluatorCandidate],
        title: 'Evaluator 发现已进入记忆候选',
        message: 'Completion Evaluator 的未满足项已作为带证据的流程记忆候选保存。',
      })
    }
    if (evaluation.status === 'pass' && actionRows.length > 0) {
      const updatedGoal = await ctx.db.selectFrom('agent_goals').selectAll().where('id', '=', goal.id).executeTakeFirst()
      if (updatedGoal) {
        await consolidateAgentMemoryCandidates({
          db: ctx.db,
          workspace: ctx.workspace,
          user: ctx.user,
          threadId: ctx.thread.id,
          runId: ctx.runId,
          candidates: [memoryCandidateFromCompletedGoal({ goal: updatedGoal })],
          title: '完成目标已进入记忆候选',
          message: '本轮完成目标已保存为带证据的情节记忆候选，供后续同工作区任务召回。',
        })
      }
    }

    if (evaluation.status === 'pass' || evaluation.status === 'needs_confirmation' || evaluation.status === 'blocked' || evaluation.status === 'failed') {
      break
    }
    if (evaluation.status === 'continue' && evaluation.nextPlannerBrief) {
      nextMessage = `${evaluation.nextPlannerBrief}\n\n原始目标：${ctx.message}`
      continue
    }
    break
  }

  await consolidateExecutedActionMemory({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    actionRows,
    message: `已从本轮执行结果沉淀记忆候选。`,
  })
  const assistantMessage = assistantParts.length > 0
    ? await addMessage(ctx.db, ctx.thread.id, 'assistant', assistantParts.join('\n\n'))
    : null
  await flushThreadContextToMemoryIfNeeded({ db: ctx.db, workspace: ctx.workspace, user: ctx.user, threadId: ctx.thread.id, runId: ctx.runId })
  if (!(await options.beforeStateWrite())) return null
  return {
    plannerSource,
    assistantMessage,
    navigationEvents,
    actionRows,
    planRows,
  }
}
