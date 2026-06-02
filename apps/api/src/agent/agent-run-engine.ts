import type { AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { createGoalContract, serializeEvaluation, updateGoalStatus } from './goal-contract.js'
import { evaluateAgentGoal } from './completion-evaluator.js'
import {
  consolidateAgentMemoryCandidates,
  consolidateExecutedActionMemory,
  flushThreadContextToMemoryIfNeeded,
} from './memory-kernel.js'
import { runMemoryDreamingSweep } from './memory/dreaming-worker.js'
import {
  memoryCandidateFromCompletedGoal,
  memoryCandidateFromEvaluatorFinding,
} from './memory-candidate-detector.js'
import { planResponse } from './planner.js'
import { addRunEvent } from './run-events.js'
import { addMessage } from './thread-store.js'
import { continueModelAfterToolObservations, type AgentToolObservation } from './tool-observation-continuation.js'
import { buildClarificationResumeContext } from './clarification-resume.js'
import { evaluateToolLoopGuardrails } from './tool-runtime/tool-loop-guardrails.js'
import { resolveAfterEvaluation, resolveAfterPlanning } from './turn-resolver.js'

export type AgentRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus | null
}

function evaluationSummary(evaluation: ReturnType<typeof serializeEvaluation>) {
  if (evaluation.status === 'pass') return 'Completion Evaluator 已确认当前目标满足验收条件。'
  if (evaluation.status === 'needs_confirmation') return 'Completion Evaluator 已暂停后续规划，等待用户处理确认卡。'
  if (evaluation.status === 'needs_clarification') return 'Completion Evaluator 已暂停后续规划，等待用户补充信息。'
  if (evaluation.status === 'continue') return 'Completion Evaluator 发现仍有未满足项，已准备下一轮修复规划。'
  if (evaluation.status === 'blocked') return `Completion Evaluator 已阻断目标：${evaluation.blocker ?? '存在策略阻断。'}`
  if (evaluation.status === 'failed') return `Completion Evaluator 判定目标失败：${evaluation.blocker ?? '存在失败步骤。'}`
  return 'Completion Evaluator 需要补充信息。'
}

function observationContinuationMessage(objective: string) {
  return [
    '继续完成当前目标。',
    '上一轮工具结果是已完成事实：不要把工具返回直接当成最终回答；也不要重复已经完成的只读查询或已创建的确认卡。',
    '如果还缺少可验证事实，继续调用合适工具；如果事实已足够，输出面向用户的最终回答。',
    `当前目标：${objective}`,
  ].join('\n\n')
}

function shouldContinueObservationInMainLoop(observations: AgentToolObservation[]) {
  return observations.some((observation) =>
    observation.toolName === 'data_query_workspace' ||
    observation.toolName === 'sandbox_run_code')
}

export async function executeAgentRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'> },
  options: { beforeStateWrite: () => Promise<boolean> },
): Promise<AgentRunResult | null> {
  const resumeContext = await buildClarificationResumeContext({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    thread: ctx.thread,
    runId: ctx.runId,
    message: ctx.message,
  })
  const objective = resumeContext?.objective ?? ctx.message
  const planningCtx = { ...ctx, message: objective }
  const goal = await createGoalContract({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    objective,
    automationLevel: ctx.automationLevel,
  })
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'goal_contract_created',
    title: '目标契约已建立',
    message: 'AgentRunEngine 已建立目标契约，后续会用 Completion Evaluator 判定是否完成。',
    status: 'info',
    data: { goalId: goal.id, maxIterations: JSON.parse(goal.contract_json).maxIterations },
  })
  if (resumeContext) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'clarification_resume_context',
      title: '澄清目标已续接',
      message: '本轮用户消息已作为上一轮待澄清目标的补充信息进入 AgentRunEngine。',
      status: 'info',
      data: {
        goalId: goal.id,
        resumedGoalId: resumeContext.resumedGoalId,
        resumedRunId: resumeContext.resumedRunId,
      },
    })
  }

  let plannerSource: AgentPlannerSource = 'rules'
  const navigationEvents: AgentNavigationEvent[] = []
  const actionRows: Row<'agent_action_requests'>[] = []
  const planRows: Row<'agent_plan_steps'>[] = []
  const assistantParts: string[] = []
  const observations: AgentToolObservation[] = []
  let nextMessage = objective
  let pendingAssistantText: string | null = null
  let lastEvaluation: ReturnType<typeof serializeEvaluation> | null = null
  let waitingForAssistantFromObservations = false
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

    const planned = await planResponse({
      ...planningCtx,
      message: nextMessage,
      planningTurn: iteration === 1 && !resumeContext ? 'user_objective' : 'evaluator_repair',
      priorObservations: iteration === 1 ? [] : observations,
    })
    if (!(await options.beforeStateWrite())) return null
    const priorObservations = observations.slice()
    plannerSource = planned.plannerSource
    navigationEvents.push(...planned.navigationEvents)
    actionRows.push(...planned.actionRows)
    planRows.push(...planned.planRows)
    observations.push(...planned.observations)
    pendingAssistantText = planned.assistantText?.trim() || null
    const assistantOnlyNoGraph =
      Boolean(pendingAssistantText) &&
      planned.actionRows.length === 0 &&
      planned.planRows.length === 0 &&
      planned.observations.length === 0
    if (assistantOnlyNoGraph && lastEvaluation?.status === 'continue') {
      const reason = '模型连续返回纯文本，但当前目标仍缺少必要的工具调用或确认卡。'
      await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: reason })
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'tool_loop_guardrail',
        title: '工具调用缺失',
        message: reason,
        status: 'failed',
        data: {
          goalId: goal.id,
          iteration,
          previousEvaluationStatus: lastEvaluation.status,
          previousUnsatisfiedCount: lastEvaluation.unsatisfiedCriteria.length,
        },
      })
      assistantParts.push(reason)
      break
    }
    const guardrailFindings = evaluateToolLoopGuardrails({
      iteration,
      priorObservations,
      newObservations: planned.observations,
      planRows: planned.planRows,
      actionRows: planned.actionRows,
    })
    for (const finding of guardrailFindings) {
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'tool_loop_guardrail',
        title: finding.severity === 'block' ? '工具循环已阻断' : '工具循环检查',
        message: finding.repairBrief,
        status: finding.severity === 'block' ? 'failed' : 'info',
        data: {
          goalId: goal.id,
          iteration,
          finding,
        },
      })
    }
    const planningNextStep = resolveAfterPlanning({
      pendingAssistantText,
      actionRows: planned.actionRows,
      planRows: planned.planRows,
      observations: planned.observations,
      guardrailFindings,
    })
    if (planningNextStep.type === 'failed') {
      await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: planningNextStep.reason })
      if (assistantParts.length === 0) assistantParts.push(planningNextStep.reason)
      break
    }
    if (planningNextStep.type === 'final_output') {
      if (planningNextStep.assistantText?.trim()) assistantParts.push(planningNextStep.assistantText.trim())
      break
    }

    const evaluationRow = await evaluateAgentGoal({
      db: ctx.db,
      workspace: ctx.workspace,
      goal,
      iteration,
    })
    if (!(await options.beforeStateWrite())) return null
    const evaluation = serializeEvaluation(evaluationRow)
    lastEvaluation = evaluation
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
    if (evaluatorCandidate && (evaluation.status === 'blocked' || evaluation.status === 'failed')) {
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
      const completedGoalCandidate = updatedGoal ? memoryCandidateFromCompletedGoal({ goal: updatedGoal }) : null
      if (completedGoalCandidate) {
        await consolidateAgentMemoryCandidates({
          db: ctx.db,
          workspace: ctx.workspace,
          user: ctx.user,
          threadId: ctx.thread.id,
          runId: ctx.runId,
          candidates: [completedGoalCandidate],
          title: '完成目标已进入记忆候选',
          message: '本轮完成目标中提取到稳定记忆候选，已按记忆门禁保存。',
        })
      }
    }

    const evaluationNextStep = resolveAfterEvaluation({
      evaluation,
      objective,
      pendingAssistantText,
      observations,
      actionRows,
      newObservationCount: planned.observations.length,
    })
    if (
      evaluationNextStep.type === 'final_output' ||
      evaluationNextStep.type === 'await_confirmation' ||
      evaluationNextStep.type === 'await_clarification' ||
      evaluationNextStep.type === 'blocked' ||
      evaluationNextStep.type === 'failed'
    ) {
      if (evaluationNextStep.type === 'final_output' && evaluationNextStep.assistantText?.trim()) {
        assistantParts.push(evaluationNextStep.assistantText.trim())
      } else if (pendingAssistantText && observations.length === 0) {
        assistantParts.push(pendingAssistantText)
      }
      break
    }
    if (evaluationNextStep.type === 'continue_with_observations') {
      if (!shouldContinueObservationInMainLoop(evaluationNextStep.observations)) {
        break
      }
      if (iteration >= maxIterations) {
        const reason = '工具观察已经产生，但模型没有在主循环预算内生成最终回答。'
        await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: reason })
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'goal_iteration_exhausted',
          title: '目标循环已耗尽',
          message: reason,
          status: 'failed',
          data: {
            goalId: goal.id,
            maxIterations,
            observationCount: observations.length,
          },
        })
        if (assistantParts.length === 0) assistantParts.push(reason)
        break
      }
      waitingForAssistantFromObservations = true
      nextMessage = observationContinuationMessage(objective)
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'observation_continuation_requested',
        title: '继续基于工具结果规划',
        message: '工具结果已作为 observation 回到 AgentRunEngine，下一轮仍可继续调用工具或生成最终回复。',
        status: 'running',
        data: {
          goalId: goal.id,
          iteration,
          observationCount: evaluationNextStep.observations.length,
          toolNames: evaluationNextStep.observations.map((observation) => observation.toolName),
        },
      })
      continue
    }
    if (evaluationNextStep.type === 'run_again') {
      waitingForAssistantFromObservations = false
      nextMessage = evaluationNextStep.nextMessage
      continue
    }
    break
  }

  if (lastEvaluation?.status === 'continue') {
    const blockedReason = lastEvaluation.nextPlannerBrief ?? '目标修复循环已耗尽，但仍有未满足项。'
    await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'goal_iteration_exhausted',
      title: '目标循环已耗尽',
      message: `Agent 已达到本轮最大修复次数，但目标仍未完成：${blockedReason}`,
      status: 'failed',
      data: {
        goalId: goal.id,
        maxIterations,
        evaluationStatus: lastEvaluation.status,
        unsatisfiedCount: lastEvaluation.unsatisfiedCriteria.length,
      },
    })
    if (assistantParts.length === 0) {
      assistantParts.push(`这轮没有完成所有目标：${blockedReason}`)
    }
  } else if (assistantParts.length === 0 && observations.length > 0 && waitingForAssistantFromObservations) {
    const reason = '模型已经取得工具观察结果，但没有生成面向用户的最终回答。'
    await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: reason })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'assistant_final_message_missing',
      title: '最终回复缺失',
      message: reason,
      status: 'failed',
      data: { goalId: goal.id, observationCount: observations.length },
    })
    assistantParts.push(reason)
  } else if (assistantParts.length === 0 && observations.length > 0) {
    const continuation = await continueModelAfterToolObservations(planningCtx, observations)
    if (!(await options.beforeStateWrite())) return null
    if (continuation.status === 'answered') {
      assistantParts.push(continuation.assistantText.trim())
    } else if (continuation.status === 'failed') {
      planRows.push(continuation.planStep)
      const evaluationRow = await evaluateAgentGoal({
        db: ctx.db,
        workspace: ctx.workspace,
        goal,
        iteration: maxIterations + 1,
      })
      const evaluation = serializeEvaluation(evaluationRow)
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'goal_evaluated',
        title: 'Completion Evaluator 已运行',
        message: evaluationSummary(evaluation),
        status: evaluation.status === 'failed' || evaluation.status === 'blocked' ? 'failed' : 'info',
        data: {
          goalId: goal.id,
          iteration: maxIterations + 1,
          evaluationStatus: evaluation.status,
          satisfiedCriteria: evaluation.satisfiedCriteria,
          unsatisfiedCount: evaluation.unsatisfiedCriteria.length,
          nextPlannerBrief: evaluation.nextPlannerBrief,
        },
      })
    }
  } else if (assistantParts.length === 0 && pendingAssistantText) {
    assistantParts.push(pendingAssistantText)
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
  const dreamReport = await runMemoryDreamingSweep({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
  })
  if (dreamReport) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'memory_dreaming_reported',
      title: '记忆整理报告已生成',
      message: dreamReport.summary,
      status: 'info',
      data: {
        dreamReportId: dreamReport.id,
        candidateIds: JSON.parse(dreamReport.candidate_ids_json),
        source: 'openclaw_dreaming_sweep',
      },
    })
  }
  const finalGoal = await ctx.db.selectFrom('agent_goals').select('status').where('id', '=', goal.id).executeTakeFirst()
  if (!(await options.beforeStateWrite())) return null
  return {
    plannerSource,
    assistantMessage,
    navigationEvents,
    actionRows,
    planRows,
    goalStatus: finalGoal?.status as AgentGoalStatus | null ?? null,
  }
}
