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

export type AgentLedgerHistoryFilters = {
  direction?: 'all' | 'income' | 'expense'
  status?: 'all' | 'posted' | 'voided'
  dateMode?: 'all' | 'day' | 'week'
  day?: string | null
  week?: string | null
  keyword?: string | null
}

export type AgentNavigationEvent = {
  type: 'navigation'
  route: AgentRoute
  panel?: 'workspace' | null
  focusRecordId?: string | null
  ledgerFilters?: AgentLedgerHistoryFilters | null
  reason: string
}

export type AgentActionKind =
  | 'ledger.create_entry'
  | 'ledger.update_entry'
  | 'ledger.void_entry'
  | 'ledger.restore_entry'
  | 'ledger.lock_period'
  | 'ledger.unlock_period'
  | 'workspace.rename'
  | 'workspace.update_draft'
  | 'workspace.save_snapshot'
  | 'workspace.publish_release'
  | 'workspace.promote_version'
  | 'workspace.rollback_version'
  | 'workspace.delete_version'
  | 'workspace.reset_draft'
  | 'workspace.import_bundle'
  | 'share.create'
  | 'share.revoke'

export type AgentActionRequestStatus = 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed'
export type AgentAutomationLevel = 'manual' | 'low' | 'medium' | 'high'

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
  toolName?: string | null
  toolCallId?: string | null
  toolArguments?: Record<string, unknown> | null
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
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  planner: AgentPlannerSource | null
  automationLevel: AgentAutomationLevel
  goalStatus: AgentGoalStatus | null
  createdAt: string
  completedAt: string | null
}

export type AgentRunEventStatus = 'queued' | 'running' | 'info' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export type AgentRunEvent = {
  id: string
  threadId: string
  runId: string
  sequence: number
  type: string
  title: string
  message: string
  status: AgentRunEventStatus
  data: Record<string, unknown> | null
  createdAt: string
}

export type AgentToolInventorySource =
  | 'full_registry'
  | 'model_selected_capabilities'
  | 'business_core_fallback'

export type AgentToolInventoryFreshness = 'fresh' | 'stale' | 'fallback'

export type AgentToolAuthorityClass =
  | 'read'
  | 'sandbox_compute'
  | 'confirmation_write'
  | 'manual_only'

export type AgentToolNavigationTarget = 'dashboard' | 'inputs' | 'bookkeeping' | 'variance' | 'workspace' | null

export type AgentToolInventoryItem = {
  name: string
  capability: string
  risk: 'read' | 'low' | 'medium' | 'high'
  confirmationMode: 'never' | 'always' | 'conditional'
  navigationTarget: AgentToolNavigationTarget
  authorityClass: AgentToolAuthorityClass
  providerCompatibility: string[]
  provenance: 'xox' | 'openai_agents_js_inspired' | 'openclaw_inspired' | 'hermes_inspired'
}

export type AgentToolInventorySnapshot = {
  snapshotId: string
  userId: string
  workspaceId: string
  provider: string
  model: string
  automationLevel: AgentAutomationLevel
  source: AgentToolInventorySource
  freshness: AgentToolInventoryFreshness
  capabilities: string[]
  tools: AgentToolInventoryItem[]
  routerReason?: string | null
  createdAt: string
}

export type AgentToolRuntimeEvent = {
  kind:
    | 'inventory_ready'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'tool_call_failed'
    | 'tool_loop_guardrail'
  runId: string
  toolCallId?: string | null
  toolName?: string | null
  status: AgentRunEventStatus
  summary: string
  payload?: Record<string, unknown> | null
}

export type AgentToolLoopGuardrailFinding = {
  severity: 'warn' | 'block'
  pattern: 'repeated_failure' | 'no_progress' | 'stale_clarification' | 'executed_write_reapplied'
  toolName?: string
  evidence: string[]
  repairBrief: string
}

export type AgentToolExecutionObservation = {
  toolCallId: string
  toolName: string
  status: 'completed' | 'failed' | 'cancelled'
  authorityClass: AgentToolAuthorityClass
  arguments: Record<string, unknown>
  resultPreview?: string
  errorMessage?: string
}

export type AgentAgUiEventType =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'STEP_STARTED'
  | 'STEP_FINISHED'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_SNAPSHOT'
  | 'STATE_DELTA'
  | 'MESSAGES_SNAPSHOT'
  | 'CUSTOM'

export type AgentAgUiEvent = {
  id: string
  threadId: string
  runId: string
  sequence: number
  type: AgentAgUiEventType
  name?: string
  title?: string
  role?: 'user' | 'assistant' | 'system'
  content?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  status?: AgentRunEventStatus | AgentPlanStepStatus | AgentActionRequestStatus | AgentEvaluationStatus
  payload?: Record<string, unknown> | null
  createdAt: string
}

export type AgentTranscriptItemKind =
  | 'message'
  | 'planning'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_update'
  | 'evaluation'
  | 'memory'
  | 'status'
  | 'error'
  | 'technical'

export type AgentTranscriptItemStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'info'

export type AgentTranscriptItem = {
  id: string
  threadId: string
  runId: string
  sequence: number
  kind: AgentTranscriptItemKind
  title: string
  summary: string
  status: AgentTranscriptItemStatus
  visibility: 'user' | 'technical'
  sourceType?: string
  agUiEventType?: AgentAgUiEventType
  actionRequestId?: string | null
  toolCallId?: string | null
  toolName?: string | null
  navigation?: AgentNavigationEvent | null
  details?: Array<{ label: string; value: string }>
  payload?: Record<string, unknown> | null
  createdAt: string
}

export type AgentTimelineItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_stream'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_edit'
  | 'memory'
  | 'evaluation'
  | 'summary'
  | 'technical'

export type AgentTimelineItemStatus = AgentTranscriptItemStatus

export type AgentTimelineItemVisibility = 'user' | 'technical'

export type AgentTimelineItem = {
  id: string
  threadId: string
  runId: string | null
  sequence: number
  kind: AgentTimelineItemKind
  title: string
  summary: string
  content?: string
  status: AgentTimelineItemStatus
  visibility: AgentTimelineItemVisibility
  sourceType?: string
  agUiEventType?: AgentAgUiEventType
  toolCallId?: string | null
  toolName?: string | null
  actionRequestId?: string | null
  actionRequest?: AgentActionRequest | null
  navigation?: AgentNavigationEvent | null
  details?: Array<{ label: string; value: string }>
  payload?: Record<string, unknown> | null
  createdAt: string
}

export type AgentTranscriptNodeKind =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_stream'
  | 'work_group'
  | 'tool_group'
  | 'tool_call'
  | 'tool_result'
  | 'navigation'
  | 'confirmation'
  | 'action_update'
  | 'memory'
  | 'evaluation'
  | 'summary'
  | 'technical_group'
  | 'technical'

export type AgentTranscriptDisclosureKind =
  | 'group'
  | 'tool_body'
  | 'arguments'
  | 'result'
  | 'raw'
  | 'confirmation'
  | 'audit'
  | 'navigation'
  | 'details'

export type AgentTranscriptSection = {
  id: string
  kind: AgentTranscriptDisclosureKind
  title: string
  summary?: string
  content?: string
  defaultOpen: boolean
  details?: Array<{ label: string; value: string }>
  navigation?: AgentNavigationEvent | null
  actionRequest?: AgentActionRequest | null
  payload?: Record<string, unknown> | null
  children?: AgentTranscriptSection[]
}

export type AgentTranscriptNode = {
  id: string
  threadId: string
  runId: string | null
  sequence: number
  kind: AgentTranscriptNodeKind
  title: string
  summary: string
  content?: string
  status: AgentTimelineItemStatus
  visibility: AgentTimelineItemVisibility
  defaultOpen?: boolean
  disclosure?: {
    kind: AgentTranscriptDisclosureKind
    defaultOpen: boolean
    reason?: string
  }
  tool?: {
    name: string
    callId?: string | null
    argumentsPreview?: string
    resultPreview?: string
  }
  sourceType?: string
  agUiEventType?: AgentAgUiEventType
  actionRequestId?: string | null
  actionRequest?: AgentActionRequest | null
  navigation?: AgentNavigationEvent | null
  details?: Array<{ label: string; value: string }>
  sections?: AgentTranscriptSection[]
  children?: AgentTranscriptNode[]
  payload?: Record<string, unknown> | null
  createdAt: string
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

export type AgentGoalStatus =
  | 'interpreting'
  | 'planning'
  | 'waiting_for_confirmation'
  | 'needs_clarification'
  | 'evaluating'
  | 'repairing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export type AgentEvaluationStatus =
  | 'pass'
  | 'continue'
  | 'needs_confirmation'
  | 'needs_clarification'
  | 'blocked'
  | 'failed'

export type AgentGoalCriterion = {
  id: string
  label: string
  description: string
  kind: 'policy' | 'domain' | 'action_graph' | 'context' | 'rubric' | 'human'
  required: boolean
}

export type AgentForbiddenAction = {
  id: string
  label: string
  reason: string
}

export type AgentHumanCheckpoint = {
  id: string
  label: string
  reason: string
  status: 'pending' | 'satisfied' | 'cancelled'
}

export type AgentGoalFacts = {
  workspaceName?: string
  expectedMemberCount?: number
  expectedShareholderCount?: number
  expectedHorizonMonths?: number
  expectedStartMonth?: number
  requiresForecastSummary?: boolean
  forbiddenActions?: Array<'publish_release' | 'share_link' | 'account_action'>
  requiredCapabilities?: Array<'workspace_rename' | 'operating_model' | 'draft' | 'ledger' | 'memory' | 'sandbox' | 'version' | 'share'>
}

export type AgentGoalContract = {
  goalId: string
  threadId: string
  runId: string
  userId: string
  workspaceId: string
  objective: string
  scope: {
    workspace: 'current'
    pages: Array<'model' | 'ledger' | 'variance' | 'versions' | 'share'>
    allowedCapabilities: string[]
  }
  acceptanceCriteria: AgentGoalCriterion[]
  facts?: AgentGoalFacts
  forbiddenActions: AgentForbiddenAction[]
  humanCheckpoints: AgentHumanCheckpoint[]
  automationLevel: AgentAutomationLevel
  maxIterations: number
  contextStrategy: {
    memoryScopes: Array<'user' | 'workspace' | 'thread'>
    compactionMode: 'none' | 'summary' | 'reset_with_handoff'
  }
}

export type AgentEvaluationFinding = {
  id: string
  criterionId: string
  severity: 'info' | 'warning' | 'blocking'
  message: string
  evidence?: Record<string, unknown> | null
}

export type AgentEvaluationResult = {
  id: string
  goalId: string
  threadId: string
  runId: string
  iteration: number
  status: AgentEvaluationStatus
  confidence: number
  satisfiedCriteria: string[]
  unsatisfiedCriteria: AgentEvaluationFinding[]
  policyFindings: AgentEvaluationFinding[]
  nextPlannerBrief: string | null
  userQuestion: string | null
  blocker: string | null
  createdAt: string
}

export type AgentGoalRecord = {
  id: string
  threadId: string
  runId: string
  status: AgentGoalStatus
  contract: AgentGoalContract
  createdAt: string
  updatedAt: string
  completedAt: string | null
  blockedReason: string | null
}

export type AgentThreadState = {
  thread: AgentThreadSummary
  messages: AgentMessage[]
  runs: AgentRunRecord[]
  planner: AgentPlannerSource | null
  goals: AgentGoalRecord[]
  evaluations: AgentEvaluationResult[]
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentRunEvent[]
  agUiEvents: AgentAgUiEvent[]
  transcriptItems: AgentTranscriptItem[]
  timelineItems: AgentTimelineItem[]
  transcriptNodes: AgentTranscriptNode[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
}

export type AgentThreadEvent = {
  type: 'thread_state'
  threadId: string
  sequence: number
  reason: string
  state: AgentThreadState
}

export type AgentMemoryRecord = {
  id: string
  workspaceId: string
  userId: string
  threadId: string | null
  kind: string
  scopeType?: 'thread' | 'workspace' | 'user' | 'procedural' | 'commitment'
  memoryType?: 'working' | 'episodic' | 'semantic' | 'procedural' | 'commitment'
  lane?: 'working' | 'session' | 'semantic' | 'procedural' | 'episodic' | 'diagnostic' | 'archived'
  status?: 'candidate' | 'active' | 'promoted' | 'archived' | 'rejected' | 'expired' | 'superseded'
  key: string
  value: string
  confidence: number
  evidenceScore?: number
  sensitivity?: 'normal' | 'private' | 'restricted'
  injectable?: boolean
  normalizedHash?: string | null
  sourceKind?: string | null
  evidence?: Record<string, unknown> | null
  sourceRunId?: string | null
  lastUsedAt?: string | null
  lastVerifiedAt?: string | null
  promotedAt?: string | null
  expiresAt?: string | null
  supersededBy?: string | null
  createdAt: string
  updatedAt: string
}

export type AgentProviderSettingRecord = {
  provider: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  updatedAt: string
}

export type AgentProviderProbeResult = {
  status: 'passed' | 'failed' | 'warning'
  provider: string
  model: string
  checks: Array<{
    name: 'auth' | 'model' | 'chat' | 'tools' | 'stream'
    status: 'passed' | 'failed' | 'warning' | 'skipped'
    message: string
  }>
  message: string
}

export type AgentProviderSettingUpdatePayload = {
  provider: string
  baseUrl: string
  model: string
  apiKey?: string
}

export type AgentProviderProbePayload = Partial<AgentProviderSettingUpdatePayload>

export type SandboxFileKind =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'jsonl'
  | 'xlsx'
  | 'xls'
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'
  | 'html'
  | 'htm'
  | 'txt'
  | 'md'
  | 'pdf'
  | 'docx'
  | 'doc'

export type SandboxArtifactKind =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'jsonl'
  | 'xlsx'
  | 'png'
  | 'jpg'
  | 'jpeg'
  | 'webp'
  | 'html'
  | 'txt'
  | 'md'
  | 'pdf'
  | 'docx'

export type SandboxDataScope =
  | 'workspace_summary'
  | 'forecast_months'
  | 'ledger_entries'
  | 'entity_summary'
  | 'uploaded_file'
  | 'custom_bundle'

export type SandboxRunCodeInput = {
  purpose: string
  language: 'python' | 'javascript'
  code: string
  dataRequest: {
    scope: SandboxDataScope
    fields?: string[]
    monthLabels?: string[]
    fileIds?: string[]
    fileKinds?: SandboxFileKind[]
    rowLimit?: number
  }
  expectedOutputs?: Array<'json' | 'table' | 'chart' | 'csv' | 'spreadsheet' | 'document' | 'image' | 'markdown'>
}

export type SandboxCapabilityProfile = {
  filesystem: 'input_readonly_output_tmp'
  shell: false
  packageInstall: false
  internalApi: false
  productionDatabase: false
  objectStorage: 'none' | 'selected_upload_readonly'
  providerSecrets: false
  userSessionTokens: false
  businessWrites: false
  memoryWrites: false
  accountActions: false
}

export type SandboxManifest = {
  schemaVersion: 1
  identity: {
    tenantId: string
    workspaceId: string
    threadId: string
    runId: string
    toolCallId: string
    userIdHash: string
  }
  inputBundle: {
    bundleId: string
    kind: SandboxDataScope
    schemaVersion: string
    mountPath: '/input'
    readonly: true
    fields: string[]
    rowCount?: number
    fileCount?: number
    fileKinds?: SandboxFileKind[]
    mimeTypes?: string[]
    redactions: number
    contentHash: string
  }
  runtime: {
    language: 'python' | 'javascript'
    entrypoint: 'single_script'
    timeoutMs: number
    cpuMs: number
    memoryMb: number
    processLimit: number
    openFileLimit: number
    stdoutLimitBytes: number
    stderrLimitBytes: number
  }
  capabilities: SandboxCapabilityProfile
  network: {
    mode: 'disabled' | 'allowlisted'
    allowlist: Array<{ host: string; port?: number; protocol: 'https' }>
  }
  outputPolicy: {
    writableMountPath: '/output'
    maxArtifactCount: number
    maxArtifactBytes: number
    allowedArtifactKinds: SandboxArtifactKind[]
    expiresInSeconds: number
  }
}

export type SandboxObservation = {
  runId: string
  sandboxRunId: string
  status: 'completed' | 'blocked' | 'failed' | 'timed_out'
  purpose: string
  language: 'python' | 'javascript'
  manifest: Pick<SandboxManifest, 'schemaVersion' | 'identity' | 'inputBundle' | 'runtime' | 'capabilities' | 'network' | 'outputPolicy'>
  dataBundleSummary: {
    scope: string
    rows?: number
    files?: number
    fields: string[]
    redactions: number
  }
  result: {
    summary: string
    structured?: unknown
    tables?: Array<{ name: string; rows: unknown[] }>
    charts?: Array<{ title: string; artifactId: string }>
    proposedPatches?: unknown[]
  }
  artifacts: Array<{
    artifactId: string
    kind: SandboxArtifactKind
    name: string
    sizeBytes: number
  }>
  resourceUsage: {
    wallTimeMs: number
    cpuMs?: number
    memoryPeakMb?: number
    stdoutBytes: number
    stderrBytes: number
  }
}

export type AgentSendResponse = {
  threadId: string
  runId: string
  status: AgentRunRecord['status']
  planner: AgentPlannerSource | null
  automationLevel: AgentAutomationLevel
  messages: AgentMessage[]
  navigationEvents: AgentNavigationEvent[]
  runEvents: AgentRunEvent[]
  agUiEvents: AgentAgUiEvent[]
  transcriptItems: AgentTranscriptItem[]
  timelineItems: AgentTimelineItem[]
  transcriptNodes: AgentTranscriptNode[]
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
