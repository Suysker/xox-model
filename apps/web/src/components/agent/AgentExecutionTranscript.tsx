import { AlertTriangle, Brain, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock3, Code2, FileCheck2, MemoryStick, Navigation, TerminalSquare, Wrench, XCircle } from 'lucide-react'
import { useState } from 'react'
import type { AgentTranscriptItem } from '../../lib/api'
import { formatAgentNavigationTarget } from './AgentPlanTimeline'

const statusLabels: Record<AgentTranscriptItem['status'], string> = {
  pending: '待开始',
  running: '进行中',
  waiting: '待确认',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  info: '信息',
}
const kindLabels: Record<AgentTranscriptItem['kind'], string> = {
  message: '回复',
  planning: '规划',
  tool_call: '工具调用',
  tool_result: '工具结果',
  navigation: '页面',
  confirmation: '确认',
  action_update: '编辑',
  evaluation: '检查',
  memory: '记忆',
  status: '状态',
  error: '错误',
  technical: '技术',
}

export type AgentExecutionTranscriptSummary = {
  visibleCount: number
  technicalCount: number
  runningCount: number
  waitingCount: number
  failedCount: number
}

export function userTranscriptItems(items: AgentTranscriptItem[]) {
  return items.filter((item) => item.visibility === 'user')
}

export function technicalTranscriptItems(items: AgentTranscriptItem[]) {
  return items.filter((item) => item.visibility === 'technical')
}

export function summarizeExecutionTranscript(items: AgentTranscriptItem[]): AgentExecutionTranscriptSummary {
  const visible = userTranscriptItems(items)
  return {
    visibleCount: visible.length,
    technicalCount: technicalTranscriptItems(items).length,
    runningCount: visible.filter((item) => item.status === 'running' || item.status === 'pending').length,
    waitingCount: visible.filter((item) => item.status === 'waiting').length,
    failedCount: visible.filter((item) => item.status === 'failed').length,
  }
}

export function formatTranscriptStatus(status: AgentTranscriptItem['status']) {
  return statusLabels[status]
}

function statusClass(status: AgentTranscriptItem['status']) {
  if (status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'waiting' || status === 'pending' || status === 'running') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700'
  if (status === 'cancelled') return 'border-stone-200 bg-stone-100 text-stone-500'
  return 'border-sky-200 bg-sky-50 text-sky-700'
}

function StatusIcon(props: { status: AgentTranscriptItem['status'] }) {
  if (props.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />
  if (props.status === 'failed') return <AlertTriangle className="h-3.5 w-3.5" />
  if (props.status === 'cancelled') return <XCircle className="h-3.5 w-3.5" />
  if (props.status === 'waiting' || props.status === 'pending' || props.status === 'running') return <Clock3 className="h-3.5 w-3.5" />
  return <CircleDashed className="h-3.5 w-3.5" />
}

function KindIcon(props: { kind: AgentTranscriptItem['kind'] }) {
  if (props.kind === 'tool_call' || props.kind === 'tool_result') return <Wrench className="h-3.5 w-3.5" />
  if (props.kind === 'navigation') return <Navigation className="h-3.5 w-3.5" />
  if (props.kind === 'confirmation' || props.kind === 'action_update') return <FileCheck2 className="h-3.5 w-3.5" />
  if (props.kind === 'evaluation') return <CheckCircle2 className="h-3.5 w-3.5" />
  if (props.kind === 'memory') return <MemoryStick className="h-3.5 w-3.5" />
  if (props.kind === 'technical') return <TerminalSquare className="h-3.5 w-3.5" />
  if (props.kind === 'message') return <Brain className="h-3.5 w-3.5" />
  return <Code2 className="h-3.5 w-3.5" />
}

function TranscriptRow(props: { item: AgentTranscriptItem; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const navigationLabel = formatAgentNavigationTarget(props.item.navigation)
  const hasDetails = Boolean(props.item.details?.length || props.item.payload || navigationLabel)
  return (
    <div className="rounded-md border border-stone-100 bg-white px-2 py-2">
      <div className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-stone-600">
          <KindIcon kind={props.item.kind} />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-semibold text-stone-900">{props.item.title}</span>
            <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500">
              {kindLabels[props.item.kind]}
            </span>
            {props.item.toolName ? (
              <span className="max-w-[180px] truncate rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                {props.item.toolName}
              </span>
            ) : null}
          </div>
          <p className={props.compact ? 'mt-0.5 truncate text-[11px] text-stone-500' : 'mt-0.5 line-clamp-2 text-[11px] leading-4 text-stone-500'}>
            {props.item.summary}
          </p>
          {navigationLabel ? (
            <p className="mt-1 inline-flex max-w-full items-center gap-1 text-[10px] font-medium text-stone-500">
              <Navigation className="h-3 w-3 shrink-0" />
              <span className="truncate">{navigationLabel}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {hasDetails ? (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition hover:bg-stone-100 hover:text-stone-700"
              title={expanded ? '收起详情' : '展开详情'}
            >
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : null}
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(props.item.status)}`}>
            <StatusIcon status={props.item.status} />
            {formatTranscriptStatus(props.item.status)}
          </span>
        </div>
      </div>
      {expanded ? (
        <div className="mt-2 grid gap-2 border-t border-stone-100 pt-2 text-[11px]">
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
            <pre className="max-h-32 overflow-auto rounded-md bg-stone-950 px-2 py-1.5 text-[10px] leading-4 text-stone-100">
              {JSON.stringify(props.item.payload, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function AgentExecutionTranscript(props: { items: AgentTranscriptItem[] }) {
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const visible = userTranscriptItems(props.items)
  const technical = technicalTranscriptItems(props.items)
  const summary = summarizeExecutionTranscript(props.items)

  if (visible.length === 0 && technical.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs text-stone-500">
        暂无执行过程
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-md border border-stone-900/10 bg-stone-50 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-stone-900">执行过程</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-stone-500">
            {summary.visibleCount} 步
          </span>
          {summary.waitingCount > 0 ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{summary.waitingCount} 待确认</span> : null}
          {summary.runningCount > 0 ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">{summary.runningCount} 进行中</span> : null}
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

      <div className="mt-2 grid max-h-56 gap-1.5 overflow-y-auto pr-1">
        {visible.map((item) => <TranscriptRow key={item.id} item={item} />)}
      </div>

      {technicalOpen ? (
        <div className="mt-2 grid max-h-28 gap-1 overflow-y-auto border-t border-stone-200 pt-2 pr-1">
          {technical.map((item) => <TranscriptRow key={item.id} item={item} compact />)}
        </div>
      ) : null}
    </div>
  )
}
