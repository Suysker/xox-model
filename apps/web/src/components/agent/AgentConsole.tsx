import { useState, type FormEvent } from 'react'
import { Bot, SendHorizontal } from 'lucide-react'
import type { AgentActionRequest, AgentActionUpdatePayload, AgentMessage, AgentPlanStep } from '../../lib/api'
import { AgentActionCard } from './AgentActionCard'

export function AgentConsole(props: {
  messages: AgentMessage[]
  planSteps: AgentPlanStep[]
  actionRequests: AgentActionRequest[]
  busy: boolean
  error: string | null
  onSend: (message: string) => void
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  const [draft, setDraft] = useState('')
  const pendingActions = props.actionRequests.filter((action) => action.status === 'pending')
  const recentMessages = props.messages.slice(-6)

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
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-stone-950 text-white">
              <Bot className="h-4 w-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-stone-950">Agent OS</p>
              <p className="text-xs text-stone-500">{props.busy ? '执行中' : '对话驱动测算、记账和版本管理'}</p>
            </div>
          </div>

          <div className="mt-3 h-20 overflow-y-auto rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs leading-5 text-stone-700">
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

          {props.planSteps.length > 0 ? (
            <div className="mt-2 grid gap-1 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs">
              {props.planSteps.map((step) => (
                <div key={step.id} className="flex min-w-0 items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-600">
                    {step.sequence}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-stone-800">{step.title}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-semibold text-stone-500">
                    {step.status === 'ready' ? '待确认' : step.status === 'executed' ? '已执行' : step.status === 'cancelled' ? '已取消' : step.status}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

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
