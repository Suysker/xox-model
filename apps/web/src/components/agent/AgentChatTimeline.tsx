import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Clock3, Code2, FileCheck2, Layers3, MemoryStick, Navigation, TerminalSquare, UserRound, Wrench, XCircle } from 'lucide-react'
import { useState } from 'react'
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
  return nodes.filter((node) => node.visibility === 'user')
}

export function technicalTimelineItems(nodes: AgentTranscriptNode[]) {
  return nodes.filter((node) => node.visibility === 'technical')
}

export function summarizeAgentChatTimeline(nodes: AgentTranscriptNode[]): AgentChatTimelineSummary {
  const flattened = flattenNodes(nodes)
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
  return !visible.slice(latestUserIndex + 1).some((node) => (
    node.kind === 'assistant_stream' ||
    node.kind === 'assistant_message' ||
    node.kind === 'work_group' ||
    node.kind === 'tool_group' ||
    node.kind === 'tool_call' ||
    node.kind === 'tool_result' ||
    node.kind === 'navigation' ||
    node.kind === 'confirmation' ||
    node.kind === 'action_update' ||
    node.kind === 'summary' ||
    node.kind === 'evaluation' ||
    node.status === 'failed'
  ))
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

function canExpand(node: AgentTranscriptNode) {
  return Boolean(node.children?.length || node.sections?.length || node.details?.length || node.payload || node.navigation)
}

function compactRowSummary(node: AgentTranscriptNode) {
  const summary = node.summary ?? ''
  if ((node.kind === 'tool_call' || node.kind === 'tool_result') && /^[\s{[]/.test(summary)) {
    return '参数和结果可展开查看'
  }
  return summary
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

function ThinkingRow() {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-stone-500">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-stone-300 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-stone-500" />
      </span>
      <span>Thinking</span>
    </div>
  )
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
      {props.section.content ? (
        props.section.kind === 'raw' || props.section.kind === 'arguments'
          ? (
              <pre className="max-h-48 overflow-auto rounded-md bg-stone-950 px-2 py-1.5 text-[10px] leading-4 text-stone-100">
                {props.section.content}
              </pre>
            )
          : <p className="whitespace-pre-wrap break-words text-stone-600">{props.section.content}</p>
      ) : null}
    </div>
  )
}

function DisclosureSection(props: {
  node: AgentTranscriptNode
  section: AgentTranscriptSection
  expanded: boolean
  onToggle: () => void
  isSectionExpanded: (sectionId: string) => boolean
  onToggleSection: (sectionId: string) => void
  busy: boolean
  diffDetails: Array<{ label: string; value: string }>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  return (
    <div className="border-t border-stone-100 py-1 first:border-t-0" data-transcript-section-kind={props.section.kind} data-transcript-section-id={props.section.id}>
      <button
        type="button"
        onClick={props.onToggle}
        className="grid w-full grid-cols-[16px_minmax(0,1fr)] items-center gap-1.5 py-1 text-left text-stone-600 transition hover:text-stone-900"
        aria-expanded={props.expanded}
      >
        {props.expanded ? <ChevronDown className="h-3.5 w-3.5 text-stone-500" /> : <ChevronRight className="h-3.5 w-3.5 text-stone-500" />}
        <span className="min-w-0 truncate text-[11px] font-semibold text-stone-700">
          {props.section.title}
          {props.section.summary ? <span className="ml-2 font-normal text-stone-500">{props.section.summary}</span> : null}
        </span>
      </button>
      {props.expanded ? (
        <div className="ml-2 grid gap-1.5 border-l border-stone-200 py-1 pl-3">
          <SectionBody
            section={props.section}
            busy={props.busy}
            diffDetails={props.diffDetails}
            onConfirm={props.onConfirm}
            onCancel={props.onCancel}
            onUpdate={props.onUpdate}
          />
          {props.section.children?.map((child) => (
            <DisclosureSection
              key={child.id}
              node={props.node}
              section={child}
              expanded={props.isSectionExpanded(child.id)}
              onToggle={() => props.onToggleSection(child.id)}
              isSectionExpanded={props.isSectionExpanded}
              onToggleSection={props.onToggleSection}
              busy={props.busy}
              diffDetails={props.diffDetails}
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

function NodeRow(props: {
  node: AgentTranscriptNode
  expanded: boolean
  onToggle: () => void
}) {
  const expandable = canExpand(props.node)
  return (
    <div className="grid min-h-7 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center text-stone-500">
        <KindIcon kind={props.node.kind} />
      </span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs font-semibold text-stone-950">{props.node.title}</span>
        <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500">
          {kindLabels[props.node.kind]}
        </span>
        {props.node.tool?.name ? (
          <span className="max-w-[220px] shrink truncate rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700">
            {props.node.tool.name}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[11px] text-stone-500">{compactRowSummary(props.node)}</span>
      </div>
      <div className="flex items-center gap-1">
        {expandable ? (
          <button
            type="button"
            onClick={props.onToggle}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
            title={props.expanded ? '收起详情' : '展开详情'}
            aria-expanded={props.expanded}
          >
            {props.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : null}
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
      <NodeRow node={props.node} expanded={nodeOpen} onToggle={() => props.expanded.toggleNode(props.node)} />
      {nodeOpen ? (
        <div className={nodeDetailsClass(props.node.kind)}>
          {props.node.sections?.map((section) => (
            <DisclosureSection
              key={section.id}
              node={props.node}
              section={section}
              expanded={props.expanded.isSectionExpanded(props.node, section.id)}
              onToggle={() => props.expanded.toggleSection(props.node, section.id)}
              isSectionExpanded={(sectionId) => props.expanded.isSectionExpanded(props.node, sectionId)}
              onToggleSection={(sectionId) => props.expanded.toggleSection(props.node, sectionId)}
              busy={props.busy}
              diffDetails={diffDetails}
              onConfirm={props.onConfirm}
              onCancel={props.onCancel}
              onUpdate={props.onUpdate}
            />
          ))}
          {props.node.children?.map((child) => (
            <TranscriptNodeView
              key={child.id}
              node={child}
              depth={(props.depth ?? 0) + 1}
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
}) {
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const visible = userTimelineItems(props.nodes)
  const technical = technicalTimelineItems(props.nodes)
  const summary = summarizeAgentChatTimeline(props.nodes)
  const showThinking = shouldShowTimelineThinking(props.nodes, props.busy)
  const expansion = useAgentTranscriptExpansion(props.nodes)

  if (visible.length === 0 && technical.length === 0 && !showThinking) {
    return (
      <div className="mt-3 rounded-md border border-stone-900/10 bg-white px-3 py-3 text-xs text-stone-500">
        输入命令，例如：把 3 月成员 A 线下 10 张、线上 2 张入账。
      </div>
    )
  }

  return (
    <div className="mt-3 grid max-h-72 gap-1.5 overflow-y-auto pr-1">
      <div className="grid gap-1.5">
        {visible.map((node) => (
          <TranscriptNodeView
            key={node.id}
            node={node}
            expanded={expansion}
            busy={props.busy}
            actionDiffsById={props.actionDiffsById}
            onConfirm={props.onConfirm}
            onCancel={props.onCancel}
            onUpdate={props.onUpdate}
          />
        ))}
        {showThinking ? <ThinkingRow /> : null}
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
