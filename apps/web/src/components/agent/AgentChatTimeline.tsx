import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Clock3, Code2, FileCheck2, MemoryStick, Navigation, TerminalSquare, UserRound, Wrench, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { AgentActionUpdatePayload, AgentTimelineItem } from '../../lib/api'
import { formatAgentNavigationTarget } from './agentNavigation'
import { AgentActionCard } from './AgentActionCard'

const statusLabels: Record<AgentTimelineItem['status'], string> = {
  pending: '待开始',
  running: '进行中',
  waiting: '待确认',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  info: '信息',
}

const kindLabels: Record<AgentTimelineItem['kind'], string> = {
  user_message: '用户',
  assistant_message: '回复',
  assistant_stream: '实时回复',
  tool_call: '工具调用',
  tool_result: '工具结果',
  navigation: '页面',
  confirmation: '确认',
  action_edit: '编辑',
  memory: '记忆',
  evaluation: '检查',
  summary: '总结',
  technical: '技术',
}

export type AgentChatTimelineSummary = {
  visibleCount: number
  technicalCount: number
  toolCount: number
  waitingCount: number
  failedCount: number
}

export function userTimelineItems(items: AgentTimelineItem[]) {
  return items.filter((item) => item.visibility === 'user')
}

export function technicalTimelineItems(items: AgentTimelineItem[]) {
  return items.filter((item) => item.visibility === 'technical')
}

export function summarizeAgentChatTimeline(items: AgentTimelineItem[]): AgentChatTimelineSummary {
  const visible = userTimelineItems(items)
  return {
    visibleCount: visible.length,
    technicalCount: technicalTimelineItems(items).length,
    toolCount: visible.filter((item) => item.kind === 'tool_call' || item.kind === 'tool_result').length,
    waitingCount: visible.filter((item) => item.status === 'waiting').length,
    failedCount: visible.filter((item) => item.status === 'failed').length,
  }
}

export function formatTimelineStatus(status: AgentTimelineItem['status']) {
  return statusLabels[status]
}

export function shouldShowTimelineThinking(items: AgentTimelineItem[], busy: boolean) {
  if (!busy) return false
  const visible = userTimelineItems(items)
  if (visible.length === 0) return true
  const latestUserIndex = visible.map((item) => item.kind).lastIndexOf('user_message')
  if (latestUserIndex === -1) return false
  return !visible.slice(latestUserIndex + 1).some((item) => (
    item.kind === 'assistant_stream' ||
    item.kind === 'assistant_message' ||
    item.kind === 'tool_call' ||
    item.kind === 'tool_result' ||
    item.kind === 'navigation' ||
    item.kind === 'confirmation' ||
    item.kind === 'action_edit' ||
    item.kind === 'summary' ||
    item.kind === 'evaluation' ||
    item.status === 'failed'
  ))
}

function statusClass(status: AgentTimelineItem['status']) {
  if (status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'waiting' || status === 'pending' || status === 'running') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700'
  if (status === 'cancelled') return 'border-stone-200 bg-stone-100 text-stone-500'
  return 'border-sky-200 bg-sky-50 text-sky-700'
}

function StatusIcon(props: { status: AgentTimelineItem['status'] }) {
  if (props.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />
  if (props.status === 'failed') return <AlertTriangle className="h-3.5 w-3.5" />
  if (props.status === 'cancelled') return <XCircle className="h-3.5 w-3.5" />
  if (props.status === 'waiting' || props.status === 'pending' || props.status === 'running') return <Clock3 className="h-3.5 w-3.5" />
  return <Code2 className="h-3.5 w-3.5" />
}

function KindIcon(props: { kind: AgentTimelineItem['kind'] }) {
  if (props.kind === 'user_message') return <UserRound className="h-3.5 w-3.5" />
  if (props.kind === 'assistant_message' || props.kind === 'assistant_stream' || props.kind === 'summary') return <Bot className="h-3.5 w-3.5" />
  if (props.kind === 'tool_call' || props.kind === 'tool_result') return <Wrench className="h-3.5 w-3.5" />
  if (props.kind === 'navigation') return <Navigation className="h-3.5 w-3.5" />
  if (props.kind === 'confirmation' || props.kind === 'action_edit') return <FileCheck2 className="h-3.5 w-3.5" />
  if (props.kind === 'memory') return <MemoryStick className="h-3.5 w-3.5" />
  return <TerminalSquare className="h-3.5 w-3.5" />
}

function isMessage(item: AgentTimelineItem) {
  return item.kind === 'user_message' || item.kind === 'assistant_message' || item.kind === 'assistant_stream' || item.kind === 'summary'
}

function hasExpandableDetails(item: AgentTimelineItem) {
  return Boolean(item.details?.length || item.payload || item.navigation || item.toolName)
}

function TimelineStatusBadge(props: { status: AgentTimelineItem['status'] }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(props.status)}`}>
      <StatusIcon status={props.status} />
      {formatTimelineStatus(props.status)}
    </span>
  )
}

function TimelineMessage(props: { item: AgentTimelineItem }) {
  const isUser = props.item.kind === 'user_message'
  const isStream = props.item.kind === 'assistant_stream'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <p
        className={[
          'max-w-[92%] whitespace-pre-wrap break-words text-sm leading-6',
          isUser ? 'text-right font-medium text-stone-950' : 'text-stone-800',
          isStream ? 'border-l-2 border-stone-300 pl-2 text-stone-600' : '',
        ].join(' ')}
      >
        {props.item.content ?? props.item.summary}
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

function TimelineDetails(props: { item: AgentTimelineItem }) {
  const navigationLabel = formatAgentNavigationTarget(props.item.navigation)
  return (
    <div className="mt-2 grid gap-2 border-t border-stone-100 pt-2 text-[11px]">
      {navigationLabel ? (
        <p className="inline-flex max-w-full items-center gap-1 text-stone-500">
          <Navigation className="h-3 w-3 shrink-0" />
          <span className="truncate">{navigationLabel}</span>
        </p>
      ) : null}
      {props.item.details?.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          {props.item.details.map((detail) => (
            <div key={`${props.item.id}-${detail.label}`} className="min-w-0">
              <dt className="text-stone-400">{detail.label}</dt>
              <dd className="break-words font-medium text-stone-700">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {props.item.payload ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-stone-950 px-2 py-1.5 text-[10px] leading-4 text-stone-100">
          {JSON.stringify(props.item.payload, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function TimelineEventRow(props: {
  item: AgentTimelineItem
  expanded: boolean
  onToggle: () => void
  busy: boolean
  diffDetails: Array<{ label: string; value: string }>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  const inlineAction = props.item.actionRequest?.status === 'pending' ? props.item.actionRequest : null
  const expandable = hasExpandableDetails(props.item)
  const showDetails = props.expanded && expandable
  return (
    <div className="rounded-md border border-stone-900/10 bg-white px-2 py-1 shadow-sm">
      <div className="grid min-h-7 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-stone-100 text-stone-600">
          <KindIcon kind={props.item.kind} />
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-xs font-semibold text-stone-950">{props.item.title}</span>
          <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500">
            {kindLabels[props.item.kind]}
          </span>
          {props.item.toolName ? (
            <span className="max-w-[220px] shrink truncate rounded-full bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700">
              {props.item.toolName}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-[11px] text-stone-500">{props.item.summary}</span>
        </div>
        <div className="flex items-center gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={props.onToggle}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
              title={props.expanded ? '收起详情' : '展开详情'}
            >
              {props.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <TimelineStatusBadge status={props.item.status} />
        </div>
      </div>
      {showDetails ? <TimelineDetails item={props.item} /> : null}
      {inlineAction ? (
        <div className="mt-2 border-t border-stone-100 pt-2">
          <AgentActionCard
            action={inlineAction}
            diffDetails={props.diffDetails}
            busy={props.busy}
            layout="inline"
            onConfirm={props.onConfirm}
            onCancel={props.onCancel}
            onUpdate={props.onUpdate}
          />
        </div>
      ) : null}
    </div>
  )
}

export function AgentChatTimeline(props: {
  items: AgentTimelineItem[]
  busy: boolean
  actionDiffsById: Map<string, Array<{ label: string; value: string }>>
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  const [expandedIds, setExpandedIds] = useState(() => new Set<string>())
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const visible = userTimelineItems(props.items)
  const technical = technicalTimelineItems(props.items)
  const summary = summarizeAgentChatTimeline(props.items)
  const showThinking = shouldShowTimelineThinking(props.items, props.busy)

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (visible.length === 0 && technical.length === 0 && !showThinking) {
    return (
      <div className="mt-3 rounded-md border border-stone-900/10 bg-white px-3 py-3 text-xs text-stone-500">
        输入命令，例如：把 3 月成员 A 线下 10 张、线上 2 张入账。
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-md border border-stone-900/10 bg-stone-50 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-stone-900">对话时间线</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-stone-500">{summary.visibleCount} 项</span>
          {summary.toolCount > 0 ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">{summary.toolCount} 工具</span> : null}
          {summary.waitingCount > 0 ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{summary.waitingCount} 待确认</span> : null}
          {summary.failedCount > 0 ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700">{summary.failedCount} 失败</span> : null}
        </div>
        {technical.length > 0 ? (
          <button
            type="button"
            onClick={() => setTechnicalOpen((current) => !current)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-[10px] font-semibold text-stone-600 transition hover:bg-stone-100"
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            技术日志 {technical.length}
          </button>
        ) : null}
      </div>

      <div className="mt-2 grid max-h-72 gap-1.5 overflow-y-auto pr-1">
        {visible.map((item) => (
          isMessage(item)
            ? <TimelineMessage key={item.id} item={item} />
            : (
              <TimelineEventRow
                key={item.id}
                item={item}
                expanded={expandedIds.has(item.id)}
                onToggle={() => toggleExpanded(item.id)}
                busy={props.busy}
                diffDetails={item.actionRequestId ? props.actionDiffsById.get(item.actionRequestId) ?? [] : []}
                onConfirm={props.onConfirm}
                onCancel={props.onCancel}
                onUpdate={props.onUpdate}
              />
            )
        ))}
        {showThinking ? <ThinkingRow /> : null}
      </div>

      {technicalOpen ? (
        <div className="mt-2 grid max-h-32 gap-1 overflow-y-auto border-t border-stone-200 pt-2 pr-1">
          {technical.map((item) => (
            <TimelineEventRow
              key={item.id}
              item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpanded(item.id)}
              busy={props.busy}
              diffDetails={[]}
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
