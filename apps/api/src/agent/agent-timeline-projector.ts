import type {
  AgentActionRequest,
  AgentMessage,
  AgentTranscriptNode,
  AgentTranscriptSection,
  AgentTimelineItem,
  AgentTimelineItemKind,
  AgentTranscriptItem,
} from '@xox/contracts'
import type { AgentProjectionState } from './ag-ui-projection.js'
import { buildAgentTranscriptItems } from './agent-transcript-projector.js'

type PendingTimelineItem = AgentTimelineItem & { order: number }

function timeOrder(createdAt: string, fallback = 0, rank = 0) {
  const millis = Date.parse(createdAt)
  const safeMillis = Number.isFinite(millis) ? millis : 0
  return safeMillis * 1000 + fallback * 10 + rank
}

function transcriptOrder(state: AgentProjectionState, item: AgentTranscriptItem) {
  const firstRunEventTime = state.runEvents[0]?.createdAt
  if (item.kind === 'message' && item.payload?.phase === 'planning') {
    return timeOrder(firstRunEventTime ?? item.createdAt, item.sequence, 1)
  }
  if (firstRunEventTime) return timeOrder(firstRunEventTime, item.sequence, 4)
  return timeOrder(item.createdAt, item.sequence, 4)
}

function latestRunId(state: AgentProjectionState) {
  return state.runEvents[0]?.runId ?? state.planSteps[0]?.runId ?? state.actionRequests[0]?.runId ?? state.goals[0]?.runId ?? null
}

function messageTitle(message: AgentMessage) {
  if (message.role === 'user') return '你'
  if (message.role === 'assistant') return 'Agent'
  return '系统'
}

function messageKind(message: AgentMessage): AgentTimelineItemKind {
  if (message.role === 'user') return 'user_message'
  if (message.role === 'assistant') return 'assistant_message'
  return 'technical'
}

function messageToTimelineItem(message: AgentMessage, runId: string | null, index: number): PendingTimelineItem {
  return {
    id: `message-${message.id}`,
    threadId: message.threadId,
    runId,
    sequence: index + 1,
    kind: messageKind(message),
    title: messageTitle(message),
    summary: message.content,
    content: message.content,
    status: 'completed',
    visibility: message.role === 'system' ? 'technical' : 'user',
    sourceType: 'agent_message',
    createdAt: message.createdAt,
    order: timeOrder(message.createdAt, index + 1, message.role === 'user' ? 0 : 9),
  }
}

function transcriptKind(item: AgentTranscriptItem): AgentTimelineItemKind {
  if (item.kind === 'message') return 'assistant_stream'
  if (item.kind === 'tool_call') return 'tool_call'
  if (item.kind === 'tool_result') return 'tool_result'
  if (item.kind === 'navigation') return 'navigation'
  if (item.kind === 'confirmation') return 'confirmation'
  if (item.kind === 'action_update') return 'action_edit'
  if (item.kind === 'memory') return 'memory'
  if (item.kind === 'evaluation') return 'evaluation'
  if (item.kind === 'technical') return 'technical'
  return item.visibility === 'technical' ? 'technical' : 'summary'
}

function timelineItemFromTranscript(
  state: AgentProjectionState,
  item: AgentTranscriptItem,
  action: AgentActionRequest | null,
  visibility: AgentTimelineItem['visibility'],
): PendingTimelineItem {
  const kind = action && item.kind === 'confirmation' ? 'tool_call' : transcriptKind(item)
  return {
    id: `timeline-${item.id}`,
    threadId: item.threadId,
    runId: item.runId || latestRunId(state),
    sequence: item.sequence,
    kind,
    title: kind === 'tool_call' && action ? `调用工具：${action.kind}` : item.title,
    summary: item.summary,
    ...(kind === 'assistant_stream' ? { content: item.summary } : {}),
    status: item.status,
    visibility,
    ...(item.sourceType ? { sourceType: item.sourceType } : {}),
    ...(item.agUiEventType ? { agUiEventType: item.agUiEventType } : {}),
    ...((action?.kind ?? item.toolName) ? { toolName: action?.kind ?? item.toolName } : {}),
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.actionRequestId ? { actionRequestId: item.actionRequestId } : {}),
    ...(action ? { actionRequest: action } : {}),
    ...(item.navigation ? { navigation: item.navigation } : {}),
    ...(item.details ? { details: item.details } : {}),
    ...(item.payload ? { payload: item.payload } : {}),
    createdAt: item.createdAt,
    order: transcriptOrder(state, item),
  }
}

function hasFinalAssistantMessageForRun(state: AgentProjectionState) {
  const firstRunEventTime = state.runEvents[0]?.createdAt
  if (!firstRunEventTime) return state.messages.some((message) => message.role === 'assistant')
  const firstRunEventMillis = Date.parse(firstRunEventTime)
  return state.messages.some((message) => {
    if (message.role !== 'assistant') return false
    const messageMillis = Date.parse(message.createdAt)
    return Number.isFinite(messageMillis) && Number.isFinite(firstRunEventMillis)
      ? messageMillis >= firstRunEventMillis
      : true
  })
}

function shouldDropTranscriptItem(item: AgentTranscriptItem, state: AgentProjectionState) {
  if (item.kind !== 'message' || !hasFinalAssistantMessageForRun(state)) return false
  if (item.payload?.phase === 'final_answer') return true
  const hasToolWork = state.runEvents.some((event) =>
    event.runId === item.runId &&
    event.type === 'provider_stream_delta' &&
    event.data?.kind === 'tool_call_delta',
  ) || state.planSteps.some((step) => step.runId === item.runId) ||
    state.actionRequests.some((action) => action.runId === item.runId)
  return !hasToolWork
}

function transcriptTimelineVisibility(item: AgentTranscriptItem, action: AgentActionRequest | null): AgentTimelineItem['visibility'] {
  if (item.visibility === 'technical') return 'technical'
  if (action) return 'user'
  if (item.kind === 'message') return 'user'
  if (item.kind === 'error') return 'user'
  if (item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'navigation' || item.kind === 'confirmation' || item.kind === 'action_update') {
    return 'user'
  }
  if (item.kind === 'evaluation' && (item.status === 'failed' || item.status === 'waiting')) return 'user'
  return 'technical'
}

function actionKind(status: AgentActionRequest['status']): AgentTimelineItemKind {
  if (status === 'pending') return 'confirmation'
  if (status === 'executed' || status === 'confirmed') return 'tool_result'
  return 'action_edit'
}

function actionStatus(status: AgentActionRequest['status']): AgentTimelineItem['status'] {
  if (status === 'pending') return 'waiting'
  if (status === 'executed' || status === 'confirmed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'info'
}

function actionToTimelineItem(action: AgentActionRequest, index: number): PendingTimelineItem {
  return {
    id: `timeline-action-${action.id}`,
    threadId: action.threadId,
    runId: action.runId,
    sequence: index + 1,
    kind: actionKind(action.status),
    title: action.title,
    summary: action.summary,
    status: actionStatus(action.status),
    visibility: 'user',
    sourceType: 'agent_action_request',
    toolName: action.kind,
    actionRequestId: action.id,
    actionRequest: action,
    navigation: action.navigation,
    details: action.details,
    payload: {
      riskLevel: action.riskLevel,
      targetLabel: action.targetLabel,
      errorMessage: action.errorMessage,
    },
    createdAt: action.executedAt ?? action.createdAt,
    order: timeOrder(action.executedAt ?? action.createdAt, index + 1, 6),
  }
}

function toolCallKey(item: PendingTimelineItem) {
  if (item.kind !== 'tool_call') return null
  const payloadIndex = typeof item.payload?.toolCallIndex === 'number' ? item.payload.toolCallIndex : null
  return `${item.runId ?? 'run'}:${item.toolCallId ?? item.toolName ?? 'tool'}:${payloadIndex ?? ''}`
}

function assistantStreamKey(item: PendingTimelineItem) {
  if (item.kind !== 'assistant_stream') return null
  return `${item.runId ?? item.threadId}:assistant_stream`
}

function shouldHideGenericConfirmation(item: AgentTranscriptItem, state: AgentProjectionState) {
  return item.sourceType === 'confirmation_ready' && state.actionRequests.some((action) => action.status === 'pending')
}

function mergeTimelineItems(items: PendingTimelineItem[]) {
  const merged: PendingTimelineItem[] = []
  const toolIndexByKey = new Map<string, number>()
  const assistantStreamIndexByKey = new Map<string, number>()
  const actionIds = new Set<string>()

  for (const item of items) {
    const streamKey = assistantStreamKey(item)
    if (streamKey) {
      const existingIndex = assistantStreamIndexByKey.get(streamKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          const summary = mergeAssistantStreamText(existing.summary, item.summary)
          const content = mergeAssistantStreamText(existing.content, item.content)
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary,
            status: item.status,
            ...((content || existing.content) ? { content } : {}),
            ...(item.payload ? { payload: item.payload } : {}),
            order: Math.min(existing.order, item.order),
          }
        }
        continue
      }
      assistantStreamIndexByKey.set(streamKey, merged.length)
    }

    const toolKey = toolCallKey(item)
    if (toolKey) {
      const existingIndex = toolIndexByKey.get(toolKey)
      if (existingIndex !== undefined) {
        const existing = merged[existingIndex]
        if (existing) {
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary: item.summary || existing.summary,
            status: item.status,
            ...(item.payload ? { payload: item.payload } : {}),
            ...(item.details ? { details: item.details } : {}),
            order: Math.min(existing.order, item.order),
          }
        }
        continue
      }
      toolIndexByKey.set(toolKey, merged.length)
    }

    if (item.actionRequestId && item.kind !== 'action_edit') {
      const dedupeKey = `${item.actionRequestId}:${item.kind}`
      if (actionIds.has(dedupeKey)) continue
      actionIds.add(dedupeKey)
    }

    merged.push(item)
  }

  return merged
}

function mergeAssistantStreamText(existing: string | undefined, next: string | undefined) {
  if (!existing) return next ?? ''
  if (!next) return existing
  if (next.startsWith(existing)) return next
  if (existing.startsWith(next)) return existing
  return existing
}

function providerToolCallCompletedStatus(state: AgentProjectionState, runId: string | null | undefined): AgentTimelineItem['status'] | null {
  if (!runId) return null
  let streamCompleted = false
  let runCancelled = false
  let runFailed = false
  let runCompleted = false
  for (const event of state.runEvents) {
    if (event.runId !== runId) continue
    if (event.type === 'run_failed') runFailed = true
    if (event.type === 'run_cancelled') runCancelled = true
    if (event.type === 'run_completed') runCompleted = true
    if (event.type === 'provider_stream_completed') streamCompleted = true
  }
  if (streamCompleted) return 'completed'
  if (runCancelled) return 'cancelled'
  if (runFailed) return 'failed'
  if (runCompleted) return 'completed'
  return null
}

function finalizeProviderToolCallStatus(state: AgentProjectionState, item: PendingTimelineItem): PendingTimelineItem {
  if (item.kind !== 'tool_call') return item
  if (item.sourceType !== 'provider_stream_delta') return item
  if (item.status !== 'running') return item
  const completedStatus = providerToolCallCompletedStatus(state, item.runId)
  return completedStatus ? { ...item, status: completedStatus } : item
}

export function buildAgentTimelineItems(state: AgentProjectionState): AgentTimelineItem[] {
  const actionsById = new Map(state.actionRequests.map((action) => [action.id, action]))
  const transcriptItems = buildAgentTranscriptItems(state)
  const representedActionIds = new Set<string>()
  const runId = latestRunId(state)

  const items: PendingTimelineItem[] = [
    ...state.messages.map((message, index) => messageToTimelineItem(message, runId, index)),
  ]

  for (const item of transcriptItems) {
    if (shouldHideGenericConfirmation(item, state)) continue
    if (shouldDropTranscriptItem(item, state)) continue
    const action = item.actionRequestId ? actionsById.get(item.actionRequestId) ?? null : null
    if (action) representedActionIds.add(action.id)
    items.push(timelineItemFromTranscript(state, item, action, transcriptTimelineVisibility(item, action)))
  }

  state.actionRequests.forEach((action, index) => {
    if (!representedActionIds.has(action.id)) items.push(actionToTimelineItem(action, index))
  })

  return mergeTimelineItems(items)
    .map((item) => finalizeProviderToolCallStatus(state, item))
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(({ order: _order, ...item }, index) => ({ ...item, sequence: index + 1 }))
}

type PendingTranscriptNode = AgentTranscriptNode & { order: number }

function isMessageTimelineItem(item: AgentTimelineItem) {
  return item.kind === 'user_message' || item.kind === 'assistant_message' || item.kind === 'assistant_stream' || item.kind === 'summary'
}

function isMergeableReadResultTimelineItem(item: AgentTimelineItem) {
  return item.sourceType === 'plan_step' &&
    !item.actionRequestId &&
    !item.actionRequest &&
    (item.status === 'completed' || item.status === 'info') &&
    Boolean(item.summary)
}

function transcriptNodeKind(item: AgentTimelineItem): AgentTranscriptNode['kind'] {
  if (item.kind === 'action_edit') return 'action_update'
  if (item.kind === 'technical') return 'technical'
  return item.kind
}

function finiteTime(value: string) {
  const millis = Date.parse(value)
  return Number.isFinite(millis) ? millis : 0
}

function nodeOrder(item: AgentTimelineItem) {
  return item.sequence * 1000
}

function groupStatus(nodes: AgentTranscriptNode[]): AgentTimelineItem['status'] {
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.some((node) => node.status === 'waiting')) return 'waiting'
  if (nodes.some((node) => node.status === 'running' || node.status === 'pending')) return 'running'
  if (nodes.some((node) => node.status === 'cancelled')) return 'cancelled'
  if (nodes.length > 0 && nodes.every((node) => node.status === 'completed')) return 'completed'
  return 'info'
}

function flattenTranscriptChildren(nodes: AgentTranscriptNode[]): AgentTranscriptNode[] {
  return nodes.flatMap((node): AgentTranscriptNode[] => [node, ...flattenTranscriptChildren(node.children ?? [])])
}

function pendingNodeCount(nodes: AgentTranscriptNode[]) {
  const flattened = flattenTranscriptChildren(nodes)
  const pendingActionIds = new Set(
    flattened
      .map((node) => node.actionRequest?.status === 'pending' ? node.actionRequest.id : null)
      .filter((id): id is string => Boolean(id)),
  )
  const waitingWithoutAction = flattened.filter((node) => (
    node.status === 'waiting' &&
    !node.actionRequest &&
    !node.actionRequestId &&
    node.kind !== 'work_group' &&
    node.kind !== 'tool_group' &&
    node.kind !== 'evaluation'
  )).length
  return pendingActionIds.size + waitingWithoutAction
}

function sectionPayload(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function compactJson(value: unknown) {
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseJsonPayload(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return sectionPayload(parsed)
  } catch {
    return null
  }
}

function compactArgumentSummary(value: string) {
  const parsed = parseJsonPayload(value)
  if (!parsed) return '参数可展开查看'
  const keys = Object.keys(parsed).slice(0, 4)
  return keys.length > 0 ? `参数：${keys.join(', ')}` : '参数可展开查看'
}

function toolArgumentsPreview(item: AgentTimelineItem) {
  const payload = item.payload ?? {}
  const preview = typeof payload.argumentsPreview === 'string'
    ? payload.argumentsPreview
    : typeof payload.argumentsDelta === 'string'
      ? payload.argumentsDelta
      : ''
  return preview || undefined
}

function toolResultPreview(item: AgentTimelineItem) {
  if (item.kind === 'tool_result') return item.summary
  if (item.actionRequest) return item.actionRequest.summary
  if (item.kind === 'tool_call' && item.status === 'completed') return '工具调用已完成，结果已用于本轮回复或后续业务步骤。'
  return item.summary
}

function rawSection(id: string, content: string, payload: Record<string, unknown> | null = null): AgentTranscriptSection {
  return {
    id,
    kind: 'raw',
    title: 'Raw JSON',
    summary: '二级折叠',
    content,
    ...(payload ? { payload } : {}),
    defaultOpen: false,
  }
}

function appendRawSection(
  sections: AgentTranscriptSection[],
  ownerId: string,
  rawPayload: Record<string, unknown> | null,
) {
  if (!rawPayload || sections.some((section) => section.children?.some((child) => child.kind === 'raw'))) return
  const target = sections.find((section) => section.kind === 'result')
    ?? sections.find((section) => section.kind === 'details')
    ?? sections.find((section) => section.kind === 'confirmation')
  const content = compactJson(rawPayload)
  if (target) {
    target.children = [
      ...(target.children ?? []),
      rawSection(`${target.id}:raw`, content, rawPayload),
    ]
    return
  }
  sections.push({
    id: `${ownerId}:details`,
    kind: 'details',
    title: 'Details',
    summary: '更多详情',
    defaultOpen: false,
    children: [rawSection(`${ownerId}:details:raw`, content, rawPayload)],
  })
}

function toolNodeSummary(item: AgentTimelineItem) {
  if (item.actionRequest) return item.actionRequest.summary
  if (item.kind === 'tool_call') return '工具已选择，参数可展开查看。'
  if (item.kind === 'tool_result') return item.summary
  return item.summary
}

function timelineItemSections(item: AgentTimelineItem): AgentTranscriptSection[] {
  const sections: AgentTranscriptSection[] = []
  const argumentsPreview = toolArgumentsPreview(item)
  if (argumentsPreview) {
    sections.push({
      id: `${item.id}:arguments`,
      kind: 'arguments',
      title: 'Arguments',
      summary: compactArgumentSummary(argumentsPreview),
      children: [
        rawSection(`${item.id}:arguments:raw`, argumentsPreview, parseJsonPayload(argumentsPreview)),
      ],
      defaultOpen: false,
    })
  }
  if (item.details?.length) {
    sections.push({
      id: `${item.id}:details`,
      kind: 'details',
      title: 'Details',
      summary: `${item.details.length} 项`,
      details: item.details,
      defaultOpen: item.status === 'waiting',
    })
  }
  if (item.kind === 'tool_result' || item.kind === 'tool_call') {
    const result = toolResultPreview(item)
    if (result) {
      sections.push({
        id: `${item.id}:result`,
        kind: 'result',
        title: 'Result Preview',
        summary: result.replace(/\s+/g, ' ').slice(0, 180),
        content: result,
        defaultOpen: item.status === 'failed',
      })
    }
  }
  if (item.actionRequest?.status === 'pending') {
    sections.push({
      id: `${item.id}:confirmation`,
      kind: 'confirmation',
      title: '确认卡',
      summary: item.actionRequest.summary,
      actionRequest: item.actionRequest,
      defaultOpen: true,
    })
  }
  const rawPayload = sectionPayload(item.payload) ?? (item.actionRequest ? {
    riskLevel: item.actionRequest.riskLevel,
    targetLabel: item.actionRequest.targetLabel,
    payload: item.actionRequest.payload,
  } : null)
  appendRawSection(sections, item.id, rawPayload)
  return sections
}

function timelineItemToNode(item: AgentTimelineItem): PendingTranscriptNode {
  const sections = timelineItemSections(item)
  const waitingForConfirmation = item.actionRequest?.status === 'pending'
  const defaultOpen = item.status === 'failed' || waitingForConfirmation || item.status === 'running'
  const argumentsPreview = toolArgumentsPreview(item)
  const resultPreview = item.kind === 'tool_call' || item.kind === 'tool_result' ? toolResultPreview(item) : undefined
  const disclosureReason = item.status === 'failed'
    ? '失败项需要默认展开'
    : waitingForConfirmation
      ? '写入动作需要用户确认'
      : item.status === 'running'
        ? '运行中动作需要展示进度'
        : undefined
  const tool = item.toolName
    ? {
        name: item.toolName,
        callId: item.toolCallId ?? null,
        ...(argumentsPreview ? { argumentsPreview } : {}),
        ...(resultPreview ? { resultPreview } : {}),
      }
    : null
  return {
    id: `node-${item.id}`,
    threadId: item.threadId,
    runId: item.runId,
    sequence: item.sequence,
    kind: item.actionRequest ? 'tool_call' : transcriptNodeKind(item),
    title: item.title,
    summary: item.kind === 'tool_call' || item.kind === 'tool_result' ? toolNodeSummary(item) : item.summary,
    ...(item.content ? { content: item.content } : {}),
    status: item.status,
    visibility: item.visibility,
    defaultOpen,
    disclosure: {
      kind: item.actionRequest ? 'confirmation' : item.kind === 'tool_call' || item.kind === 'tool_result' ? 'tool_body' : 'details',
      defaultOpen,
      ...(disclosureReason ? { reason: disclosureReason } : {}),
    },
    ...(tool ? { tool } : {}),
    ...(item.sourceType ? { sourceType: item.sourceType } : {}),
    ...(item.agUiEventType ? { agUiEventType: item.agUiEventType } : {}),
    ...(item.actionRequestId ? { actionRequestId: item.actionRequestId } : {}),
    ...(item.actionRequest ? { actionRequest: item.actionRequest } : {}),
    ...(item.navigation ? { navigation: item.navigation } : {}),
    ...(item.details ? { details: item.details } : {}),
    ...(sections.length ? { sections } : {}),
    ...(item.payload ? { payload: item.payload } : {}),
    createdAt: item.createdAt,
    order: nodeOrder(item),
  }
}

function readableElapsed(items: AgentTimelineItem[]) {
  if (items.length === 0) return ''
  const times = items.map((item) => finiteTime(item.createdAt)).filter((value) => value > 0)
  if (times.length === 0) return '0s'
  const elapsed = Math.max(...times) - Math.min(...times)
  if (elapsed < 1000) return '0s'
  const seconds = Math.round(elapsed / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function toolGroupNode(runKey: string, children: AgentTranscriptNode[], order: number): PendingTranscriptNode {
  const toolCount = children.filter((node) => node.kind === 'tool_call' || node.kind === 'tool_result').length
  const pendingCount = pendingNodeCount(children)
  const failedCount = children.filter((node) => node.status === 'failed').length
  const status = groupStatus(children)
  return {
    id: `node-tool-group-${runKey}`,
    threadId: children[0]?.threadId ?? '',
    runId: children[0]?.runId ?? null,
    sequence: children[0]?.sequence ?? 0,
    kind: 'tool_group',
    title: toolCount > 0 ? `调用 ${toolCount} 个工具` : '业务步骤',
    summary: [
      pendingCount ? `${pendingCount} 个待确认` : null,
      failedCount ? `${failedCount} 个失败` : null,
      children.length ? `${children.length} 个步骤` : null,
    ].filter(Boolean).join(' / '),
    status,
    visibility: 'user',
    defaultOpen: true,
    disclosure: {
      kind: 'group',
      defaultOpen: true,
    },
    children,
    createdAt: children[0]?.createdAt ?? new Date(0).toISOString(),
    order,
  }
}

function comparableToolName(value: string | null | undefined) {
  return value?.replaceAll('.', '_').replaceAll('-', '_') ?? ''
}

const toolActionKindAliases: Record<string, string[]> = {
  ledger_create_member_income: ['ledger.create_entry'],
  ledger_create_entry: ['ledger.create_entry'],
  ledger_create_planned_member_income_batch: ['ledger.create_entry'],
  ledger_create_planned_related_expense_batch: ['ledger.create_entry'],
  ledger_update_entry: ['ledger.update_entry'],
  ledger_void_entry: ['ledger.void_entry'],
  ledger_restore_entry: ['ledger.restore_entry'],
  ledger_set_period_lock: ['ledger.set_period_lock'],
  workspace_update_online_factor: ['workspace.update_draft'],
  workspace_patch_config: ['workspace.update_draft'],
  workspace_configure_operating_model: ['workspace.update_draft'],
  team_member_add: ['workspace.update_draft'],
  team_member_delete: ['workspace.update_draft'],
  employee_add: ['workspace.update_draft'],
  employee_delete: ['workspace.update_draft'],
  shareholder_add: ['workspace.update_draft'],
  shareholder_delete: ['workspace.update_draft'],
  cost_item_add: ['workspace.update_draft'],
  cost_item_delete: ['workspace.update_draft'],
  stage_cost_type_add: ['workspace.update_draft'],
  stage_cost_type_delete: ['workspace.update_draft'],
  workspace_rename: ['workspace.rename'],
  workspace_save_snapshot: ['workspace.save_snapshot'],
  workspace_publish_release: ['workspace.publish_release'],
  workspace_promote_version: ['workspace.promote_version'],
  workspace_rollback_version: ['workspace.rollback_version'],
  workspace_delete_version: ['workspace.delete_version'],
  workspace_reset_draft: ['workspace.reset_draft'],
  workspace_import_bundle: ['workspace.import_bundle'],
  share_create: ['share.create'],
  share_revoke: ['share.revoke'],
}

function providerToolMatchesAction(providerToolName: string | null | undefined, actionKind: string | null | undefined) {
  const provider = comparableToolName(providerToolName)
  const action = actionKind ?? ''
  if (!provider || !action) return false
  if (provider === comparableToolName(action)) return true
  return toolActionKindAliases[provider]?.includes(action) ?? false
}

function mergeNodeSections(
  providerNode: PendingTranscriptNode,
  actionNode: PendingTranscriptNode,
): AgentTranscriptSection[] | undefined {
  const merged = [...(providerNode.sections ?? []), ...(actionNode.sections ?? [])]
  if (merged.length === 0) return undefined
  const seen = new Set<string>()
  return merged.filter((section) => {
    if (seen.has(section.id)) return false
    seen.add(section.id)
    return true
  })
}

function mergeProviderToolCallsIntoActionNodes(nodes: PendingTranscriptNode[]): PendingTranscriptNode[] {
  const consumedProviderNodeIds = new Set<string>()

  return nodes
    .map((node, index) => {
      if (node.kind !== 'tool_call' || !node.actionRequest) return node
      const actionToolName = node.tool?.name ?? node.actionRequest.kind
      if (!actionToolName) return node

      let providerIndex = -1
      for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = nodes[candidateIndex]
        if (
          candidate &&
          candidate.kind === 'tool_call' &&
          !candidate.actionRequest &&
          !consumedProviderNodeIds.has(candidate.id) &&
          providerToolMatchesAction(candidate.tool?.name, actionToolName)
        ) {
          providerIndex = candidateIndex
          break
        }
      }
      if (providerIndex < 0) return node

      const providerNode = nodes[providerIndex]
      if (!providerNode) return node
      consumedProviderNodeIds.add(providerNode.id)
      const mergedSections = mergeNodeSections(providerNode, node)
      const mergedTool = node.tool
        ? {
            ...node.tool,
            ...(providerNode.tool?.name ? { name: providerNode.tool.name } : {}),
            ...(providerNode.tool?.argumentsPreview ? { argumentsPreview: providerNode.tool.argumentsPreview } : {}),
            ...(providerNode.tool?.resultPreview && !node.tool.resultPreview ? { resultPreview: providerNode.tool.resultPreview } : {}),
          }
        : null

      return {
        ...node,
        title: node.actionRequest?.title ?? node.title,
        order: Math.min(providerNode.order, node.order),
        ...(mergedTool ? { tool: mergedTool } : {}),
        ...(mergedSections ? { sections: mergedSections } : {}),
      }
    })
    .filter((node) => !consumedProviderNodeIds.has(node.id))
}

function isReadResultNode(node: PendingTranscriptNode) {
  return node.sourceType === 'plan_step' &&
    !node.actionRequest &&
    !node.actionRequestId &&
    !toolGroupChild(node) &&
    node.status === 'completed' &&
    Boolean(node.summary)
}

function upsertToolResultSection(
  sections: AgentTranscriptSection[],
  ownerId: string,
  result: string,
): AgentTranscriptSection[] {
  const next = [...sections]
  const existingIndex = next.findIndex((section) => section.kind === 'result')
  const section: AgentTranscriptSection = {
    id: existingIndex >= 0 ? next[existingIndex]!.id : `${ownerId}:result`,
    kind: 'result',
    title: 'Result Preview',
    summary: result.replace(/\s+/g, ' ').slice(0, 180),
    content: result,
    defaultOpen: false,
  }
  if (existingIndex >= 0) {
    next[existingIndex] = section
    return next
  }
  next.push(section)
  return next
}

function attachReadResultToToolNode(toolNode: PendingTranscriptNode, readNode: PendingTranscriptNode): PendingTranscriptNode {
  const result = readNode.summary ?? ''
  const sections = upsertToolResultSection(toolNode.sections ?? [], toolNode.id, result)
  return {
    ...toolNode,
    status: readNode.status,
    ...(toolNode.navigation ? {} : readNode.navigation ? { navigation: readNode.navigation } : {}),
    sections,
    ...(toolNode.tool ? { tool: { ...toolNode.tool, resultPreview: result } } : {}),
  }
}

function numericPayloadField(payload: Record<string, unknown> | null | undefined, field: string) {
  const value = payload?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readResultMatchesToolNode(readNode: PendingTranscriptNode, candidate: PendingTranscriptNode) {
  if (candidate.actionRequest) return false
  if (candidate.runId !== readNode.runId) return false
  if (candidate.kind !== 'tool_call' && candidate.kind !== 'tool_result') return false

  const readCallId = readNode.tool?.callId
  const candidateCallId = candidate.tool?.callId
  if (readCallId && candidateCallId) return readCallId === candidateCallId

  const readToolName = readNode.tool?.name
  const candidateToolName = candidate.tool?.name
  if (readToolName && candidateToolName) return providerToolMatchesAction(candidateToolName, readToolName)

  const planStepSequence = numericPayloadField(readNode.payload, 'planStepSequence')
  const toolCallIndex = numericPayloadField(candidate.payload, 'toolCallIndex')
  return planStepSequence !== null && toolCallIndex !== null && planStepSequence === toolCallIndex + 1
}

function mergeReadResultPlanStepsIntoToolNodes(nodes: PendingTranscriptNode[]): PendingTranscriptNode[] {
  const next: PendingTranscriptNode[] = []

  for (const node of nodes) {
    if (isReadResultNode(node)) {
      let targetIndex = -1
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index]
        if (
          candidate &&
          readResultMatchesToolNode(node, candidate)
        ) {
          targetIndex = index
          break
        }
      }
      if (targetIndex >= 0) {
        const target = next[targetIndex]
        if (target) next[targetIndex] = attachReadResultToToolNode(target, node)
        continue
      }
    }
    next.push(node)
  }

  return next
}

function navigationKey(navigation: AgentTimelineItem['navigation']) {
  if (!navigation) return ''
  return JSON.stringify({
    route: navigation.route,
    panel: navigation.panel ?? null,
    focusRecordId: navigation.focusRecordId ?? null,
    ledgerFilters: navigation.ledgerFilters ?? null,
  })
}

function dedupeAttachedNavigationItems(items: AgentTimelineItem[]) {
  const attachedNavigationKeys = new Set(
    items
      .filter((item) => (
        item.navigation &&
        (item.kind === 'tool_call' || item.kind === 'tool_result' || item.kind === 'confirmation' || item.kind === 'action_edit')
      ))
      .map((item) => navigationKey(item.navigation)),
  )
  const emittedStandaloneNavigationKeys = new Set<string>()
  return items.filter((item) => {
    if (item.kind !== 'navigation' || !item.navigation) return true
    const key = navigationKey(item.navigation)
    if (attachedNavigationKeys.has(key)) return false
    if (emittedStandaloneNavigationKeys.has(key)) return false
    emittedStandaloneNavigationKeys.add(key)
    return true
  })
}

function navigationTitleFromEvent(navigation: AgentTimelineItem['navigation']) {
  if (!navigation) return '已打开对应页面'
  const tab = navigation.route.mainTab === 'bookkeeping'
    ? '记实际'
    : navigation.route.mainTab === 'inputs'
      ? '调模型'
      : navigation.route.mainTab === 'variance'
        ? '看偏差'
        : '看测算'
  return `已打开：${tab}`
}

function navigationNodeFromSource(source: PendingTranscriptNode, navigation: NonNullable<AgentTimelineItem['navigation']>, offset: number): PendingTranscriptNode {
  return {
    id: `node-navigation-${source.id}-${offset}`,
    threadId: source.threadId,
    runId: source.runId,
    sequence: source.sequence,
    kind: 'navigation',
    title: navigationTitleFromEvent(navigation),
    summary: navigation.reason,
    status: source.status === 'failed' ? 'failed' : 'completed',
    visibility: 'user',
    defaultOpen: false,
    disclosure: {
      kind: 'navigation',
      defaultOpen: false,
    },
    navigation,
    createdAt: source.createdAt,
    order: source.order + 0.1 + offset / 100,
  }
}

function attachNavigationRows(nodes: PendingTranscriptNode[]): PendingTranscriptNode[] {
  const seen = new Set<string>()
  const next: PendingTranscriptNode[] = []
  nodes.forEach((node, index) => {
    if (node.kind === 'navigation' && node.navigation) {
      const key = navigationKey(node.navigation)
      if (seen.has(key)) return
      seen.add(key)
      next.push(node)
      return
    }
    next.push(node)
    if (!node.navigation) return
    const key = navigationKey(node.navigation)
    if (seen.has(key)) return
    seen.add(key)
    next.push(navigationNodeFromSource(node, node.navigation, index))
  })
  return next
}

function businessCheckNode(runKey: string, children: AgentTranscriptNode[], order: number): PendingTranscriptNode | null {
  const flattened = flattenTranscriptChildren(children)
  const failedCount = flattened.filter((node) => node.status === 'failed').length
  if (failedCount === 0) return null

  return {
    id: `node-business-check-${runKey}`,
    threadId: children[0]?.threadId ?? '',
    runId: children[0]?.runId ?? null,
    sequence: children[0]?.sequence ?? 0,
    kind: 'evaluation',
    title: '业务检查',
    summary: `有 ${failedCount} 个步骤失败，请展开查看并修复。`,
    status: 'failed',
    visibility: 'user',
    defaultOpen: false,
    disclosure: {
      kind: 'audit',
      defaultOpen: false,
    },
    createdAt: children.at(-1)?.createdAt ?? children[0]?.createdAt ?? new Date(0).toISOString(),
    order,
  }
}

function workGroupNode(runKey: string, items: AgentTimelineItem[], children: AgentTranscriptNode[], order: number): PendingTranscriptNode {
  const status = groupStatus(children)
  const toolCount = flattenTranscriptChildren(children)
    .filter((node) => node.kind === 'tool_call' || node.kind === 'tool_result').length
  const pendingCount = pendingNodeCount(children)
  const failedCount = flattenTranscriptChildren(children)
    .filter((node) => node.status === 'failed').length
  return {
    id: `node-work-group-${runKey}`,
    threadId: children[0]?.threadId ?? '',
    runId: children[0]?.runId ?? null,
    sequence: children[0]?.sequence ?? 0,
    kind: 'work_group',
    title: `Worked for ${readableElapsed(items)} / ${toolCount} tools / ${pendingCount} pending`,
    summary: [
      toolCount ? `${toolCount} 个工具` : null,
      pendingCount ? `${pendingCount} 个待确认` : null,
      failedCount ? `${failedCount} 个失败` : null,
      `${children.length} 个可见步骤`,
    ].filter(Boolean).join(' / '),
    status,
    visibility: 'user',
    defaultOpen: true,
    disclosure: {
      kind: 'group',
      defaultOpen: true,
    },
    children,
    createdAt: children[0]?.createdAt ?? new Date(0).toISOString(),
    order,
  }
}

function toolGroupChild(node: AgentTranscriptNode) {
  return node.kind === 'tool_call' ||
    node.kind === 'tool_result' ||
    node.kind === 'navigation' ||
    node.kind === 'confirmation' ||
    node.kind === 'action_update'
}

function groupRunSegment(items: AgentTimelineItem[]): PendingTranscriptNode[] {
  const nodes = attachNavigationRows(mergeReadResultPlanStepsIntoToolNodes(mergeProviderToolCallsIntoActionNodes(items.map(timelineItemToNode))))
    .filter((node) => node.visibility === 'user')
  if (nodes.length === 0) return []
  const runKey = items[0]?.runId ?? items[0]?.threadId ?? 'no-run'
  const toolGroupChildren = nodes.filter(toolGroupChild)
  const otherChildren = nodes.filter((node) => !toolGroupChild(node) && node.kind !== 'evaluation')
  const groupedChildren: PendingTranscriptNode[] = [
    ...(toolGroupChildren.length > 0
      ? [toolGroupNode(runKey, toolGroupChildren, Math.min(...toolGroupChildren.map((node) => node.order)))]
      : []),
    ...otherChildren,
  ].sort((left, right) => left.order - right.order)
  const checkNode = businessCheckNode(runKey, groupedChildren, Math.max(...nodes.map((node) => node.order)) + 0.5)
  if (checkNode) groupedChildren.push(checkNode)
  return [
    workGroupNode(runKey, items, groupedChildren, Math.min(...nodes.map((node) => node.order))),
  ]
}

function stripTranscriptNodeOrder(node: PendingTranscriptNode, sequence: number): AgentTranscriptNode {
  const { order: _order, children, ...rest } = node
  return {
    ...rest,
    sequence,
    ...(children?.length
      ? { children: children.map((child, index) => stripTranscriptNodeOrder(child as PendingTranscriptNode, index + 1)) }
      : {}),
  }
}

export function buildAgentTranscriptNodes(state: AgentProjectionState): AgentTranscriptNode[] {
  const timelineItems = dedupeAttachedNavigationItems(buildAgentTimelineItems(state))
  const operationalItemsByRun = new Map<string, AgentTimelineItem[]>()
  const nodes: PendingTranscriptNode[] = []

  for (const item of timelineItems) {
    if (!item) continue
    if ((isMessageTimelineItem(item) || item.visibility === 'technical') && !isMergeableReadResultTimelineItem(item)) continue
    const runKey = item.runId ?? `${item.threadId}:no-run`
    const items = operationalItemsByRun.get(runKey) ?? []
    items.push(item)
    operationalItemsByRun.set(runKey, items)
  }

  const emittedRuns = new Set<string>()
  for (const item of timelineItems) {
    if (!item) continue
    if (item.visibility === 'technical' && !isMergeableReadResultTimelineItem(item)) {
      nodes.push(timelineItemToNode(item))
      continue
    }
    if (isMessageTimelineItem(item) && !isMergeableReadResultTimelineItem(item)) {
      nodes.push(timelineItemToNode(item))
      continue
    }
    const runKey = item.runId ?? `${item.threadId}:no-run`
    if (emittedRuns.has(runKey)) continue
    emittedRuns.add(runKey)
    nodes.push(...groupRunSegment(operationalItemsByRun.get(runKey) ?? [item]))
  }

  return nodes
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node, index) => stripTranscriptNodeOrder(node, index + 1))
}
