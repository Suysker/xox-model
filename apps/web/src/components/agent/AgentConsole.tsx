import { useEffect, useState, type FormEvent } from 'react'
import { Bot, Database, History, KeyRound, PanelBottom, PanelRight, Plus, RefreshCw, Save, SendHorizontal, Trash2, XCircle } from 'lucide-react'
import type { AgentActionUpdatePayload, AgentAutomationLevel, AgentMemoryRecord, AgentProviderProbePayload, AgentProviderProbeResult, AgentProviderSettingRecord, AgentProviderSettingUpdatePayload, AgentSendResponse, AgentThreadSummary, AgentTranscriptNode } from '../../lib/api'
import type { AgentShellLayoutMode, AgentShellSurface } from './agentShellLayout'
import { AgentChatTimeline } from './AgentChatTimeline'

function flattenTranscriptNodes(nodes: AgentTranscriptNode[]): AgentTranscriptNode[] {
  return nodes.flatMap((node) => [node, ...flattenTranscriptNodes(node.children ?? [])])
}

function formatThreadTime(value: string | null) {
  if (!value) return '暂无'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function AgentConsole(props: {
  threadId: string | null
  planner: AgentSendResponse['planner'] | null
  transcriptNodes: AgentTranscriptNode[]
  memories: AgentMemoryRecord[]
  providerSetting: AgentProviderSettingRecord | null
  providerProbe: AgentProviderProbeResult | null
  threadSummaries: AgentThreadSummary[]
  runningRunId: string | null
  eventConnectionMode: 'idle' | 'connecting' | 'sse' | 'polling'
  automationLevel: AgentAutomationLevel
  layoutMode: AgentShellLayoutMode
  surface: AgentShellSurface
  busy: boolean
  error: string | null
  onLayoutModeChange: (mode: AgentShellLayoutMode) => void
  onSend: (message: string) => void
  onCancelRun: () => void
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
  onSelectThread: (id: string) => void
  onNewThread: () => void
  onRefreshThreads: () => void
  onRefreshMemories: (query?: string) => void
  onDeleteMemory: (id: string) => void
  onRefreshProviderSetting: () => void
  onAutomationLevelChange: (level: AgentAutomationLevel) => void
  onSaveProviderSetting: (payload: AgentProviderSettingUpdatePayload) => Promise<void> | void
  onProbeProviderSetting: (payload: AgentProviderProbePayload) => Promise<AgentProviderProbeResult> | void
  onDeleteProviderSetting: () => void
}) {
  const [draft, setDraft] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [memorySearch, setMemorySearch] = useState('')
  const [memoryTypeFilter, setMemoryTypeFilter] = useState('all')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerDraft, setProviderDraft] = useState({
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    apiKey: '',
  })
  const visibleMemories = props.memories.filter((memory) => {
    if (memoryTypeFilter !== 'all' && memory.memoryType !== memoryTypeFilter) return false
    const query = memorySearch.trim().toLowerCase()
    if (!query) return true
    return `${memory.value} ${memory.key} ${memory.kind} ${memory.memoryType ?? ''} ${memory.status ?? ''}`.toLowerCase().includes(query)
  })
  const actionDiffsById = new Map<string, Array<{ label: string; value: string }>>()
  flattenTranscriptNodes(props.transcriptNodes)
    .filter((item) => item.kind === 'action_update' && item.actionRequestId && item.details?.length)
    .forEach((item) => actionDiffsById.set(item.actionRequestId!, item.details ?? []))
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
    { level: 'manual', label: '手动', title: '全力规划；所有写入都停在确认卡' },
    { level: 'low', label: '低', title: '全力规划；自动执行低风险动作' },
    { level: 'medium', label: '中', title: '全力规划；自动执行低/中风险动作' },
    { level: 'high', label: '高', title: '全力规划；自动执行低/中风险，高风险仍按策略确认' },
  ]
  const isSideSurface = props.surface === 'side'
  const layoutOptions: Array<{ mode: AgentShellLayoutMode; title: string; icon: typeof PanelBottom }> = [
    { mode: 'bottomDrawer', title: '底部抽屉', icon: PanelBottom },
    { mode: 'sidePanel', title: '右侧栏', icon: PanelRight },
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

  async function handleProviderProbe() {
    const provider = providerDraft.provider.trim()
    const baseUrl = providerDraft.baseUrl.trim()
    const model = providerDraft.model.trim()
    const apiKey = providerDraft.apiKey.trim()
    if (!provider || !baseUrl || !model || props.busy) return
    await props.onProbeProviderSetting({
      provider,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    })
  }

  return (
    <section
      className={[
        'flex h-full min-h-0 flex-col overflow-hidden bg-stone-50/90 backdrop-blur-md',
        isSideSurface
          ? 'border-l border-stone-900/10 shadow-[inset_1px_0_0_rgba(255,255,255,0.72)]'
          : 'rounded-lg border border-stone-900/10 shadow-[0_18px_60px_rgba(41,37,36,0.24)]',
      ].join(' ')}
    >
      <div className={['flex h-full min-h-0 flex-col', isSideSurface ? 'p-2.5' : 'p-3'].join(' ')}>
        <div className="min-w-0 shrink-0">
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
            <div className="inline-flex h-8 overflow-hidden rounded-md border border-stone-900/10 bg-white" aria-label="Agent 布局">
              {layoutOptions.map((option) => {
                const Icon = option.icon
                return (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => props.onLayoutModeChange(option.mode)}
                    className={[
                      'inline-flex w-8 items-center justify-center transition',
                      props.layoutMode === option.mode
                        ? 'bg-stone-950 text-white'
                        : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800',
                    ].join(' ')}
                    title={option.title}
                    aria-label={option.title}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                )
              })}
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
              <div className={['mt-2 grid gap-1 overflow-y-auto', isSideSurface ? 'max-h-44' : 'max-h-28'].join(' ')}>
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
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => props.onRefreshMemories(memorySearch)}
                    disabled={props.busy}
                    className="inline-flex h-7 items-center justify-center rounded-md border border-stone-900/10 px-2 text-stone-600 transition hover:bg-stone-100 disabled:opacity-50"
                    title="按关键词刷新记忆"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-2 grid gap-1 sm:grid-cols-[minmax(0,1fr)_120px]">
                <input
                  value={memorySearch}
                  onChange={(event) => setMemorySearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') props.onRefreshMemories(memorySearch)
                  }}
                  className="h-7 rounded-md border border-stone-900/10 px-2 text-[11px] outline-none transition focus:border-emerald-500"
                  placeholder="搜索记忆"
                />
                <select
                  value={memoryTypeFilter}
                  onChange={(event) => setMemoryTypeFilter(event.target.value)}
                  className="h-7 rounded-md border border-stone-900/10 px-2 text-[11px] outline-none transition focus:border-emerald-500"
                  title="按记忆类型过滤"
                >
                  <option value="all">全部类型</option>
                  <option value="working">working</option>
                  <option value="episodic">episodic</option>
                  <option value="semantic">semantic</option>
                  <option value="procedural">procedural</option>
                  <option value="commitment">commitment</option>
                </select>
              </div>
              <div className={['mt-2 overflow-y-auto', isSideSurface ? 'max-h-40' : 'max-h-24'].join(' ')}>
                {visibleMemories.length > 0 ? (
                  visibleMemories.map((memory) => (
                    <div key={memory.id} className="flex items-start gap-2 border-t border-stone-100 py-1.5 first:border-t-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-stone-800">{memory.value}</p>
                        <p className="text-[10px] text-stone-400">
                          {memory.kind} / {memory.memoryType ?? 'semantic'} / {memory.status ?? 'active'} / {memory.confidence.toFixed(2)}
                        </p>
                        {memory.evidence ? (
                          <p className="truncate text-[10px] text-stone-400">
                            证据 {String(memory.evidence.runId ?? memory.evidence.actionRequestId ?? memory.evidence.snapshotId ?? '已记录')}
                          </p>
                        ) : null}
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
              <div className={['mt-2 grid gap-2', isSideSurface ? '' : 'md:grid-cols-[0.8fr_1.4fr_1fr]'].join(' ')}>
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
                <button
                  type="button"
                  onClick={() => void handleProviderProbe()}
                  disabled={props.busy || !providerDraft.provider.trim() || !providerDraft.baseUrl.trim() || !providerDraft.model.trim()}
                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-3 text-xs font-semibold text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
                  title="测试当前 provider 的认证、模型和 tool_calls"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  测试
                </button>
              </div>
              {props.providerProbe ? (
                <div className="mt-2 rounded-md border border-stone-900/10 bg-stone-50 px-2 py-1.5">
                  <p className={[
                    'text-[11px] font-semibold',
                    props.providerProbe.status === 'passed'
                      ? 'text-emerald-700'
                      : props.providerProbe.status === 'warning'
                        ? 'text-amber-700'
                        : 'text-red-700',
                  ].join(' ')}
                  >
                    Probe {props.providerProbe.status} / {props.providerProbe.provider}/{props.providerProbe.model}
                  </p>
                  <div className="mt-1 grid gap-0.5">
                    {props.providerProbe.checks.map((check) => (
                      <p key={check.name} className="truncate text-[10px] text-stone-500">
                        <span className="font-semibold text-stone-700">{check.name}</span>
                        {' '}
                        {check.status}
                        {' - '}
                        {check.message}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </form>
          ) : null}

        </div>

        <AgentChatTimeline
          nodes={props.transcriptNodes}
          busy={props.busy}
          actionDiffsById={actionDiffsById}
          onConfirm={props.onConfirm}
          onCancel={props.onCancel}
          onUpdate={props.onUpdate}
          className="min-h-0 flex-1"
        />

        <form
          onSubmit={handleSubmit}
          className={[
            'mt-2 flex shrink-0 gap-2 border-t border-stone-900/10 pt-2',
            isSideSurface
              ? 'bg-stone-50/95 pb-1'
              : 'sticky bottom-0 -mx-3 bg-stone-50/80 px-3 pb-3 backdrop-blur',
          ].join(' ')}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-10 min-w-0 flex-1 rounded-md border border-stone-900/10 bg-white px-3 text-sm outline-none transition focus:border-emerald-500"
            placeholder="输入指令"
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
    </section>
  )
}
