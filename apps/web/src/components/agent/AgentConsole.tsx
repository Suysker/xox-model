import { useState, type FormEvent } from 'react'
import { Bot, Database, History, Plus, RefreshCw, SendHorizontal, Trash2, XCircle } from 'lucide-react'
import type { AgentActionRequest, AgentActionUpdatePayload, AgentMemoryRecord, AgentMessage, AgentNavigationEvent, AgentPlanStep, AgentRunEvent, AgentSendResponse, AgentThreadSummary } from '../../lib/api'
import { AgentActionCard } from './AgentActionCard'
import { AgentPlanTimeline } from './AgentPlanTimeline'

function formatThreadTime(value: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function AgentConsole(props: {
  threadId: string | null
  planner: AgentSendResponse['planner'] | null
  messages: AgentMessage[]
  planSteps: AgentPlanStep[]
  runEvents: AgentRunEvent[]
  actionRequests: AgentActionRequest[]
  navigationEvents: AgentNavigationEvent[]
  memories: AgentMemoryRecord[]
  threadSummaries: AgentThreadSummary[]
  runningRunId: string | null
  eventConnectionMode: 'idle' | 'connecting' | 'sse' | 'polling'
  busy: boolean
  error: string | null
  onSend: (message: string) => void
  onCancelRun: () => void
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
  onSelectThread: (id: string) => void
  onNewThread: () => void
  onRefreshThreads: () => void
  onRefreshMemories: () => void
  onDeleteMemory: (id: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const pendingActions = props.actionRequests.filter((action) => action.status === 'pending')
  const recentMessages = props.messages.slice(-6)
  const plannerLabel =
    props.planner === 'openai_agents'
      ? 'OpenAI Agents'
      : props.planner === 'openai_compatible_tool_calls'
      ? '兼容工具调用'
      : props.planner === 'rules'
        ? '本地规则'
        : '未运行'
  const connectionLabel =
    props.eventConnectionMode === 'sse'
      ? '实时'
      : props.eventConnectionMode === 'connecting'
      ? '连接中'
      : props.eventConnectionMode === 'polling'
        ? '轮询'
        : '待机'

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || props.busy) return
    setDraft('')
    props.onSend(message)
  }

  return (
    <section className="fixed inset-x-3 bottom-3 z-50 rounded-lg border border-stone-900/10 bg-stone-50/95 shadow-[0_18px_60px_rgba(41,37,36,0.24)] backdrop-blur md:inset-x-6">
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(360px,42%)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-stone-950 text-white">
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-stone-950">Agent OS</p>
                <p className="truncate text-xs text-stone-500">
                  {props.busy
                    ? `执行中 / ${connectionLabel}`
                    : `规划器：${plannerLabel} / ${connectionLabel}${props.threadId ? ` / 对话 ${props.threadId.slice(0, 8)}` : ''}`}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={props.onNewThread}
              disabled={props.busy}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
              title="新建对话"
            >
              <Plus className="h-3.5 w-3.5" />
              新对话
            </button>
            {props.runningRunId ? (
              <button
                type="button"
                onClick={props.onCancelRun}
                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                title="取消当前运行"
              >
                <XCircle className="h-3.5 w-3.5" />
                取消
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setHistoryOpen((current) => !current)}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
              title="历史对话"
            >
              <History className="h-3.5 w-3.5" />
              历史 {props.threadSummaries.length}
            </button>
            <button
              type="button"
              onClick={() => setMemoryOpen((current) => !current)}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
              title="记忆"
            >
              <Database className="h-3.5 w-3.5" />
              记忆 {props.memories.length}
            </button>
          </div>

          {historyOpen ? (
            <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-stone-800">历史对话</span>
                <button
                  type="button"
                  onClick={props.onRefreshThreads}
                  disabled={props.busy}
                  className="inline-flex h-7 items-center justify-center rounded-md border border-stone-900/10 px-2 text-stone-600 transition hover:bg-stone-100 disabled:opacity-50"
                  title="刷新历史"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 grid max-h-28 gap-1 overflow-y-auto">
                {props.threadSummaries.length > 0 ? (
                  props.threadSummaries.map((thread) => (
                    <button
                      key={thread.id}
                      type="button"
                      onClick={() => props.onSelectThread(thread.id)}
                      disabled={props.busy}
                      className={`grid min-w-0 gap-0.5 rounded-md border px-2 py-1.5 text-left transition disabled:opacity-50 ${
                        thread.id === props.threadId
                          ? 'border-emerald-200 bg-emerald-50'
                          : 'border-stone-100 bg-white hover:bg-stone-50'
                      }`}
                    >
                      <span className="truncate font-semibold text-stone-800">{thread.title}</span>
                      <span className="truncate text-[10px] text-stone-500">{thread.lastMessage ?? '暂无消息'}</span>
                      <span className="flex flex-wrap gap-1 text-[10px] text-stone-400">
                        <span>{formatThreadTime(thread.updatedAt)}</span>
                        {thread.latestRunStatus ? <span>{thread.latestRunStatus}</span> : null}
                        {thread.pendingActionCount > 0 ? <span className="font-semibold text-amber-700">{thread.pendingActionCount} 待确认</span> : null}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="py-2 text-stone-500">暂无历史对话。</p>
                )}
              </div>
            </div>
          ) : null}

          {memoryOpen ? (
            <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-stone-800">当前工作区记忆</span>
                <button
                  type="button"
                  onClick={props.onRefreshMemories}
                  disabled={props.busy}
                  className="inline-flex h-7 items-center justify-center rounded-md border border-stone-900/10 px-2 text-stone-600 transition hover:bg-stone-100 disabled:opacity-50"
                  title="刷新记忆"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2 max-h-24 overflow-y-auto">
                {props.memories.length > 0 ? (
                  props.memories.map((memory) => (
                    <div key={memory.id} className="flex items-start gap-2 border-t border-stone-100 py-1.5 first:border-t-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-stone-800">{memory.value}</p>
                        <p className="text-[10px] text-stone-400">{memory.kind} / {memory.confidence.toFixed(2)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => props.onDeleteMemory(memory.id)}
                        disabled={props.busy}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                        title="删除记忆"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="py-2 text-stone-500">暂无记忆。</p>
                )}
              </div>
            </div>
          ) : null}

          <div className="mt-3 h-24 overflow-y-auto rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs leading-5 text-stone-700">
            {recentMessages.length > 0 ? (
              recentMessages.map((message) => (
                <p key={message.id} className={message.role === 'user' ? 'text-stone-950' : 'text-stone-600'}>
                  <span className="font-semibold">{message.role === 'user' ? '你' : 'Agent'}：</span>
                  {message.content}
                </p>
              ))
            ) : (
              <p className="text-stone-500">输入命令，例如：把 3 月成员 A 线下 10 张、线上 2 张入账。</p>
            )}
          </div>

          <AgentPlanTimeline
            planSteps={props.planSteps}
            runEvents={props.runEvents}
            actionRequests={props.actionRequests}
            navigationEvents={props.navigationEvents}
          />

          <form onSubmit={handleSubmit} className="mt-2 flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="h-10 min-w-0 flex-1 rounded-md border border-stone-900/10 bg-white px-3 text-sm outline-none transition focus:border-emerald-500"
              placeholder="让 Agent 操作当前系统"
            />
            <button
              type="submit"
              disabled={props.busy || !draft.trim()}
              className="inline-flex h-10 items-center justify-center gap-1 rounded-md bg-stone-950 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:opacity-50"
            >
              <SendHorizontal className="h-4 w-4" />
              发送
            </button>
          </form>
          {props.error ? <p className="mt-2 text-xs font-medium text-red-600">{props.error}</p> : null}
        </div>

        <div className="flex min-h-[150px] min-w-0 gap-2 overflow-x-auto">
          {pendingActions.length > 0 ? (
            pendingActions.map((action) => (
              <AgentActionCard
                key={action.id}
                action={action}
                busy={props.busy}
                onConfirm={props.onConfirm}
                onCancel={props.onCancel}
                onUpdate={props.onUpdate}
              />
            ))
          ) : (
            <div className="flex min-h-full flex-1 items-center justify-center rounded-md border border-dashed border-stone-300 bg-white/70 px-4 text-center text-xs text-stone-500">
              写入动作会在这里显示确认卡。
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
