import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, Navigation, XCircle } from 'lucide-react'
import type { AgentActionRequest, AgentNavigationEvent, AgentPlanStep, AgentPlanStepStatus, AgentRunEvent } from '../../lib/api'

type TimelineStatus = AgentPlanStepStatus | AgentActionRequest['status'] | AgentRunEvent['status']

const mainTabLabels: Record<AgentNavigationEvent['route']['mainTab'], string> = {
  dashboard: '看测算',
  inputs: '调模型',
  bookkeeping: '记实际',
  variance: '看偏差',
}

const secondaryTabLabels: Record<string, string> = {
  overview: '总览',
  months: '月份',
  members: '成员',
  capital: '资金',
  revenue: '收入',
  cost: '成本',
  entries: '账本',
  analysis: '偏差',
}

const panelLabels: Record<string, string> = {
  workspace: '版本管理',
}

const actionKindLabels: Record<AgentActionRequest['kind'], string> = {
  'ledger.create_entry': '记账',
  'ledger.update_entry': '改分录',
  'ledger.void_entry': '作废分录',
  'ledger.restore_entry': '恢复分录',
  'ledger.lock_period': '锁账',
  'ledger.unlock_period': '解锁',
  'workspace.rename': '改名',
  'workspace.update_draft': '改模型',
  'workspace.save_snapshot': '保存快照',
  'workspace.publish_release': '发布版本',
  'workspace.promote_version': '快照发布',
  'workspace.rollback_version': '恢复版本',
  'workspace.delete_version': '删除版本',
  'workspace.reset_draft': '重置草稿',
  'workspace.import_bundle': '导入工作区',
  'share.create': '创建分享',
  'share.revoke': '撤销分享',
}

const riskLabels: Record<AgentActionRequest['riskLevel'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

const stepStatusLabels: Record<AgentPlanStepStatus, string> = {
  pending: '规划中',
  ready: '待确认',
  executed: '已执行',
  cancelled: '已取消',
  failed: '失败',
  info: '只读',
}

const actionStatusLabels: Record<AgentActionRequest['status'], string> = {
  pending: '待确认',
  confirmed: '已确认',
  executed: '已执行',
  cancelled: '已取消',
  failed: '失败',
}

const runEventStatusLabels: Record<AgentRunEvent['status'], string> = {
  queued: '已入队',
  running: '运行中',
  info: '信息',
  blocked: '待确认',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

export type AgentTimelineRow = {
  id: string
  sequence: number
  title: string
  description: string
  status: AgentPlanStepStatus
  navigationLabel: string | null
  actionLabel: string | null
  actionStatus: AgentActionRequest['status'] | null
  riskLabel: string | null
  errorMessage: string | null
}

export type AgentTimelineSummary = {
  total: number
  ready: number
  executed: number
  cancelled: number
  failed: number
  pendingActions: number
}

export type AgentRunTraceRow = {
  id: string
  sequence: number
  title: string
  message: string
  status: AgentRunEvent['status']
  createdAt: string
}

export function formatAgentNavigationTarget(event: AgentNavigationEvent | null | undefined) {
  if (!event) return null
  const routeLabel = mainTabLabels[event.route.mainTab]
  const secondary = event.route.secondaryTab ? secondaryTabLabels[event.route.secondaryTab] ?? event.route.secondaryTab : null
  const panel = event.panel ? panelLabels[event.panel] ?? event.panel : null
  const focus = event.focusRecordId ? '定位记录' : null
  return [routeLabel, secondary, panel, focus].filter(Boolean).join(' / ')
}

export function buildAgentTimelineRows(planSteps: AgentPlanStep[], actionRequests: AgentActionRequest[]): AgentTimelineRow[] {
  const actionsById = new Map(actionRequests.map((action) => [action.id, action]))
  return planSteps
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((step) => {
      const action = step.actionRequestId ? actionsById.get(step.actionRequestId) ?? null : null
      const navigation = step.navigation ?? action?.navigation ?? null
      return {
        id: step.id,
        sequence: step.sequence,
        title: step.title,
        description: step.description,
        status: step.status,
        navigationLabel: formatAgentNavigationTarget(navigation),
        actionLabel: action ? actionKindLabels[action.kind] : null,
        actionStatus: action?.status ?? null,
        riskLabel: action ? riskLabels[action.riskLevel] : null,
        errorMessage: action?.errorMessage ?? null,
      }
    })
}

export function buildAgentRunTraceRows(runEvents: AgentRunEvent[]): AgentRunTraceRow[] {
  return runEvents
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((event) => ({
      id: event.id,
      sequence: event.sequence,
      title: event.title,
      message: event.message,
      status: event.status,
      createdAt: event.createdAt,
    }))
}

export function summarizeAgentTimeline(rows: AgentTimelineRow[], actionRequests: AgentActionRequest[]): AgentTimelineSummary {
  return {
    total: rows.length,
    ready: rows.filter((row) => row.status === 'ready').length,
    executed: rows.filter((row) => row.status === 'executed').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    failed: rows.filter((row) => row.status === 'failed' || row.actionStatus === 'failed').length,
    pendingActions: actionRequests.filter((action) => action.status === 'pending').length,
  }
}

export function formatAgentTimelineStatus(row: Pick<AgentTimelineRow, 'status' | 'actionStatus'>) {
  return row.actionStatus ? actionStatusLabels[row.actionStatus] : stepStatusLabels[row.status]
}

export function formatAgentRunEventStatus(event: Pick<AgentRunTraceRow, 'status'>) {
  return runEventStatusLabels[event.status]
}

function statusClass(status: TimelineStatus) {
  if (status === 'executed' || status === 'confirmed' || status === 'completed') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status === 'ready' || status === 'pending' || status === 'queued' || status === 'blocked') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (status === 'failed') return 'border-red-200 bg-red-50 text-red-700'
  if (status === 'cancelled') return 'border-stone-200 bg-stone-100 text-stone-500'
  return 'border-sky-200 bg-sky-50 text-sky-700'
}

function StatusIcon(props: { status: TimelineStatus }) {
  if (props.status === 'executed' || props.status === 'confirmed' || props.status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />
  if (props.status === 'failed') return <AlertTriangle className="h-3.5 w-3.5" />
  if (props.status === 'cancelled') return <XCircle className="h-3.5 w-3.5" />
  if (props.status === 'ready' || props.status === 'queued' || props.status === 'blocked' || props.status === 'running') return <Clock3 className="h-3.5 w-3.5" />
  return <CircleDashed className="h-3.5 w-3.5" />
}

export function AgentPlanTimeline(props: {
  planSteps: AgentPlanStep[]
  runEvents: AgentRunEvent[]
  actionRequests: AgentActionRequest[]
  navigationEvents: AgentNavigationEvent[]
}) {
  const runRows = buildAgentRunTraceRows(props.runEvents)
  const rows = buildAgentTimelineRows(props.planSteps, props.actionRequests)
  const summary = summarizeAgentTimeline(rows, props.actionRequests)
  const recentNavigation = props.navigationEvents.slice(-3)

  if (runRows.length === 0 && rows.length === 0 && recentNavigation.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs text-stone-500">
        暂无运行步骤
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-stone-900">运行图</span>
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-500">
            {summary.total} 步
          </span>
          {runRows.length > 0 ? (
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-500">
              {runRows.length} 事件
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1 text-[10px] font-semibold">
          {summary.pendingActions > 0 ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">{summary.pendingActions} 个待确认</span> : null}
          {summary.executed > 0 ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">{summary.executed} 已执行</span> : null}
          {summary.cancelled > 0 ? <span className="rounded-full bg-stone-100 px-2 py-0.5 text-stone-500">{summary.cancelled} 已取消</span> : null}
          {summary.failed > 0 ? <span className="rounded-full bg-red-50 px-2 py-0.5 text-red-700">{summary.failed} 失败</span> : null}
        </div>
      </div>

      {runRows.length > 0 ? (
        <div className="mt-2 grid max-h-28 gap-1 overflow-y-auto border-b border-stone-100 pb-2 pr-1">
          {runRows.map((row) => (
            <div key={row.id} className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1 py-1.5 hover:bg-stone-50">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-600">
                {row.sequence}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-semibold text-stone-900">{row.title}</span>
                </div>
                <p className="truncate text-[11px] text-stone-500">{row.message}</p>
              </div>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(row.status)}`}>
                <StatusIcon status={row.status} />
                {formatAgentRunEventStatus(row)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-2 grid max-h-36 gap-1 overflow-y-auto pr-1">
          {rows.map((row) => {
            const visibleStatus = row.actionStatus ?? row.status
            return (
              <div key={row.id} className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-1 py-1.5 hover:bg-stone-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-600">
                  {row.sequence}
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-xs font-semibold text-stone-900">{row.title}</span>
                    {row.actionLabel ? <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold text-stone-500">{row.actionLabel}</span> : null}
                    {row.riskLabel ? <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-600">{row.riskLabel}</span> : null}
                  </div>
                  <p className="truncate text-[11px] text-stone-500">{row.description}</p>
                  {row.navigationLabel ? (
                    <p className="mt-0.5 inline-flex max-w-full items-center gap-1 text-[10px] font-medium text-stone-500">
                      <Navigation className="h-3 w-3 shrink-0" />
                      <span className="truncate">{row.navigationLabel}</span>
                    </p>
                  ) : null}
                  {row.errorMessage ? <p className="mt-0.5 truncate text-[10px] font-medium text-red-600">{row.errorMessage}</p> : null}
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(visibleStatus)}`}>
                  <StatusIcon status={visibleStatus} />
                  {formatAgentTimelineStatus(row)}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      {recentNavigation.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 border-t border-stone-100 pt-2 text-[10px] font-medium text-stone-500">
          {recentNavigation.map((event, index) => (
            <span key={`${event.reason}-${index}`} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-stone-100 px-2 py-1">
              <Navigation className="h-3 w-3 shrink-0" />
              <span className="truncate">{formatAgentNavigationTarget(event) ?? event.reason}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
