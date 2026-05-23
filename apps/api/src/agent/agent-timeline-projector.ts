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
  return item.kind === 'message' && hasFinalAssistantMessageForRun(state)
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
          merged[existingIndex] = {
            ...existing,
            title: item.title || existing.title,
            summary: item.summary || existing.summary,
            status: item.status,
            ...((item.content || existing.content) ? { content: item.content || existing.content } : {}),
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

function providerToolCallCompletedStatus(state: AgentProjectionState, runId: string | null | undefined): AgentTimelineItem['status'] | null {
  if (!runId) return null
  let streamCompleted = false
  for (const event of state.runEvents) {
    if (event.runId !== runId) continue
    if (event.type === 'run_failed') return 'failed'
    if (event.type === 'run_cancelled') return 'cancelled'
    if (event.type === 'run_completed') return 'completed'
    if (event.type === 'provider_stream_completed') streamCompleted = true
  }
  return streamCompleted ? 'completed' : null
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
  return finiteTime(item.createdAt) * 1000 + item.sequence
}

function groupStatus(nodes: AgentTranscriptNode[]): AgentTimelineItem['status'] {
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.some((node) => node.status === 'waiting')) return 'waiting'
  if (nodes.some((node) => node.status === 'running' || node.status === 'pending')) return 'running'
  if (nodes.some((node) => node.status === 'cancelled')) return 'cancelled'
  if (nodes.length > 0 && nodes.every((node) => node.status === 'completed')) return 'completed'
  return 'info'
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
  return item.summary
}

function timelineItemSections(item: AgentTimelineItem): AgentTranscriptSection[] {
  const sections: AgentTranscriptSection[] = []
  const argumentsPreview = toolArgumentsPreview(item)
  if (argumentsPreview) {
    sections.push({
      id: `${item.id}:arguments`,
      kind: 'arguments',
      title: '参数',
      summary: argumentsPreview.replace(/\s+/g, ' ').slice(0, 180),
      content: argumentsPreview,
      defaultOpen: false,
    })
  }
  if (item.details?.length) {
    sections.push({
      id: `${item.id}:details`,
      kind: 'details',
      title: '明细',
      summary: `${item.details.length} 项`,
      details: item.details,
      defaultOpen: item.status === 'waiting',
    })
  }
  if (item.navigation) {
    sections.push({
      id: `${item.id}:navigation`,
      kind: 'navigation',
      title: '页面',
      summary: item.navigation.reason,
      navigation: item.navigation,
      defaultOpen: item.status === 'waiting',
    })
  }
  if (item.kind === 'tool_result' || item.kind === 'tool_call') {
    const result = toolResultPreview(item)
    if (result) {
      sections.push({
        id: `${item.id}:result`,
        kind: 'result',
        title: item.kind === 'tool_result' ? '结果' : '预览',
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
  if (rawPayload) {
    sections.push({
      id: `${item.id}:raw`,
      kind: 'raw',
      title: '原始数据',
      summary: 'JSON',
      content: compactJson(rawPayload),
      payload: rawPayload,
      defaultOpen: false,
    })
  }
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
    summary: item.summary,
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
  const pendingCount = children.filter((node) => node.actionRequest?.status === 'pending' || node.status === 'waiting').length
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
    defaultOpen: status === 'failed' || status === 'waiting' || status === 'running',
    disclosure: {
      kind: 'group',
      defaultOpen: status === 'failed' || status === 'waiting' || status === 'running',
    },
    children,
    createdAt: children[0]?.createdAt ?? new Date(0).toISOString(),
    order,
  }
}

function comparableToolName(value: string | null | undefined) {
  return value?.replaceAll('.', '_').replaceAll('-', '_') ?? ''
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
      const actionToolName = comparableToolName(node.tool?.name ?? node.actionRequest.kind)
      if (!actionToolName) return node

      let providerIndex = -1
      for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex -= 1) {
        const candidate = nodes[candidateIndex]
        if (
          candidate &&
          candidate.kind === 'tool_call' &&
          !candidate.actionRequest &&
          !consumedProviderNodeIds.has(candidate.id) &&
          comparableToolName(candidate.tool?.name) === actionToolName
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
            ...(providerNode.tool?.argumentsPreview ? { argumentsPreview: providerNode.tool.argumentsPreview } : {}),
            ...(providerNode.tool?.resultPreview && !node.tool.resultPreview ? { resultPreview: providerNode.tool.resultPreview } : {}),
          }
        : null

      return {
        ...node,
        order: Math.min(providerNode.order, node.order),
        ...(mergedTool ? { tool: mergedTool } : {}),
        ...(mergedSections ? { sections: mergedSections } : {}),
      }
    })
    .filter((node) => !consumedProviderNodeIds.has(node.id))
}

function workGroupNode(runKey: string, items: AgentTimelineItem[], children: AgentTranscriptNode[], order: number): PendingTranscriptNode {
  const status = groupStatus(children)
  const toolCount = children.flatMap((node) => node.kind === 'tool_group' ? node.children ?? [] : [node])
    .filter((node) => node.kind === 'tool_call' || node.kind === 'tool_result').length
  const pendingCount = children.flatMap((node) => node.kind === 'tool_group' ? node.children ?? [] : [node])
    .filter((node) => node.actionRequest?.status === 'pending' || node.status === 'waiting').length
  const failedCount = children.flatMap((node) => node.kind === 'tool_group' ? node.children ?? [] : [node])
    .filter((node) => node.status === 'failed').length
  return {
    id: `node-work-group-${runKey}`,
    threadId: children[0]?.threadId ?? '',
    runId: children[0]?.runId ?? null,
    sequence: children[0]?.sequence ?? 0,
    kind: 'work_group',
    title: `本轮工作 ${readableElapsed(items)}`,
    summary: [
      toolCount ? `${toolCount} 个工具` : null,
      pendingCount ? `${pendingCount} 个待确认` : null,
      failedCount ? `${failedCount} 个失败` : null,
      `${children.length} 个可见步骤`,
    ].filter(Boolean).join(' / '),
    status,
    visibility: 'user',
    defaultOpen: status === 'failed' || status === 'waiting' || status === 'running',
    disclosure: {
      kind: 'group',
      defaultOpen: status === 'failed' || status === 'waiting' || status === 'running',
    },
    children,
    createdAt: children[0]?.createdAt ?? new Date(0).toISOString(),
    order,
  }
}

function groupRunSegment(items: AgentTimelineItem[]): PendingTranscriptNode[] {
  const nodes = mergeProviderToolCallsIntoActionNodes(items.map(timelineItemToNode))
  const toolLike = nodes.filter((node) => node.kind === 'tool_call' || node.kind === 'tool_result')
  const shouldUseWorkGroup = nodes.length > 3 || toolLike.length > 1
  if (!shouldUseWorkGroup) return nodes
  const runKey = items[0]?.runId ?? items[0]?.threadId ?? 'no-run'
  const nonToolNodes = nodes.filter((node) => node.kind !== 'tool_call' && node.kind !== 'tool_result')
  const groupedChildren = toolLike.length > 1
    ? [
        toolGroupNode(runKey, toolLike, Math.min(...toolLike.map((node) => node.order))),
        ...nonToolNodes,
      ].sort((left, right) => left.order - right.order)
    : nodes
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
  const timelineItems = buildAgentTimelineItems(state)
  const nodes: PendingTranscriptNode[] = []

  for (let index = 0; index < timelineItems.length; index += 1) {
    const item = timelineItems[index]
    if (!item) continue
    if (isMessageTimelineItem(item) || item.visibility === 'technical') {
      nodes.push(timelineItemToNode(item))
      continue
    }
    const segment: AgentTimelineItem[] = [item]
    const runKey = item.runId ?? ''
    while (index + 1 < timelineItems.length) {
      const next = timelineItems[index + 1]
      if (!next || isMessageTimelineItem(next) || next.visibility === 'technical') break
      const nextRunKey = next.runId ?? ''
      if (nextRunKey !== runKey) break
      segment.push(next)
      index += 1
    }
    nodes.push(...groupRunSegment(segment))
  }

  return nodes
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((node, index) => stripTranscriptNodeOrder(node, index + 1))
}
