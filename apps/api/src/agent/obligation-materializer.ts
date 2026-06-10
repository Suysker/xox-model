import type { AgentPlannerSource } from '@xox/contracts'
import type { PlannerContext } from './planning-context.js'
import {
  activeLedgerObligations,
  type AgentLoopLedgerObligation,
  type AgentLoopObligationLedger,
} from './loop-obligation-ledger.js'
import { answerWorkspaceDataQuestion, type DataAgentQueryStep } from './data-agent.js'
import { storePlannedActionGraph, type StoredActionGraph } from './action-graph-store.js'
import { addRunEvent } from './run-events.js'

export type ObligationMaterializationCache = Set<string>

function stableTaskKey(obligation: AgentLoopLedgerObligation, toolArguments: Record<string, unknown>) {
  return [
    obligation.id,
    obligation.kind,
    obligation.toolNames.slice().sort().join(','),
    JSON.stringify(toolArguments),
  ].join(':')
}

function dataQueryArguments(obligation: AgentLoopLedgerObligation): DataAgentQueryStep | null {
  if (obligation.kind !== 'domain_fact') return null
  if (!obligation.toolNames.includes('data_query_workspace')) return null
  const scope = obligation.requiredDataScopes?.[0] ?? 'workspace_summary'
  const metrics = obligation.requiredMetrics ?? []
  return {
    question: obligation.reason,
    scope,
    ...(metrics.length > 0 ? { metrics } : {}),
  }
}

async function materializeDataObservation(input: {
  ctx: PlannerContext
  obligation: AgentLoopLedgerObligation
  plannerSource: AgentPlannerSource
}) {
  const toolArguments = dataQueryArguments(input.obligation)
  if (!toolArguments) return null

  const read = await answerWorkspaceDataQuestion(input.ctx, toolArguments)
  if (!read) {
    return storePlannedActionGraph(input.ctx, {
      plannerSource: input.plannerSource,
      emitPlanReady: false,
      items: [{
        title: 'Runner observation failed',
        message: 'The required data observation could not be produced.',
        readKind: 'tool_observation',
        toolName: 'data_query_workspace',
        toolCallId: `runner_obligation_${input.ctx.runId}_${input.obligation.id}`,
        toolArguments: toolArguments as Record<string, unknown>,
        modelContent: JSON.stringify({
          observationType: 'runner_obligation_failure',
          status: 'failed',
          obligationId: input.obligation.id,
          reason: 'data_observation_unavailable',
          toolName: 'data_query_workspace',
          toolArguments,
        }),
        displayPreview: 'The required data observation could not be produced.',
        observationLane: 'runner_obligation',
        observationStatus: 'failed',
        observationOutcome: 'failed_repairable',
        status: 'failed',
      }],
    })
  }

  return storePlannedActionGraph(input.ctx, {
    plannerSource: input.plannerSource,
    emitPlanReady: false,
    items: [{
      ...read,
      toolName: 'data_query_workspace',
      toolCallId: `runner_obligation_${input.ctx.runId}_${input.obligation.id}`,
      toolArguments: toolArguments as Record<string, unknown>,
      observationLane: 'runner_obligation',
    }],
  })
}

export async function materializeLoopObligations(input: {
  ctx: PlannerContext
  ledger: AgentLoopObligationLedger
  plannerSource: AgentPlannerSource
  taskCache: ObligationMaterializationCache
}): Promise<StoredActionGraph | null> {
  const graphs: StoredActionGraph[] = []

  for (const obligation of activeLedgerObligations(input.ledger)) {
    const toolArguments = dataQueryArguments(obligation)
    if (!toolArguments) continue
    const taskKey = stableTaskKey(obligation, toolArguments as Record<string, unknown>)
    if (input.taskCache.has(taskKey)) continue
    input.taskCache.add(taskKey)

    await addRunEvent(input.ctx.db, {
      threadId: input.ctx.threadId,
      runId: input.ctx.runId,
      type: 'runner_obligation_materializing',
      title: 'Runner observation task',
      message: 'A required evidence obligation is being materialized as a model-visible observation.',
      status: 'running',
      data: {
        obligationId: obligation.id,
        obligationKind: obligation.kind,
        toolName: 'data_query_workspace',
        toolArguments,
      },
    })

    const graph = await materializeDataObservation({
      ctx: input.ctx,
      obligation,
      plannerSource: input.plannerSource,
    })
    if (graph) graphs.push(graph)
  }

  if (graphs.length === 0) return null

  await addRunEvent(input.ctx.db, {
    threadId: input.ctx.threadId,
    runId: input.ctx.runId,
    type: 'runner_obligation_materialized',
    title: 'Runner observation materialized',
    message: `${graphs.reduce((sum, graph) => sum + graph.observations.length, 0)} required observation(s) were materialized for model replay.`,
    status: graphs.some((graph) => graph.observations.some((observation) => observation.status === 'failed')) ? 'failed' : 'completed',
    data: {
      observationCount: graphs.reduce((sum, graph) => sum + graph.observations.length, 0),
      toolNames: [...new Set(graphs.flatMap((graph) => graph.observations.map((observation) => observation.toolName)))],
    },
  })

  return {
    assistantText: null,
    observations: graphs.flatMap((graph) => graph.observations),
    navigationEvents: graphs.flatMap((graph) => graph.navigationEvents),
    actionRows: graphs.flatMap((graph) => graph.actionRows),
    planRows: graphs.flatMap((graph) => graph.planRows),
    plannerSource: graphs.at(-1)?.plannerSource ?? input.plannerSource,
  }
}
