import type {
  AgentActionKind,
  AgentAutomationLevel,
  AgentNavigationEvent,
  AgentPlanStepStatus,
  AgentToolObservationLane,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type {
  AgentHostToolActionDraft,
  AgentHostToolObservation,
  AgentHostToolPlannedItem,
  AgentHostToolPlannedItemResult,
  AgentHostToolReadDraft,
  AgentHostToolResultHandler,
  AgentHostToolResultHandlers,
} from '@agentic-os/core'
import type { Database, Row } from '../../db/schema.js'
import type { Settings } from '../../core/settings.js'
import type { CurrentUser } from '../../modules/auth.js'
import type { AgentToolCallStep } from '../tool-catalog.js'
import type { ParsedWorkspaceBundleArtifact } from '../workspace-bundle-artifact.js'

export type AgentActionDraft = AgentHostToolActionDraft<AgentActionKind, AgentNavigationEvent>

export type ReadDraft = AgentHostToolReadDraft<
  AgentNavigationEvent,
  AgentPlanStepStatus,
  AgentToolObservationLane
>

export type XoxToolObservation = AgentHostToolObservation & {
  status: 'completed' | 'failed' | 'cancelled' | 'not_executed' | 'invalid'
  lane?: AgentToolObservationLane
}

export type AgentToolObservation = XoxToolObservation

export type AgentTurnContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  priorObservations?: AgentToolObservation[]
  automationLevel: AgentAutomationLevel
  abortSignal?: AbortSignal
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}

export type PlannedItem = AgentHostToolPlannedItem<AgentActionDraft, ReadDraft>

export type RuntimeToolStep = AgentToolCallStep

export type PlannedItemResult = AgentHostToolPlannedItemResult<AgentActionDraft, ReadDraft>

const XOX_NAVIGATION_MAIN_TABS = new Set(['dashboard', 'inputs', 'bookkeeping', 'variance'])

export function xoxNavigationFromTabs(input: { mainTab: unknown; secondaryTab: unknown }): AgentNavigationEvent | null {
  if (typeof input.mainTab !== 'string' || !XOX_NAVIGATION_MAIN_TABS.has(input.mainTab)) return null
  return {
    type: 'navigation',
    route: {
      mainTab: input.mainTab as AgentNavigationEvent['route']['mainTab'],
      ...(typeof input.secondaryTab === 'string' ? { secondaryTab: input.secondaryTab as never } : {}),
    },
    reason: '用户要求切换工作台页面。',
  }
}

export type ActionDraftHandler<TContext> = AgentHostToolResultHandler<
  TContext,
  RuntimeToolStep,
  AgentActionDraft,
  ReadDraft
>
export type ActionDraftBuilderHandlers<TContext> = AgentHostToolResultHandlers<
  TContext,
  RuntimeToolStep,
  AgentActionDraft,
  ReadDraft
>
