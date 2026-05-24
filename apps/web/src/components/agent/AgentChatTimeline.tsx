import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Clock3, Code2, FileCheck2, Layers3, MemoryStick, Navigation, TerminalSquare, UserRound, Wrench, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AgentActionUpdatePayload, AgentTranscriptNode, AgentTranscriptSection } from '../../lib/api'
import { useAgentTranscriptExpansion } from '../../hooks/useAgentTranscriptExpansion'
import { formatAgentNavigationTarget } from './agentNavigation'
import { AgentActionCard } from './AgentActionCard'
import { AgentMarkdown } from './AgentMarkdown'

const statusLabels: Record<AgentTranscriptNode['status'], string> = {
  pending: '待开始',
  running: '进行中',
  waiting: '待确认',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  info: '信息',
}

const kindLabels: Record<AgentTranscriptNode['kind'], string> = {
  user_message: '用户',
  assistant_message: '回复',
  assistant_stream: '实时回复',
  work_group: '工作组',
  tool_group: '工具组',
  tool_call: '工具调用',
  tool_result: '工具结果',
  navigation: '页面',
  confirmation: '确认',
  action_update: '编辑',
  memory: '记忆',
  evaluation: '检查',
  summary: '总结',
  technical_group: '技术组',
  technical: '技术',
}

export type AgentChatTimelineSummary = {
  visibleCount: number
  technicalCount: number
  toolCount: number
  waitingCount: number
  failedCount: number
}

function flattenNodes(nodes: AgentTranscriptNode[]): AgentTranscriptNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])])
}

export function userTimelineItems(nodes: AgentTranscriptNode[]) {
  return nodes.filter((node) => node.visibility === 'user' && shouldRenderTranscriptNode(node))
}

export function technicalTimelineItems(nodes: AgentTranscriptNode[]) {
  return nodes.filter((node) => node.visibility === 'technical')
}

export function summarizeAgentChatTimeline(nodes: AgentTranscriptNode[]): AgentChatTimelineSummary {
  const flattened = flattenNodes(nodes).filter(shouldRenderTranscriptNode)
  const visible = flattened.filter((node) => node.visibility === 'user')
  return {
    visibleCount: visible.length,
    technicalCount: flattened.filter((node) => node.visibility === 'technical').length,
    toolCount: visible.filter((node) => node.kind === 'tool_call' || node.kind === 'tool_result').length,
    waitingCount: visible.filter((node) => node.status === 'waiting').length,
    failedCount: visible.filter((node) => node.status === 'failed').length,
  }
}

export function formatTimelineStatus(status: AgentTranscriptNode['status']) {
  return statusLabels[status]
}

export function shouldShowTimelineThinking(nodes: AgentTranscriptNode[], busy: boolean) {
  if (!busy) return false
  const visible = flattenNodes(nodes).filter((node) => node.visibility === 'user')
  if (visible.length === 0) return true
  const latestUserIndex = visible.map((node) => node.kind).lastIndexOf('user_message')
  if (latestUserIndex === -1) return false
  const afterLatestUser = visible.slice(latestUserIndex + 1)
  if (afterLatestUser.some((node) => node.kind === 'assistant_message')) return false
  if (afterLatestUser.some((node) => node.status === 'waiting' || node.status === 'failed' || node.status === 'cancelled')) return false
  return true
}

export function timelineThinkingLabel(nodes: AgentTranscriptNode[]) {
  const visible = flattenNodes(nodes).filter((node) => node.visibility === 'user')
  const latestUserIndex = visible.map((node) => node.kind).lastIndexOf('user_message')
  const afterLatestUser = latestUserIndex >= 0 ? visible.slice(latestUserIndex + 1) : visible
  if (afterLatestUser.some((node) => node.kind === 'tool_call' || node.kind === 'tool_result' || node.kind === 'navigation')) {
    return '正在生成回复'
  }
  return '正在处理'
}

function hasBlockingChild(node: AgentTranscriptNode): boolean {
  return node.status === 'waiting' ||
    node.status === 'failed' ||
    node.status === 'cancelled' ||
    Boolean(node.actionRequest?.status === 'pending') ||
    Boolean(node.children?.some(hasBlockingChild))
}

function collapsibleAfterFinalAnswer(node: AgentTranscriptNode) {
  if (hasBlockingChild(node)) return false
  return node.kind === 'work_group' ||
    node.kind === 'tool_group' ||
    node.kind === 'tool_call' ||
    node.kind === 'tool_result' ||
    node.kind === 'navigation' ||
    node.kind === 'evaluation' ||
    node.kind === 'summary'
}

function collapseNodeAfterFinalAnswer(node: AgentTranscriptNode, finalizedRunIds: Set<string>): AgentTranscriptNode {
  const shouldCollapse = Boolean(node.runId && finalizedRunIds.has(node.runId) && collapsibleAfterFinalAnswer(node))
  return {
    ...node,
    ...(shouldCollapse ? { defaultOpen: false } : {}),
    ...(shouldCollapse && node.disclosure ? { disclosure: { ...node.disclosure, defaultOpen: false } } : {}),
    ...(node.children?.length
      ? { children: node.children.map((child) => collapseNodeAfterFinalAnswer(child, finalizedRunIds)) }
      : {}),
    ...(node.sections?.length
      ? { sections: node.sections.map((section) => ({ ...section, defaultOpen: shouldCollapse ? false : section.defaultOpen })) }
      : {}),
  }
}

export function collapseCompletedWorkBeforeFinalAnswer(nodes: AgentTranscriptNode[]) {
  const finalizedRunIds = new Set(
    flattenNodes(nodes)
      .filter((node) => node.visibility === 'user' && node.kind === 'assistant_message' && node.runId)
      .map((node) => node.runId as string),
  )
  if (finalizedRunIds.size === 0) return nodes
  return nodes.map((node) => collapseNodeAfterFinalAnswer(node, finalizedRunIds))
}

function isToolGroupEntry(node: AgentTranscriptNode) {
  return node.kind === 'tool_call' || node.kind === 'tool_result'
}

function toolGroupTitleFor(children: AgentTranscriptNode[]) {
  const count = children.filter(isToolGroupEntry).length
  return count > 0 ? `调用 ${count} 个工具` : '调用工具'
}

function liftMixedToolGroupChild(child: AgentTranscriptNode): AgentTranscriptNode[] {
  const normalized = normalizeTranscriptGroupsForDisplayNode(child)
  if (normalized.kind !== 'tool_group' || !normalized.children?.length) return [normalized]

  const toolChildren = normalized.children.filter(isToolGroupEntry)
  const nonToolChildren = normalized.children.filter((candidate) => !isToolGroupEntry(candidate))
  if (nonToolChildren.length === 0) return [normalized]
  return [
    ...(toolChildren.length > 0
      ? [{ ...normalized, title: toolGroupTitleFor(toolChildren), children: toolChildren }]
      : []),
    ...nonToolChildren,
  ]
}

function normalizeTranscriptGroupsForDisplayNode(node: AgentTranscriptNode): AgentTranscriptNode {
  if (!node.children?.length) return node
  return {
    ...node,
    children: node.children.flatMap(liftMixedToolGroupChild),
  }
}

export function normalizeTranscriptGroupsForDisplay(nodes: AgentTranscriptNode[]) {
  return nodes.map(normalizeTranscriptGroupsForDisplayNode)
}

function statusClass(status: AgentTranscriptNode['status']) {
  if (status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'waiting' || status === 'pending' || status === 'running') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700'
  if (status === 'cancelled') return 'border-stone-200 bg-stone-100 text-stone-500'
  return 'border-sky-200 bg-sky-50 text-sky-700'
}

function StatusIcon(props: { status: AgentTranscriptNode['status'] }) {
  if (props.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />
  if (props.status === 'failed') return <AlertTriangle className="h-3.5 w-3.5" />
  if (props.status === 'cancelled') return <XCircle className="h-3.5 w-3.5" />
  if (props.status === 'waiting' || props.status === 'pending' || props.status === 'running') return <Clock3 className="h-3.5 w-3.5" />
  return <Code2 className="h-3.5 w-3.5" />
}

function KindIcon(props: { kind: AgentTranscriptNode['kind'] }) {
  if (props.kind === 'user_message') return <UserRound className="h-3.5 w-3.5" />
  if (props.kind === 'assistant_message' || props.kind === 'assistant_stream' || props.kind === 'summary') return <Bot className="h-3.5 w-3.5" />
  if (props.kind === 'work_group' || props.kind === 'tool_group') return <Layers3 className="h-3.5 w-3.5" />
  if (props.kind === 'tool_call' || props.kind === 'tool_result') return <Wrench className="h-3.5 w-3.5" />
  if (props.kind === 'navigation') return <Navigation className="h-3.5 w-3.5" />
  if (props.kind === 'confirmation' || props.kind === 'action_update') return <FileCheck2 className="h-3.5 w-3.5" />
  if (props.kind === 'memory') return <MemoryStick className="h-3.5 w-3.5" />
  return <TerminalSquare className="h-3.5 w-3.5" />
}

function isMessage(node: AgentTranscriptNode) {
  return node.kind === 'user_message' || node.kind === 'assistant_message' || node.kind === 'assistant_stream' || node.kind === 'summary'
}

function isToolNode(node: AgentTranscriptNode) {
  return node.kind === 'tool_call' || node.kind === 'tool_result'
}

const decorativeSummaryPatterns = [
  /^\d+ 个工具\s*\/\s*\d+ 个可见步骤$/,
  /^\d+ 个可见步骤$/,
  /^\d+ 个步骤$/,
  /^工具已选择，参数可展开查看。?$/,
  /^参数和结果可展开查看。?$/,
  /^参数可展开查看。?$/,
  /^结果已用于本轮回复。?$/,
  /^工具调用已完成，结果已用于本轮回复(?:或后续业务步骤)?。?$/,
  /^本次只读取当前工作区数据，未修改业务数据。?(?:\s*已打开 \d+ 个相关页面用于核对。?)?$/,
  /便于核对/,
]

function isDecorativeSummary(summary: string) {
  return decorativeSummaryPatterns.some((pattern) => pattern.test(summary.trim()))
}

function visibleSummary(summary: string | null | undefined) {
  if (!summary) return ''
  return isDecorativeSummary(summary) ? '' : summary
}

function visibleSectionContent(section: AgentTranscriptSection) {
  if (!section.content) return ''
  if (section.kind === 'raw' || section.kind === 'arguments') return section.content
  return visibleSummary(section.content)
}

function sectionInlineContent(section: AgentTranscriptSection) {
  const ownContent = visibleSectionContent(section)
  if (ownContent) return ownContent
  if (section.kind === 'arguments') {
    const rawChild = section.children?.find((child) => child.kind === 'raw')
    return rawChild ? visibleSectionContent(rawChild) : ''
  }
  return ''
}

function shouldRenderSection(section: AgentTranscriptSection): boolean {
  if (section.kind === 'raw') return false
  if (section.kind === 'confirmation' && section.actionRequest) return true
  return Boolean(
    visibleSummary(section.summary) ||
    sectionInlineContent(section) ||
    section.details?.length ||
    section.navigation ||
    section.children?.some(shouldRenderSection),
  )
}

function shouldRenderStandaloneSection(section: AgentTranscriptSection): boolean {
  if (section.kind === 'arguments' || section.kind === 'result' || section.kind === 'raw') return false
  return shouldRenderSection(section)
}

function toolBodyParts(node: AgentTranscriptNode) {
  if (!isToolNode(node)) return { argumentsContent: '', resultContent: '' }
  const sections = node.sections ?? []
  const argumentSection = sections.find((section) => section.kind === 'arguments')
  const resultSection = sections.find((section) => section.kind === 'result')
  return {
    argumentsContent: argumentSection ? sectionInlineContent(argumentSection) : node.tool?.argumentsPreview ?? '',
    resultContent: resultSection ? sectionInlineContent(resultSection) : node.tool?.resultPreview ?? '',
  }
}

function hasToolBody(node: AgentTranscriptNode) {
  const parts = toolBodyParts(node)
  return Boolean(parts.argumentsContent || parts.resultContent)
}

function canExpand(node: AgentTranscriptNode) {
  const hasSections = isToolNode(node)
    ? hasToolBody(node) || node.sections?.some(shouldRenderStandaloneSection)
    : node.sections?.some(shouldRenderSection)
  const hasNavigationDetail = node.kind !== 'navigation' && Boolean(node.navigation)
  return Boolean(
    node.children?.some(shouldRenderTranscriptNode) ||
    hasSections ||
    node.details?.length ||
    node.payload ||
    hasNavigationDetail,
  )
}

function compactRowSummary(node: AgentTranscriptNode) {
  const summary = node.summary ?? ''
  if (node.kind === 'navigation' && node.status === 'completed') {
    return ''
  }
  if ((node.kind === 'tool_call' || node.kind === 'tool_result') && /^[\s{[]/.test(summary)) {
    return ''
  }
  return visibleSummary(summary)
}

const workGroupTitlePattern = /^Worked for (?<elapsed>[^/]+) \/ (?<tools>\d+) tools \/ (?<pending>\d+) pending$/
const elapsedPattern = /^(?:(?<minutes>\d+)m\s*)?(?<seconds>\d+)s$/

const toolDisplayLabels: Record<string, string> = {
  data_query_workspace: '查询工作区数据',
  ui_navigate: '打开页面',
  workspace_rename: '重命名工作区',
  workspace_configure_operating_model: '配置经营模型',
  workspace_update_online_factor: '试算线上系数',
  workspace_patch_config: '修改模型参数',
  ledger_create_entry: '新增分录',
  ledger_update_entry: '修改分录',
  ledger_void_entry: '作废分录',
  ledger_restore_entry: '恢复分录',
  version_publish: '发布版本',
  version_restore: '恢复版本',
  share_create: '创建分享链接',
}

function parseElapsedSeconds(value: string | null | undefined) {
  if (!value) return null
  const match = value.trim().match(elapsedPattern)
  if (!match?.groups) return null
  const minutes = match.groups.minutes ? Number(match.groups.minutes) : 0
  const seconds = Number(match.groups.seconds)
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  return minutes * 60 + seconds
}

export function formatAgentElapsed(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return minutes > 0 ? `${minutes}分 ${remainder}秒` : `${remainder}秒`
}

export function formatWorkedForElapsed(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`
}

function elapsedSince(startedAt: string | null | undefined, nowMs: number) {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  if (!Number.isFinite(startedMs)) return 0
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000))
}

function elapsedBetween(startedAt: string | null | undefined, endedAt: string | null | undefined) {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN
  const endedMs = endedAt ? Date.parse(endedAt) : Number.NaN
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null
  return Math.max(0, Math.floor((endedMs - startedMs) / 1000))
}

function displayNodeTitle(node: AgentTranscriptNode, nowMs: number) {
  if (node.kind === 'work_group') {
    const match = node.title.match(workGroupTitlePattern)
    const tools = match?.groups?.tools ? Number(match.groups.tools) : 0
    const pending = match?.groups?.pending ? Number(match.groups.pending) : 0
    const parsedElapsed = parseElapsedSeconds(match?.groups?.elapsed)
    const runningElapsed = elapsedSince(node.createdAt, nowMs)
    const isRunning = node.status === 'running' || node.status === 'pending'
    const elapsed = isRunning ? runningElapsed : parsedElapsed ?? runningElapsed
    const elapsedLabel = isRunning
      ? `正在处理 ${formatAgentElapsed(elapsed)}`
      : elapsed > 0
        ? `用时 ${formatAgentElapsed(elapsed)}`
        : ''
    if (node.status === 'failed') return '执行遇到问题'
    if (pending > 0) return elapsedLabel ? `${elapsedLabel} · ${pending} 项待确认` : `${pending} 项待确认`
    if (tools > 0) return elapsedLabel ? `${elapsedLabel} · 已完成 ${tools} 个工具` : `已完成 ${tools} 个工具`
    return isRunning ? elapsedLabel : elapsedLabel ? `${elapsedLabel} · 执行完成` : '执行完成'
  }
  if ((node.kind === 'tool_call' || node.kind === 'tool_result') && node.tool?.name) {
    const toolName = node.tool.name
    if (!node.title.includes(toolName) && !node.title.startsWith('调用工具')) return node.title
    const label = toolDisplayLabels[toolName]
    if (label) return label
    return node.title.includes(toolName) ? '调用工具' : node.title
  }
  return node.title
}

function shouldShowKindBadge(node: AgentTranscriptNode) {
  if (node.kind === 'work_group' || node.kind === 'tool_group') return false
  if ((node.kind === 'tool_call' || node.kind === 'tool_result') && node.tool?.name) return false
  return true
}

function hasRenderableContent(node: AgentTranscriptNode): boolean {
  return Boolean(
    visibleSummary(node.summary) ||
    node.content ||
    (isToolNode(node) ? hasToolBody(node) || node.sections?.some(shouldRenderStandaloneSection) : node.sections?.some(shouldRenderSection)) ||
    node.details?.length ||
    node.payload ||
    node.navigation ||
    node.actionRequest ||
    node.children?.some(shouldRenderTranscriptNode),
  )
}

export function shouldRenderTranscriptNode(node: AgentTranscriptNode) {
  if (node.kind === 'evaluation' && node.status === 'completed' && !hasRenderableContent(node)) {
    return false
  }
  return true
}

function TimelineStatusBadge(props: { status: AgentTranscriptNode['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${statusClass(props.status)}`}>
      <StatusIcon status={props.status} />
      {formatTimelineStatus(props.status)}
    </span>
  )
}

function TimelineMessage(props: { node: AgentTranscriptNode }) {
  const isUser = props.node.kind === 'user_message'
  const isStream = props.node.kind === 'assistant_stream'
  const source = props.node.content ?? props.node.summary ?? ''
  if (!isUser) {
    return (
      <div className="flex justify-start" data-transcript-kind={props.node.kind} data-transcript-id={props.node.id}>
        <AgentMarkdown
          source={source}
          streaming={isStream}
          className={isStream ? 'border-l-2 border-stone-300 pl-2 text-stone-600' : ''}
        />
      </div>
    )
  }
  return (
    <div className="flex justify-end" data-transcript-kind={props.node.kind} data-transcript-id={props.node.id}>
      <p className="max-w-[92%] whitespace-pre-wrap break-words rounded-lg bg-stone-950 px-3 py-1.5 text-right text-sm font-medium leading-6 text-white shadow-sm">
        {source}
      </p>
    </div>
  )
}

function ThinkingRow(props: { startedAt: string | null; nowMs: number; label: string }) {
  const elapsed = elapsedSince(props.startedAt, props.nowMs)
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-stone-500">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-stone-300 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-stone-500" />
      </span>
      <span>{props.label} {formatAgentElapsed(elapsed)}</span>
    </div>
  )
}

function TurnDurationHeader(props: { startedAt: string | null; endedAt: string | null; active: boolean; nowMs: number }) {
  const elapsed = props.endedAt
    ? elapsedBetween(props.startedAt, props.endedAt) ?? 0
    : props.active
      ? elapsedSince(props.startedAt, props.nowMs)
      : 0
  return (
    <div className="px-1 pb-0.5 text-[11px] font-medium leading-4 text-stone-500" data-transcript-turn-duration="true">
      Worked for {formatWorkedForElapsed(elapsed)}
    </div>
  )
}

function SectionLabel(props: { kind: AgentTranscriptSection['kind']; title: string }) {
  if (props.kind === 'arguments') return <>参数</>
  if (props.kind === 'result') return <>返回</>
  if (props.kind === 'details') return <>详情</>
  return <>{props.title}</>
}

function SectionBody(props: {
  section: AgentTranscriptSection
  busy: boolean
  diffDetails: Array<{ label: string; value: string }>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  const navigationLabel = formatAgentNavigationTarget(props.section.navigation ?? null)
  const sectionContent = sectionInlineContent(props.section)
  if (props.section.kind === 'confirmation' && props.section.actionRequest) {
    return (
      <AgentActionCard
        action={props.section.actionRequest}
        diffDetails={props.diffDetails}
        busy={props.busy}
        layout="inline"
        onConfirm={props.onConfirm}
        onCancel={props.onCancel}
        onUpdate={props.onUpdate}
      />
    )
  }
  return (
    <div className="grid gap-1.5 text-[11px]">
      {navigationLabel ? (
        <p className="inline-flex max-w-full items-center gap-1 text-stone-500">
          <Navigation className="h-3 w-3 shrink-0" />
          <span className="truncate">{navigationLabel}</span>
        </p>
      ) : null}
      {props.section.details?.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          {props.section.details.map((detail) => (
            <div key={`${props.section.id}-${detail.label}`} className="min-w-0">
              <dt className="text-stone-400">{detail.label}</dt>
              <dd className="break-words font-medium text-stone-700">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {sectionContent ? (
        props.section.kind === 'arguments'
          ? (
              <pre className="max-h-48 overflow-auto rounded-md bg-stone-950 px-2 py-1.5 text-[10px] leading-4 text-stone-100 shadow-inner">
                {sectionContent}
              </pre>
            )
          : <p className="whitespace-pre-wrap break-words text-stone-600">{sectionContent}</p>
      ) : null}
    </div>
  )
}

function InlineSection(props: {
  node: AgentTranscriptNode
  section: AgentTranscriptSection
  busy: boolean
  diffDetails: Array<{ label: string; value: string }>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  if (props.section.kind === 'raw') return null
  if (props.section.kind === 'confirmation') {
    return (
      <div className="border-t border-stone-100 py-1 first:border-t-0" data-transcript-section-kind={props.section.kind} data-transcript-section-id={props.section.id}>
        <SectionBody
          section={props.section}
          busy={props.busy}
          diffDetails={props.diffDetails}
          onConfirm={props.onConfirm}
          onCancel={props.onCancel}
          onUpdate={props.onUpdate}
        />
      </div>
    )
  }
  return (
    <div className="border-t border-stone-100 py-1 first:border-t-0" data-transcript-section-kind={props.section.kind} data-transcript-section-id={props.section.id}>
      <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2 py-1">
        <span className="pt-0.5 text-[11px] font-semibold text-stone-500">
          <SectionLabel kind={props.section.kind} title={props.section.title} />
        </span>
        <SectionBody
          section={props.section}
          busy={props.busy}
          diffDetails={props.diffDetails}
          onConfirm={props.onConfirm}
          onCancel={props.onCancel}
          onUpdate={props.onUpdate}
        />
      </div>
    </div>
  )
}

function ToolBody(props: { node: AgentTranscriptNode }) {
  const { argumentsContent, resultContent } = toolBodyParts(props.node)
  if (!argumentsContent && !resultContent) return null

  return (
    <div
      className="grid max-h-56 gap-1.5 overflow-auto border-l border-stone-200 py-1 pl-3 text-[11px] leading-5"
      data-transcript-tool-body="true"
    >
      {argumentsContent ? (
        <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-2">
          <span className="font-semibold text-stone-500">参数</span>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-stone-700">
            {argumentsContent}
          </pre>
        </div>
      ) : null}
      {resultContent ? (
        <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-2">
          <span className="font-semibold text-stone-500">返回</span>
          <p className="min-w-0 whitespace-pre-wrap break-words text-stone-600">{resultContent}</p>
        </div>
      ) : null}
    </div>
  )
}

function NodeRow(props: {
  node: AgentTranscriptNode
  turnStartedAt: string | null
  turnEndedAt: string | null
  turnActive: boolean
  nowMs: number
  expanded: boolean
  onToggle: () => void
}) {
  const expandable = canExpand(props.node)
  const rowSummary = compactRowSummary(props.node)
  const title = displayNodeTitle(props.node, props.nowMs)
  return (
    <div className="grid min-h-7 grid-cols-[18px_20px_minmax(0,1fr)_auto] items-center gap-1.5">
      {expandable ? (
        <button
          type="button"
          onClick={props.onToggle}
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
          title={props.expanded ? '收起详情' : '展开详情'}
          aria-expanded={props.expanded}
        >
          {props.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="flex h-5 w-5 items-center justify-center text-stone-500">
        <KindIcon kind={props.node.kind} />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs font-semibold text-stone-950">{title}</span>
        {shouldShowKindBadge(props.node) ? (
          <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500">
            {kindLabels[props.node.kind]}
          </span>
        ) : null}
        {props.node.tool?.name ? (
          <span className="max-w-[220px] shrink truncate rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700">
            {props.node.tool.name}
          </span>
        ) : null}
        {rowSummary ? <span className="min-w-0 truncate text-[11px] text-stone-500">{rowSummary}</span> : null}
      </div>
      <div className="flex items-center gap-1">
        <TimelineStatusBadge status={props.node.status} />
      </div>
    </div>
  )
}

function nodeShellClass(kind: AgentTranscriptNode['kind']) {
  if (kind === 'work_group') return 'border-t border-stone-200 py-2'
  if (kind === 'tool_group') return 'ml-5 border-l border-stone-200 py-1 pl-3'
  if (kind === 'tool_call' || kind === 'tool_result') return 'border-t border-stone-100 py-1 first:border-t-0'
  if (kind === 'navigation' || kind === 'evaluation' || kind === 'memory' || kind === 'action_update') return 'border-t border-stone-100 py-1 first:border-t-0'
  return 'border-t border-stone-100 py-1 first:border-t-0'
}

function nodeDetailsClass(kind: AgentTranscriptNode['kind']) {
  if (kind === 'work_group' || kind === 'tool_group') return 'mt-1 grid gap-1'
  return 'ml-7 mt-1 grid gap-1.5'
}

function TranscriptNodeView(props: {
  node: AgentTranscriptNode
  depth?: number
  turnStartedAt: string | null
  turnEndedAt: string | null
  turnActive: boolean
  nowMs: number
  expanded: ReturnType<typeof useAgentTranscriptExpansion>
  busy: boolean
  actionDiffsById: Map<string, Array<{ label: string; value: string }>>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  if (isMessage(props.node)) return <TimelineMessage node={props.node} />

  const nodeOpen = props.expanded.isNodeExpanded(props.node)
  const diffDetails = props.node.actionRequestId ? props.actionDiffsById.get(props.node.actionRequestId) ?? [] : []
  return (
    <div className={nodeShellClass(props.node.kind)} data-transcript-kind={props.node.kind} data-transcript-id={props.node.id}>
      <NodeRow
        node={props.node}
        turnStartedAt={props.turnStartedAt}
        turnEndedAt={props.turnEndedAt}
        turnActive={props.turnActive}
        nowMs={props.nowMs}
        expanded={nodeOpen}
        onToggle={() => props.expanded.toggleNode(props.node)}
      />
      {nodeOpen ? (
        <div className={nodeDetailsClass(props.node.kind)}>
          {isToolNode(props.node) ? <ToolBody node={props.node} /> : null}
          {props.node.sections?.filter(isToolNode(props.node) ? shouldRenderStandaloneSection : shouldRenderSection).map((section) => (
            <InlineSection
              key={section.id}
              node={props.node}
              section={section}
              busy={props.busy}
              diffDetails={diffDetails}
              onConfirm={props.onConfirm}
              onCancel={props.onCancel}
              onUpdate={props.onUpdate}
            />
          ))}
          {props.node.children?.filter(shouldRenderTranscriptNode).map((child) => (
            <TranscriptNodeView
              key={child.id}
              node={child}
              depth={(props.depth ?? 0) + 1}
              turnStartedAt={props.turnStartedAt}
              turnEndedAt={props.turnEndedAt}
              turnActive={props.turnActive}
              nowMs={props.nowMs}
              expanded={props.expanded}
              busy={props.busy}
              actionDiffsById={props.actionDiffsById}
              onConfirm={props.onConfirm}
              onCancel={props.onCancel}
              onUpdate={props.onUpdate}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AgentChatTimeline(props: {
  nodes: AgentTranscriptNode[]
  busy: boolean
  actionDiffsById: Map<string, Array<{ label: string; value: string }>>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
  className?: string
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const displayNodes = useMemo(() => normalizeTranscriptGroupsForDisplay(collapseCompletedWorkBeforeFinalAnswer(props.nodes)), [props.nodes])
  const visible = userTimelineItems(displayNodes)
  const technical = technicalTimelineItems(props.nodes)
  const summary = summarizeAgentChatTimeline(displayNodes)
  const showThinking = shouldShowTimelineThinking(displayNodes, props.busy)
  const thinkingLabel = timelineThinkingLabel(displayNodes)
  const expansion = useAgentTranscriptExpansion(displayNodes)
  const hasRunningVisibleNode = flattenNodes(visible).some((node) => node.status === 'running' || node.status === 'pending')
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (!props.busy && !hasRunningVisibleNode) return undefined
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasRunningVisibleNode, props.busy])

  const turnTimingByNodeId = useMemo(() => {
    const timing = new Map<string, { startedAt: string | null; endedAt: string | null }>()
    let currentStartedAt: string | null = null
    let currentNodeIds: string[] = []
    visible.forEach((node) => {
      if (node.kind === 'user_message') {
        currentStartedAt = node.createdAt
        currentNodeIds = []
      }
      currentNodeIds.push(node.id)
      timing.set(node.id, { startedAt: currentStartedAt, endedAt: null })
      if (node.kind === 'assistant_message') {
        currentNodeIds.forEach((nodeId) => {
          const current = timing.get(nodeId)
          if (current) timing.set(nodeId, { ...current, endedAt: node.createdAt })
        })
      }
    })
    return timing
  }, [visible])

  const latestUserStartedAt = useMemo(() => {
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const node = visible[index]
      if (!node) continue
      if (node.kind === 'user_message') return node.createdAt
    }
    return null
  }, [visible])

  if (visible.length === 0 && technical.length === 0 && !showThinking) {
    return <div className={['mt-3 min-h-0', props.className ?? ''].join(' ')} data-agent-timeline-empty="true" />
  }

  return (
    <div className={['mt-3 grid gap-1.5 overflow-y-auto pr-1', props.className ?? 'max-h-72'].join(' ')}>
      <div className="grid gap-1.5">
        {visible.map((node, index) => {
          const turnTiming = turnTimingByNodeId.get(node.id)
          const turnActive = props.busy && Boolean(turnTiming?.startedAt) && !turnTiming?.endedAt
          const showTurnDuration =
            node.kind !== 'user_message' &&
            visible[index - 1]?.kind === 'user_message' &&
            Boolean(turnTiming?.startedAt) &&
            Boolean(turnTiming?.endedAt || turnActive)
          return (
            <div key={node.id} className="contents">
              {showTurnDuration ? (
                <TurnDurationHeader
                  startedAt={turnTiming?.startedAt ?? null}
                  endedAt={turnTiming?.endedAt ?? null}
                  active={turnActive}
                  nowMs={nowMs}
                />
              ) : null}
              <TranscriptNodeView
                node={node}
                turnStartedAt={turnTiming?.startedAt ?? null}
                turnEndedAt={turnTiming?.endedAt ?? null}
                turnActive={turnActive}
                nowMs={nowMs}
                expanded={expansion}
                busy={props.busy}
                actionDiffsById={props.actionDiffsById}
                onConfirm={props.onConfirm}
                onCancel={props.onCancel}
                onUpdate={props.onUpdate}
              />
            </div>
          )
        })}
        {showThinking ? <ThinkingRow startedAt={latestUserStartedAt} nowMs={nowMs} label={thinkingLabel} /> : null}
      </div>

      {technical.length > 0 ? (
        <button
          type="button"
          onClick={() => setTechnicalOpen((current) => !current)}
          className="mt-1 inline-flex h-7 w-fit items-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-[10px] font-semibold text-stone-500 transition hover:bg-stone-100 hover:text-stone-700"
          aria-expanded={technicalOpen}
        >
          <TerminalSquare className="h-3.5 w-3.5" />
          技术日志 {summary.technicalCount}
          {technicalOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
      ) : null}

      {technicalOpen ? (
        <div className="grid max-h-40 gap-1 overflow-y-auto border-l border-stone-200 pl-2">
          {technical.map((node) => (
            <TranscriptNodeView
              key={node.id}
              node={node}
              turnStartedAt={turnTimingByNodeId.get(node.id)?.startedAt ?? null}
              turnEndedAt={turnTimingByNodeId.get(node.id)?.endedAt ?? null}
              turnActive={props.busy && Boolean(turnTimingByNodeId.get(node.id)?.startedAt) && !turnTimingByNodeId.get(node.id)?.endedAt}
              nowMs={nowMs}
              expanded={expansion}
              busy={props.busy}
              actionDiffsById={props.actionDiffsById}
              onConfirm={props.onConfirm}
              onCancel={props.onCancel}
              onUpdate={props.onUpdate}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
