import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Bot, CheckCircle2, Database, History, KeyRound, Plus, RefreshCw, Save, SendHorizontal, Target, Trash2, XCircle } from 'lucide-react'
import type { AgentActionRequest, AgentActionUpdatePayload, AgentAutomationLevel, AgentEvaluationResult, AgentGoalRecord, AgentMemoryRecord, AgentMessage, AgentNavigationEvent, AgentPlanStep, AgentProviderSettingRecord, AgentProviderSettingUpdatePayload, AgentRunEvent, AgentSendResponse, AgentThreadSummary } from '../../lib/api'
import { AgentActionCard } from './AgentActionCard'
import { AgentPlanTimeline } from './AgentPlanTimeline'

export type ProviderStreamPreview = {
  content: string
  tools: Array<{ index: number; name: string; argumentsPreview: string }>
  completed: boolean
}

function formatThreadTime(value: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function dataString(data: Record<string, unknown> | null, key: string) {
  const value = data?.[key]
  return typeof value === 'string' ? value : ''
}

function dataNumber(data: Record<string, unknown> | null, key: string) {
  const value = data?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildProviderStreamPreview(runEvents: AgentRunEvent[]): ProviderStreamPreview | null {
  let content = ''
  let sawStream = false
  let completed = false
  const tools = new Map<number, { index: number; name: string; argumentsPreview: string }>()

  for (const event of [...runEvents].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === 'provider_stream_started') {
      sawStream = true
      completed = false
      continue
    }
    if (event.type === 'provider_stream_completed') {
      sawStream = true
      completed = true
      continue
    }
    if (event.type !== 'provider_stream_delta') continue

    const kind = dataString(event.data, 'kind')
    if (kind === 'content_delta') {
      sawStream = true
      const preview = dataString(event.data, 'preview')
      const delta = dataString(event.data, 'delta')
      content = preview || `${content}${delta}`
      continue
    }
    if (kind === 'tool_call_delta') {
      sawStream = true
      const index = dataNumber(event.data, 'toolCallIndex') ?? tools.size
      const current = tools.get(index)
      const name = dataString(event.data, 'toolName') || current?.name || `工具 ${index + 1}`
      const argumentsPreview = dataString(event.data, 'argumentsPreview') || `${current?.argumentsPreview ?? ''}${dataString(event.data, 'argumentsDelta')}`
      tools.set(index, { index, name, argumentsPreview })
    }
  }

  if (!sawStream) return null
  return {
    content,
    tools: [...tools.values()].sort((left, right) => left.index - right.index),
    completed,
  }
}

export function AgentConsole(props: {
  threadId: string | null
  planner: AgentSendResponse['planner'] | null
  messages: AgentMessage[]
  planSteps: AgentPlanStep[]
  runEvents: AgentRunEvent[]
  goals: AgentGoalRecord[]
  evaluations: AgentEvaluationResult[]
  actionRequests: AgentActionRequest[]
  navigationEvents: AgentNavigationEvent[]
  memories: AgentMemoryRecord[]
  providerSetting: AgentProviderSettingRecord | null
  threadSummaries: AgentThreadSummary[]
  runningRunId: string | null
  eventConnectionMode: 'idle' | 'connecting' | 'sse' | 'polling'
  automationLevel: AgentAutomationLevel
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
  onRefreshProviderSetting: () => void
  onAutomationLevelChange: (level: AgentAutomationLevel) => void
  onSaveProviderSetting: (payload: AgentProviderSettingUpdatePayload) => Promise<void> | void
  onDeleteProviderSetting: () => void
}) {
  const [draft, setDraft] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerDraft, setProviderDraft] = useState({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    apiKey: '',
  })
  const pendingActions = props.actionRequests.filter((action) => action.status === 'pending')
  const recentMessages = props.messages.slice(-6)
  const streamPreview = buildProviderStreamPreview(props.runEvents)
  const latestGoal = props.goals.at(-1) ?? null
  const latestEvaluation = props.evaluations.at(-1) ?? null
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
  const automationOptions: Array<{ level: AgentAutomationLevel; label: string; title: string }> = [
    { level: 'manual', label: '手动', title: '所有写入都停在确认卡' },
    { level: 'low', label: '低', title: '自动执行低风险动作' },
    { level: 'medium', label: '中', title: '自动执行低/中风险动作' },
    { level: 'high', label: '高', title: '自动执行低/中/高风险动作' },
  ]

  useEffect(() => {
    if (!providerOpen) return
    setProviderDraft({
      provider: props.providerSetting?.provider ?? 'deepseek',
      baseUrl: props.providerSetting?.baseUrl ?? 'https://api.deepseek.com',
      model: props.providerSetting?.model ?? 'deepseek-v4-pro',
      apiKey: '',
    })
  }, [providerOpen, props.providerSetting])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || props.busy) return
    setDraft('')
    props.onSend(message)
  }

  async function handleProviderSubmit(event: FormEvent) {
    event.preventDefault()
    const provider = providerDraft.provider.trim()
    const baseUrl = providerDraft.baseUrl.trim()
    const model = providerDraft.model.trim()
    const apiKey = providerDraft.apiKey.trim()
    if (!provider || !baseUrl || !model || props.busy) return
    try {
      await props.onSaveProviderSetting({
        provider,
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {}),
      })
      setProviderDraft((current) => ({ ...current, apiKey: '' }))
    } catch {
      // The hook owns the visible error message; keep the typed key for correction.
    }
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
            <div className="inline-flex h-8 overflow-hidden rounded-md border border-stone-900/10 bg-white" aria-label="自动化执行级别">
              {automationOptions.map((option) => (
                <button
                  key={option.level}
                  type="button"
                  onClick={() => props.onAutomationLevelChange(option.level)}
                  disabled={props.busy}
                  className={[
                    'min-w-9 px-2 text-xs font-semibold transition disabled:opacity-50',
                    props.automationLevel === option.level
                      ? 'bg-stone-950 text-white'
                      : 'text-stone-600 hover:bg-stone-100',
                  ].join(' ')}
                  title={option.title}
                >
                  {option.label}
                </button>
              ))}
            </div>
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
            <button
              type="button"
              onClick={() => setProviderOpen((current) => !current)}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
              title="模型配置"
            >
              <KeyRound className="h-3.5 w-3.5" />
              模型 {props.providerSetting?.provider ?? '默认'}
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

          {providerOpen ? (
            <form onSubmit={handleProviderSubmit} className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-stone-800">模型配置</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={props.onRefreshProviderSetting}
                    disabled={props.busy}
                    className="inline-flex h-7 items-center justify-center rounded-md border border-stone-900/10 px-2 text-stone-600 transition hover:bg-stone-100 disabled:opacity-50"
                    title="刷新模型配置"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={props.onDeleteProviderSetting}
                    disabled={props.busy || !props.providerSetting}
                    className="inline-flex h-7 items-center justify-center rounded-md border border-red-100 px-2 text-red-600 transition hover:bg-red-50 disabled:opacity-40"
                    title="删除模型配置"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2 grid gap-2 md:grid-cols-[0.8fr_1.4fr_1fr]">
                <label className="grid gap-1">
                  <span className="text-[10px] font-semibold text-stone-500">provider</span>
                  <input
                    value={providerDraft.provider}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, provider: event.target.value }))}
                    className="h-8 rounded-md border border-stone-900/10 px-2 text-xs outline-none transition focus:border-emerald-500"
                    placeholder="deepseek"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-semibold text-stone-500">base URL</span>
                  <input
                    value={providerDraft.baseUrl}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                    className="h-8 rounded-md border border-stone-900/10 px-2 text-xs outline-none transition focus:border-emerald-500"
                    placeholder="https://api.deepseek.com"
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-[10px] font-semibold text-stone-500">model</span>
                  <input
                    value={providerDraft.model}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, model: event.target.value }))}
                    className="h-8 rounded-md border border-stone-900/10 px-2 text-xs outline-none transition focus:border-emerald-500"
                    placeholder="deepseek-v4-pro"
                  />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="grid min-w-[220px] flex-1 gap-1">
                  <span className="text-[10px] font-semibold text-stone-500">
                    API key {props.providerSetting?.hasApiKey ? '已保存' : '未保存'}
                  </span>
                  <input
                    type="password"
                    value={providerDraft.apiKey}
                    onChange={(event) => setProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
                    className="h-8 rounded-md border border-stone-900/10 px-2 text-xs outline-none transition focus:border-emerald-500"
                    placeholder={props.providerSetting?.hasApiKey ? '留空保留当前 key' : '首次保存需要 key'}
                  />
                </label>
                <button
                  type="submit"
                  disabled={props.busy || !providerDraft.provider.trim() || !providerDraft.baseUrl.trim() || !providerDraft.model.trim()}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-stone-950 px-3 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  保存
                </button>
              </div>
            </form>
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

          {streamPreview ? (
            <div className="mt-2 rounded-md border border-emerald-900/10 bg-emerald-50/80 px-3 py-2 text-xs text-stone-700">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-stone-800">模型实时输出</span>
                <span className={streamPreview.completed ? 'text-stone-500' : 'font-semibold text-emerald-700'}>
                  {streamPreview.completed ? '已完成' : '接收中'}
                </span>
              </div>
              {streamPreview.content ? (
                <p className="mt-1 max-h-14 overflow-y-auto whitespace-pre-wrap text-stone-700">{streamPreview.content}</p>
              ) : null}
              {streamPreview.tools.length > 0 ? (
                <div className="mt-1 grid max-h-20 gap-1 overflow-y-auto">
                  {streamPreview.tools.map((tool) => (
                    <div key={tool.index} className="grid gap-0.5 rounded-md bg-white/80 px-2 py-1">
                      <span className="truncate font-semibold text-stone-800">{tool.name}</span>
                      {tool.argumentsPreview ? (
                        <code className="whitespace-pre-wrap break-words text-[10px] leading-4 text-stone-600">{tool.argumentsPreview}</code>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {latestGoal || latestEvaluation ? (
            <div className="mt-2 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs text-stone-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-1 font-semibold text-stone-900">
                  <Target className="h-3.5 w-3.5 text-emerald-700" />
                  <span className="truncate">{latestGoal?.contract.objective ?? '当前目标'}</span>
                </span>
                <span className="rounded-md bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-600">
                  {latestGoal?.status ?? latestEvaluation?.status}
                </span>
              </div>
              {latestEvaluation ? (
                <div className="mt-1 grid gap-1">
                  <p className="flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-700" />
                      {latestEvaluation.satisfiedCriteria.length} 已满足
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3 text-amber-700" />
                      {latestEvaluation.unsatisfiedCriteria.length} 待完善
                    </span>
                    <span>第 {latestEvaluation.iteration} 轮</span>
                    <span>置信度 {Math.round(latestEvaluation.confidence * 100)}%</span>
                  </p>
                  {latestEvaluation.blocker ? (
                    <p className="rounded-md bg-red-50 px-2 py-1 text-red-700">{latestEvaluation.blocker}</p>
                  ) : latestEvaluation.nextPlannerBrief ? (
                    <p className="rounded-md bg-amber-50 px-2 py-1 text-amber-800">{latestEvaluation.nextPlannerBrief}</p>
                  ) : null}
                  {latestEvaluation.unsatisfiedCriteria.length > 0 ? (
                    <div className="grid max-h-16 gap-1 overflow-y-auto">
                      {latestEvaluation.unsatisfiedCriteria.slice(0, 3).map((finding) => (
                        <p key={finding.id} className="truncate text-[11px] text-stone-500">
                          {finding.message}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

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
