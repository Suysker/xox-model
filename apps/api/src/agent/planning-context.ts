import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import type { Settings } from '../core/settings.js'
import type { CurrentUser } from '../modules/auth.js'
import type { ParsedWorkspaceBundleArtifact } from './workspace-bundle-artifact.js'
import type { AgentAutomationLevel } from './tool-policy.js'
import type { AgentToolObservation } from './tool-observation-continuation.js'
import type { AgentLoopObligationPlan } from './loop-obligation-ledger.js'
import type { AgentGoalFacts } from '@xox/contracts'

export type PlannerContext = {
  db: Kysely<Database>
  settings: Settings
  user: CurrentUser
  workspace: Row<'workspaces'>
  threadId: string
  runId: string
  message: string
  planningTurn?: 'user_objective' | 'evaluator_repair'
  priorObservations?: AgentToolObservation[]
  loopObligationPlan?: AgentLoopObligationPlan
  goalFacts?: AgentGoalFacts
  automationLevel: AgentAutomationLevel
  abortSignal?: AbortSignal
  providedWorkspaceBundle?: ParsedWorkspaceBundleArtifact
}
