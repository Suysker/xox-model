import type { AgentGoalFacts, AgentGoalStatus, AgentNavigationEvent, AgentPlannerSource } from '@xox/contracts'
import type { Row } from '../db/schema.js'
import type { PlannerContext } from './planning-context.js'
import { createGoalContract, serializeEvaluation, updateGoalStatus } from './goal-contract.js'
import { evaluateAgentGoal } from './loop-readiness-check.js'
import { buildEvidenceLedger, type AgentEvidenceItem } from './evidence-ledger.js'
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
import { isRepairableToolObservation } from './tool-observation-outcome.js'
import { buildClarificationResumeContext } from './clarification-resume.js'
import { evaluateToolLoopGuardrails } from './tool-runtime/tool-loop-guardrails.js'
import { resolveAfterEvaluation, resolveAfterPlanning } from './turn-resolver.js'
import { evaluateAssistantResponse, responseEvaluationSummary } from './response-evaluator.js'
import { mergeAgentGoalFacts, readRuntimeGoalFacts } from './runtime-goal-facts.js'
import { extractFinalAnswerClaims } from './final-answer-claim-extractor.js'
import { configuredRuntimePlannerSource } from './runtime-plan-reader.js'
import { runPrerequisiteObservations } from './prerequisite-observations.js'
import {
  applyObservationToLedger,
  applyResponseEvaluationToLedger,
  canAttemptFinalAnswer,
  hasOpenNonFinalAnswerObligations,
  initializeObligationLedger,
  ledgerToObligationPlan,
  serializeObligationLedger,
  userSafeLedgerFailureSummary,
} from './loop-obligation-ledger.js'

export type AgentRunResult = {
  plannerSource: AgentPlannerSource
  assistantMessage: Row<'agent_messages'> | null
  navigationEvents: AgentNavigationEvent[]
  actionRows: Row<'agent_action_requests'>[]
  planRows: Row<'agent_plan_steps'>[]
  goalStatus: AgentGoalStatus | null
}

function loopReadinessSummary(evaluation: ReturnType<typeof serializeEvaluation>) {
  if (evaluation.status === 'pass') return 'Loop Readiness Check 已确认运行图可进入最终回答证据检查。'
  if (evaluation.status === 'needs_confirmation') return 'Loop Readiness Check 已暂停后续规划，等待用户处理确认卡。'
  if (evaluation.status === 'needs_clarification') return 'Loop Readiness Check 已暂停后续规划，等待用户补充信息。'
  if (evaluation.status === 'continue') return 'Loop Readiness Check 发现仍有未满足项，已准备下一轮修复规划。'
  if (evaluation.status === 'blocked') return `Loop Readiness Check 已阻断目标：${evaluation.blocker ?? '存在策略阻断。'}`
  if (evaluation.status === 'failed') return `Loop Readiness Check 判定运行图失败：${evaluation.blocker ?? '存在失败步骤。'}`
  return 'Loop Readiness Check 需要补充信息。'
}

type FinalAnswerDecision =
  | { status: 'pass'; assistantText: string }
  | { status: 'interrupt'; assistantText: string | null }
  | { status: 'continue' }
  | { status: 'failed'; reason: string }

function shouldContinueObservationInMainLoop(observations: AgentToolObservation[]) {
  return observations.some((observation) =>
    observation.toolName === 'data_query_workspace' ||
    observation.toolName === 'sandbox_run_code' ||
    isRepairableToolObservation(observation))
}

function hasRepairableToolObservations(observations: AgentToolObservation[]) {
  return observations.some(isRepairableToolObservation)
}

function parseObservationModelContent(observation: AgentToolObservation) {
  try {
    const parsed = JSON.parse(observation.modelContent)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function shouldUseAssistantContinuationAfterObservation(observations: AgentToolObservation[]) {
  return observations.some((observation) => {
    if (observation.toolName === 'sandbox_run_code') return true
    const facts = parseObservationModelContent(observation)
    return facts?.observationType === 'action_result'
  })
}

function evidenceHasValidSandbox(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) => item.authority === 'sandbox' && item.validity === 'valid')
}

function evidenceHasOrderedShareholderFacts(evidence: AgentEvidenceItem[]) {
  return evidence.some((item) => {
    if (item.authority !== 'domain_read' || item.validity !== 'valid') return false
    const facts = item.facts
    return Object.prototype.hasOwnProperty.call(facts, 'firstShareholder') ||
      Object.prototype.hasOwnProperty.call(facts, 'shareholders')
  })
}

function goalContractFacts(goal: Row<'agent_goals'>): AgentGoalFacts {
  try {
    const contract = JSON.parse(goal.contract_json)
    return contract && typeof contract === 'object' ? contract.facts ?? {} : {}
  } catch {
    return {}
  }
}

function shouldRunFinalAnswerClaimReview(input: {
  assistantText: string | null
  pendingActionCount: number
  awaitingClarification: boolean
  preReviewEvaluation: ReturnType<typeof evaluateAssistantResponse>
  evidence: AgentEvidenceItem[]
  goalFacts: AgentGoalFacts
}) {
  if (!input.assistantText?.trim()) return false
  if (input.pendingActionCount > 0 || input.awaitingClarification) return false
  if (input.preReviewEvaluation.status !== 'pass') return false
  // ADR 0039: claim review is an optional aid, not a hot-path completion gate.
  // When structured goal facts already required and satisfied the evidence,
  // do not add another provider call before completing the run.
  if (input.goalFacts.requiresSandboxComputation || input.goalFacts.requiresOrderedEntityFacts) {
    const sandboxSatisfied = !input.goalFacts.requiresSandboxComputation || evidenceHasValidSandbox(input.evidence)
    const entitySatisfied = !input.goalFacts.requiresOrderedEntityFacts || evidenceHasOrderedShareholderFacts(input.evidence)
    if (sandboxSatisfied && entitySatisfied) return false
  }
  if (input.evidence.length === 0) return true
  if (evidenceHasValidSandbox(input.evidence)) return !evidenceHasOrderedShareholderFacts(input.evidence)
  return false
}

export async function executeAgentRun(
  ctx: PlannerContext & { thread: Row<'agent_threads'>; initialGoalFacts?: AgentGoalFacts | null },
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
  const goal = await createGoalContract({
    db: ctx.db,
    workspace: ctx.workspace,
    user: ctx.user,
    threadId: ctx.thread.id,
    runId: ctx.runId,
    objective,
    automationLevel: ctx.automationLevel,
    goalFacts: ctx.initialGoalFacts ?? null,
  })
  const planningCtx = { ...ctx, message: objective, goalFacts: goalContractFacts(goal) ?? null }
  await addRunEvent(ctx.db, {
    threadId: ctx.thread.id,
    runId: ctx.runId,
    type: 'goal_contract_created',
    title: '目标契约已建立',
    message: 'AgentRunEngine 已建立目标契约，后续由 Loop Readiness Check 判断运行图是否可进入最终回答检查。',
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
  const maxIterations = Math.max(1, Math.min(8, Number(JSON.parse(goal.contract_json).maxIterations ?? 5)))
  const obligationLedger = initializeObligationLedger({ runId: ctx.runId })
  const initialPrerequisites = await runPrerequisiteObservations(planningCtx, {
    goalFacts: goalContractFacts(goal),
    observations,
    plannerSource: configuredRuntimePlannerSource(ctx.settings) ?? plannerSource,
  })
  if (!(await options.beforeStateWrite())) return null
  if (initialPrerequisites) {
    plannerSource = initialPrerequisites.plannerSource
    navigationEvents.push(...initialPrerequisites.navigationEvents)
    actionRows.push(...initialPrerequisites.actionRows)
    planRows.push(...initialPrerequisites.planRows)
    observations.push(...initialPrerequisites.observations)
  }

  const evaluateFinalAssistant = async (
    assistantText: string | null,
    iteration: number,
  ): Promise<FinalAnswerDecision> => {
    const evidence = buildEvidenceLedger({
      threadId: ctx.thread.id,
      runId: ctx.runId,
      observations,
    })
    const runtimeFacts = await readRuntimeGoalFacts(ctx.db, ctx.runId)
    const goalFacts = mergeAgentGoalFacts(goalContractFacts(goal), runtimeFacts)
    const pendingActionCount = actionRows.filter((action) => action.status === 'pending').length
    const awaitingClarification = lastEvaluation?.status === 'needs_clarification'
    const preReviewEvaluation = evaluateAssistantResponse({
      goal,
      finalAssistantText: assistantText,
      observations,
      evidence,
      runtimeFacts,
      finalAnswerClaims: [],
      pendingActionCount,
      awaitingClarification,
    })
    const claimExtraction = shouldRunFinalAnswerClaimReview({
      assistantText,
      pendingActionCount,
      awaitingClarification,
      preReviewEvaluation,
      evidence,
      goalFacts,
    })
      ? await extractFinalAnswerClaims({
          db: ctx.db,
          settings: ctx.settings,
          workspace: ctx.workspace,
          user: ctx.user,
          threadId: ctx.thread.id,
          runId: ctx.runId,
          message: objective,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        }, {
          finalAssistantText: assistantText,
          evidence,
        })
      : assistantText?.trim()
        ? { status: 'skipped' as const, reason: 'deterministic_evidence_satisfied' as const }
        : null
    const finalAnswerClaims = claimExtraction?.status === 'completed' ? claimExtraction.claims : []
    const responseEvaluation = claimExtraction?.status === 'completed'
      ? evaluateAssistantResponse({
          goal,
          finalAssistantText: assistantText,
          observations,
          evidence,
          runtimeFacts,
          finalAnswerClaims,
          pendingActionCount,
          awaitingClarification,
        })
      : preReviewEvaluation
    applyResponseEvaluationToLedger({
      ledger: obligationLedger,
      evaluation: responseEvaluation,
      iteration,
    })
    const obligationPlan = ledgerToObligationPlan({ ledger: obligationLedger, objective })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'response_evaluated',
      title: '最终回答证据检查',
      message: responseEvaluationSummary(responseEvaluation),
      status:
        responseEvaluation.status === 'pass'
          ? 'completed'
          : responseEvaluation.status === 'blocked'
            ? 'failed'
            : 'running',
      data: {
        goalId: goal.id,
        iteration,
        evaluationStatus: responseEvaluation.status,
        confidence: responseEvaluation.confidence,
        evidenceCount: evidence.length,
        evidence: evidence.map((item) => ({
          id: item.id,
          authority: item.authority,
          source: item.source,
          subject: item.subject,
          summary: item.summary,
        })),
        findings: responseEvaluation.findings,
        requiredEvidence: responseEvaluation.requiredEvidence,
        finalAnswerClaims,
        claimReviewStatus: claimExtraction?.status ?? null,
        claimReviewReason: claimExtraction?.status === 'unavailable' ? claimExtraction.reason : null,
        obligationLedger: serializeObligationLedger(obligationLedger),
        obligationPlan,
        nextPlannerBrief: responseEvaluation.nextPlannerBrief,
      },
    })

    if (responseEvaluation.status === 'pass' && assistantText?.trim()) {
      await updateGoalStatus(ctx.db, goal, 'completed')
      return { status: 'pass', assistantText: assistantText.trim() }
    }
    if (responseEvaluation.status === 'awaiting_confirmation' || responseEvaluation.status === 'awaiting_clarification') {
      return { status: 'interrupt', assistantText: assistantText?.trim() || null }
    }
    if (
      responseEvaluation.status === 'needs_calculation' ||
      responseEvaluation.status === 'needs_more_evidence' ||
      responseEvaluation.status === 'needs_final_answer'
    ) {
      return { status: 'continue' }
    }
    const reason = responseEvaluation.findings.find((finding) => finding.severity === 'fail')?.message ?? '最终回答证据检查失败。'
    await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: reason })
    return { status: 'failed', reason }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'goal_iteration_started',
      title: `目标循环 ${iteration}`,
      message: iteration === 1 ? '开始第一轮模型规划。' : '根据 readiness findings 开始下一轮修复规划。',
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

    const loopObligationPlan = ledgerToObligationPlan({ ledger: obligationLedger, objective })
    const prerequisiteResult = await runPrerequisiteObservations(planningCtx, {
      goalFacts: goalContractFacts(goal),
      ...(loopObligationPlan ? { obligationPlan: loopObligationPlan } : {}),
      observations,
      plannerSource: configuredRuntimePlannerSource(ctx.settings) ?? plannerSource,
    })
    if (!(await options.beforeStateWrite())) return null
    if (prerequisiteResult) {
      plannerSource = prerequisiteResult.plannerSource
      navigationEvents.push(...prerequisiteResult.navigationEvents)
      actionRows.push(...prerequisiteResult.actionRows)
      planRows.push(...prerequisiteResult.planRows)
      observations.push(...prerequisiteResult.observations)
      for (const observation of prerequisiteResult.observations) {
        applyObservationToLedger({ ledger: obligationLedger, observation, iteration })
      }
    }
    const planned = await planResponse({
      ...planningCtx,
      message: nextMessage,
      planningTurn: iteration === 1 && !resumeContext ? 'user_objective' : 'evaluator_repair',
      priorObservations: observations,
      ...(loopObligationPlan ? { loopObligationPlan } : {}),
    })
    if (!(await options.beforeStateWrite())) return null
    const priorObservations = observations.slice()
    plannerSource = planned.plannerSource
    navigationEvents.push(...planned.navigationEvents)
    actionRows.push(...planned.actionRows)
    planRows.push(...planned.planRows)
    observations.push(...planned.observations)
    for (const observation of planned.observations) {
      applyObservationToLedger({ ledger: obligationLedger, observation, iteration })
    }
    pendingAssistantText = planned.assistantText?.trim() || null
    const assistantOnlyNoGraph =
      Boolean(pendingAssistantText) &&
      planned.actionRows.length === 0 &&
      planned.planRows.length === 0 &&
      planned.observations.length === 0
    const blockedByOpenObligations =
      assistantOnlyNoGraph &&
      priorObservations.length > 0 &&
      !canAttemptFinalAnswer(obligationLedger)
    if (blockedByOpenObligations) {
      if (iteration >= maxIterations) {
        const safeSummary = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
        await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: safeSummary })
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'obligation_final_candidate_blocked',
          title: '最终回答候选被阻断',
          message: safeSummary,
          status: 'failed',
          data: {
            goalId: goal.id,
            iteration,
            obligationLedger: serializeObligationLedger(obligationLedger),
          },
        })
        if (assistantParts.length === 0) assistantParts.push(safeSummary)
        break
      }
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'obligation_final_candidate_deferred',
        title: '最终回答候选已延后',
        message: '仍有 runner-owned obligation 未关闭，本轮纯文本不会作为最终回答，下一轮继续取得必要 observation。',
        status: 'running',
        data: {
          goalId: goal.id,
          iteration,
          obligationLedger: serializeObligationLedger(obligationLedger),
        },
      })
      nextMessage = objective
      continue
    }
    const hasFinalAssistantCandidate = assistantOnlyNoGraph && priorObservations.length > 0
    if (hasFinalAssistantCandidate) {
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'final_answer_candidate',
        title: '最终回答候选已生成',
        message: '模型已基于本轮 observation 生成最终回答候选，进入 response evaluation。',
        status: 'running',
        channel: 'assistant',
        data: {
          goalId: goal.id,
          iteration,
          priorObservationCount: priorObservations.length,
        },
      })
    }
    if (assistantOnlyNoGraph && lastEvaluation?.status === 'continue' && !hasFinalAssistantCandidate) {
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
      hasFinalAssistantCandidate,
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
      hasFinalAssistantCandidate,
    })
    if (planningNextStep.type === 'failed') {
      await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: planningNextStep.reason })
      if (assistantParts.length === 0) assistantParts.push(planningNextStep.reason)
      break
    }
    if (planningNextStep.type === 'final_output') {
      const finalDecision = await evaluateFinalAssistant(planningNextStep.assistantText?.trim() ?? null, iteration)
      if (finalDecision.status === 'pass') {
        assistantParts.push(finalDecision.assistantText)
        break
      }
      if (finalDecision.status === 'interrupt') {
        if (finalDecision.assistantText) assistantParts.push(finalDecision.assistantText)
        break
      }
      if (finalDecision.status === 'failed') {
        if (assistantParts.length === 0) assistantParts.push(finalDecision.reason)
        break
      }
      if (iteration >= maxIterations) {
        const safeSummary = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
        await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: safeSummary })
        if (assistantParts.length === 0) assistantParts.push(safeSummary)
        break
      }
      nextMessage = objective
      continue
    }

    const evaluationRow = await evaluateAgentGoal({
      db: ctx.db,
      workspace: ctx.workspace,
      goal,
      iteration,
      allowComplete: false,
    })
    if (!(await options.beforeStateWrite())) return null
    const evaluation = serializeEvaluation(evaluationRow)
    lastEvaluation = evaluation
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'goal_evaluated',
      title: 'Loop Readiness Check 已运行',
      message: loopReadinessSummary(evaluation),
      status:
        evaluation.status === 'pass'
          ? 'running'
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
        title: 'Readiness 发现已进入记忆候选',
        message: 'Loop Readiness Check 的未满足项已作为带证据的流程记忆候选保存。',
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
      if (evaluationNextStep.type === 'final_output') {
        const finalDecision = await evaluateFinalAssistant(evaluationNextStep.assistantText?.trim() ?? null, iteration)
        if (finalDecision.status === 'pass') {
          assistantParts.push(finalDecision.assistantText)
          break
        }
        if (finalDecision.status === 'interrupt') {
          if (finalDecision.assistantText) assistantParts.push(finalDecision.assistantText)
          break
        }
        if (finalDecision.status === 'failed') {
          if (assistantParts.length === 0) assistantParts.push(finalDecision.reason)
          break
        }
        if (iteration >= maxIterations) {
          const safeSummary = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
          await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: safeSummary })
          if (assistantParts.length === 0) assistantParts.push(safeSummary)
          break
        }
        nextMessage = objective
        continue
      } else if (pendingAssistantText && observations.length === 0) {
        assistantParts.push(pendingAssistantText)
      }
      break
    }
    if (evaluationNextStep.type === 'continue_with_observations') {
      if (!shouldContinueObservationInMainLoop(evaluationNextStep.observations)) {
        break
      }
      if (
        canAttemptFinalAnswer(obligationLedger) &&
        !hasRepairableToolObservations(evaluationNextStep.observations) &&
        shouldUseAssistantContinuationAfterObservation(evaluationNextStep.observations)
      ) {
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'observation_assistant_continuation_requested',
          title: '基于工具结果生成回复',
          message: '工具 observation 已满足当前 runner obligations，下一步用无工具 assistant continuation 生成最终回答候选。',
          status: 'running',
          data: {
            goalId: goal.id,
            iteration,
            observationCount: observations.length,
            toolNames: evaluationNextStep.observations.map((observation) => observation.toolName),
          },
        })
        const continuation = await continueModelAfterToolObservations(planningCtx, observations)
        if (!(await options.beforeStateWrite())) return null
        if (continuation.status === 'answered') {
          await addRunEvent(ctx.db, {
            threadId: ctx.thread.id,
            runId: ctx.runId,
            type: 'final_answer_candidate',
            title: '最终回答候选已生成',
            message: '模型已基于工具 observation 生成最终回答候选，进入 response evaluation。',
            status: 'running',
            channel: 'assistant',
            data: {
              goalId: goal.id,
              iteration,
              priorObservationCount: observations.length,
              continuation: true,
            },
          })
          const finalDecision = await evaluateFinalAssistant(continuation.assistantText.trim(), iteration)
          if (finalDecision.status === 'pass') {
            assistantParts.push(finalDecision.assistantText)
            break
          }
          if (finalDecision.status === 'interrupt') {
            if (finalDecision.assistantText) assistantParts.push(finalDecision.assistantText)
            break
          }
          if (finalDecision.status === 'failed') {
            if (assistantParts.length === 0) assistantParts.push(finalDecision.reason)
            break
          }
        } else if (continuation.status === 'failed') {
          planRows.push(continuation.planStep)
        }
        if (iteration >= maxIterations) {
          const safeSummary = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
          await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: safeSummary })
          if (assistantParts.length === 0) assistantParts.push(safeSummary)
          break
        }
        nextMessage = objective
        continue
      }
      if (iteration >= maxIterations) {
        await addRunEvent(ctx.db, {
          threadId: ctx.thread.id,
          runId: ctx.runId,
          type: 'goal_iteration_exhausted',
          title: '目标循环已耗尽',
          message: '工具观察已经产生，主循环预算已耗尽，改由最终回复通道基于 evidence 生成回答。',
          status: 'running',
          data: {
            goalId: goal.id,
            maxIterations,
            observationCount: observations.length,
          },
        })
        break
      }
      nextMessage = objective
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
      nextMessage = evaluationNextStep.nextMessage
      continue
    }
    break
  }

  if (assistantParts.length === 0 && hasOpenNonFinalAnswerObligations(obligationLedger)) {
    const blockedReason = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
    await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'obligation_iteration_exhausted',
      title: 'Obligation Ledger 未关闭',
      message: blockedReason,
      status: 'failed',
      data: {
        goalId: goal.id,
        maxIterations,
        obligationLedger: serializeObligationLedger(obligationLedger),
      },
    })
    assistantParts.push(blockedReason)
  } else if (lastEvaluation?.status === 'continue') {
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
  } else if (assistantParts.length === 0 && hasRepairableToolObservations(observations)) {
    const blockedReason = userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
    await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason })
    await addRunEvent(ctx.db, {
      threadId: ctx.thread.id,
      runId: ctx.runId,
      type: 'repairable_observation_unresolved',
      title: '工具反馈未完成修复',
      message: blockedReason,
      status: 'failed',
      data: {
        goalId: goal.id,
        maxIterations,
        repairableToolNames: observations.filter(isRepairableToolObservation).map((observation) => observation.toolName),
      },
    })
    assistantParts.push(blockedReason)
  } else if (
    assistantParts.length === 0 &&
    observations.length > 0 &&
    !hasRepairableToolObservations(observations)
  ) {
    const continuation = await continueModelAfterToolObservations(planningCtx, observations)
    if (!(await options.beforeStateWrite())) return null
    if (continuation.status === 'answered') {
      const finalDecision = await evaluateFinalAssistant(continuation.assistantText.trim(), maxIterations + 1)
      if (finalDecision.status === 'pass') {
        assistantParts.push(finalDecision.assistantText)
      } else if (finalDecision.status === 'interrupt') {
        if (finalDecision.assistantText) assistantParts.push(finalDecision.assistantText)
      } else {
        const reason = finalDecision.status === 'failed'
          ? finalDecision.reason
          : userSafeLedgerFailureSummary({ ledger: obligationLedger, objective })
        await updateGoalStatus(ctx.db, goal, 'failed', { blockedReason: reason })
        assistantParts.push(reason)
      }
    } else if (continuation.status === 'failed') {
      planRows.push(continuation.planStep)
      const evaluationRow = await evaluateAgentGoal({
        db: ctx.db,
        workspace: ctx.workspace,
        goal,
        iteration: maxIterations + 1,
        allowComplete: false,
      })
      const evaluation = serializeEvaluation(evaluationRow)
      await addRunEvent(ctx.db, {
        threadId: ctx.thread.id,
        runId: ctx.runId,
        type: 'goal_evaluated',
        title: 'Loop Readiness Check 已运行',
        message: loopReadinessSummary(evaluation),
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
