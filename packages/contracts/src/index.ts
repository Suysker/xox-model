import type { ModelConfig, ModelResult } from '@xox/domain'

export type AuthUser = {
  id: string
  email: string
  displayName: string
  status: string
}

export type DraftResponse = {
  workspaceId: string
  workspaceName: string
  revision: number
  config: ModelConfig
  result: ModelResult
  lastAutosavedAt: string | null
}

export type VersionShareResponse = {
  id: string
  versionId: string
  shareToken: string
  sharePath: string
  createdAt: string
  updatedAt: string
}

export type VersionResponse = {
  id: string
  name: string
  kind: 'snapshot' | 'release'
  versionNo: number
  sourceVersionId: string | null
  createdAt: string
  config: ModelConfig
  activeShare: VersionShareResponse | null
}

export type PeriodResponse = {
  id: string
  monthIndex: number
  monthLabel: string
  status: string
  baselineVersionId: string | null
  baselineVersionName: string | null
  plannedRevenue: number
  plannedCost: number
  actualRevenue: number
  actualCost: number
}

export type SubjectResponse = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  subjectGroup: string
  entityType?: string | null
  entityId?: string | null
  plannedAmount: number
}

export type EntryAllocation = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  amount: number
}

export type EntryResponse = {
  id: string
  ledgerPeriodId: string
  direction: 'income' | 'expense'
  amount: number
  occurredAt: string
  postedAt: string | null
  counterparty: string | null
  description: string | null
  relatedEntityType?: 'teamMember' | 'employee' | null
  relatedEntityId?: string | null
  relatedEntityName?: string | null
  sourceEntryId?: string | null
  entryOrigin?: 'manual' | 'derived' | string
  derivedKind?: string | null
  status: string
  allocations: EntryAllocation[]
}

export type VarianceLine = {
  subjectKey: string
  subjectName: string
  subjectType: 'revenue' | 'cost'
  plannedAmount: number
  actualAmount: number
  varianceAmount: number
  varianceRate: number | null
}

export type VarianceResponse = {
  periodId: string
  monthLabel: string
  baselineVersionId: string | null
  baselineVersionName: string | null
  lines: VarianceLine[]
  plannedRevenue: number
  plannedCost: number
  actualRevenue: number
  actualCost: number
  revenueVarianceAmount: number
  revenueVarianceRate: number | null
  costVarianceAmount: number
  costVarianceRate: number | null
  cumulativePlannedRevenue: number
  cumulativePlannedCost: number
  cumulativeActualRevenue: number
  cumulativeActualCost: number
  cumulativeRevenueVarianceAmount: number
  cumulativeRevenueVarianceRate: number | null
  cumulativeCostVarianceAmount: number
  cumulativeCostVarianceRate: number | null
}

export type PublicShareResponse = {
  shareId: string
  shareToken: string
  workspaceId: string
  workspaceName: string
  versionId: string
  versionName: string
  versionNo: number
  versionKind: 'release'
  createdAt: string
  sharedAt: string
  config: ModelConfig
  result: ModelResult
}

export type AgentRoute =
  | { mainTab: 'dashboard'; secondaryTab?: 'overview' | 'months' | 'members'; selectedPeriodId?: string | null }
  | { mainTab: 'inputs'; secondaryTab?: 'capital' | 'revenue' | 'cost'; selectedPeriodId?: string | null }
  | { mainTab: 'bookkeeping'; secondaryTab?: 'entries'; selectedPeriodId?: string | null }
  | { mainTab: 'variance'; secondaryTab?: 'analysis'; selectedPeriodId?: string | null }

export type AgentNavigationEvent = {
  type: 'navigation'
  route: AgentRoute
  panel?: 'workspace' | null
  focusRecordId?: string | null
  reason: string
}

export type AgentActionKind =
  | 'ledger.create_entry'
  | 'ledger.update_entry'
  | 'ledger.void_entry'
  | 'ledger.restore_entry'
  | 'ledger.lock_period'
  | 'ledger.unlock_period'
  | 'workspace.update_draft'
  | 'workspace.save_snapshot'
  | 'workspace.publish_release'
  | 'workspace.rollback_version'
  | 'workspace.delete_version'
  | 'workspace.reset_draft'
  | 'workspace.import_bundle'
  | 'share.create'
  | 'share.revoke'

export type AgentActionRequestStatus = 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed'

export type AgentActionRequest = {
  id: string
  threadId: string
  runId: string
  kind: AgentActionKind
  status: AgentActionRequestStatus
  title: string
  summary: string
  targetLabel: string
  riskLevel: 'low' | 'medium' | 'high'
  details: Array<{ label: string; value: string }>
  navigation: AgentNavigationEvent
  payload: unknown
  createdAt: string
  executedAt: string | null
  errorMessage: string | null
}

export type AgentPlanStepStatus = 'pending' | 'ready' | 'executed' | 'cancelled' | 'failed' | 'info'

export type AgentPlanStep = {
  id: string
  threadId: string
  runId: string
  actionRequestId: string | null
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  navigation: AgentNavigationEvent | null
  createdAt: string
  updatedAt: string
}

export type AgentMessage = {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export type AgentPlannerSource = 'openai_agents' | 'openai_compatible_tool_calls' | 'rules'

export type AgentRunRecord = {
  id: string
  threadId: string
  status: 'running' | 'completed' | 'failed'
  planner: AgentPlannerSource | null
  createdAt: string
  completedAt: string | null
}

export type AgentThreadSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  lastMessage: string | null
  lastMessageAt: string | null
  latestRunStatus: AgentRunRecord['status'] | null
  planner: AgentPlannerSource | null
  pendingActionCount: number
}

export type AgentThreadState = {
  thread: AgentThreadSummary
  messages: AgentMessage[]
  runs: AgentRunRecord[]
  planner: AgentPlannerSource | null
  navigationEvents: AgentNavigationEvent[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
}

export type AgentMemoryRecord = {
  id: string
  workspaceId: string
  userId: string
  threadId: string | null
  kind: string
  key: string
  value: string
  confidence: number
  createdAt: string
  updatedAt: string
}

export type AgentSendResponse = {
  threadId: string
  runId: string
  planner: AgentPlannerSource
  messages: AgentMessage[]
  navigationEvents: AgentNavigationEvent[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
}

export type AgentActionUpdatePayload = {
  title?: string
  summary?: string
  targetLabel?: string
  riskLevel?: 'low' | 'medium' | 'high'
  details?: Array<{ label: string; value: string }>
  navigation?: AgentNavigationEvent
  payload?: unknown
}
