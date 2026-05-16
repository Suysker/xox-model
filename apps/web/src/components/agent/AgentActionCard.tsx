import { Check, Pencil, Save, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentActionRequest, AgentActionUpdatePayload } from '../../lib/api'

export function AgentActionCard(props: {
  action: AgentActionRequest
  busy: boolean
  onConfirm: (id: string) => void
  onCancel: (id: string) => void
  onUpdate: (id: string, payload: AgentActionUpdatePayload) => void
}) {
  const isPending = props.action.status === 'pending'
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState(props.action.summary)
  const [detailsJson, setDetailsJson] = useState(JSON.stringify(props.action.details, null, 2))
  const [payloadJson, setPayloadJson] = useState(JSON.stringify(props.action.payload, null, 2))
  const [editError, setEditError] = useState<string | null>(null)
  const summaryRef = useRef<HTMLTextAreaElement | null>(null)
  const detailsRef = useRef<HTMLTextAreaElement | null>(null)
  const payloadRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    setSummary(props.action.summary)
    setDetailsJson(JSON.stringify(props.action.details, null, 2))
    setPayloadJson(JSON.stringify(props.action.payload, null, 2))
  }, [props.action])

  function handleSave() {
    try {
      const nextSummary = summaryRef.current?.value ?? summary
      const nextDetailsJson = detailsRef.current?.value ?? detailsJson
      const nextPayloadJson = payloadRef.current?.value ?? payloadJson
      const details = JSON.parse(nextDetailsJson) as AgentActionRequest['details']
      const payload = JSON.parse(nextPayloadJson) as unknown
      if (!Array.isArray(details)) {
        setEditError('明细必须是数组。')
        return
      }
      props.onUpdate(props.action.id, { summary: nextSummary, details, payload })
      setEditing(false)
      setEditError(null)
    } catch {
      setEditError('JSON 格式不正确，请检查明细或载荷。')
    }
  }

  return (
    <div className="min-w-[320px] max-w-[430px] rounded-lg border border-stone-900/10 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-stone-500">{props.action.targetLabel}</p>
          <h3 className="mt-1 text-sm font-semibold text-stone-950">{props.action.title}</h3>
        </div>
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700">
          {props.action.status === 'pending' ? '待确认' : props.action.status}
        </span>
      </div>
      {editing ? (
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1 text-[11px] font-medium text-stone-500">
            摘要
            <textarea
              ref={summaryRef}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              className="min-h-14 rounded-md border border-stone-900/10 px-2 py-1 text-xs font-normal text-stone-800 outline-none focus:border-emerald-500"
            />
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-stone-500">
            明细 JSON
            <textarea
              ref={detailsRef}
              value={detailsJson}
              onChange={(event) => setDetailsJson(event.target.value)}
              className="min-h-20 rounded-md border border-stone-900/10 px-2 py-1 font-mono text-[11px] font-normal text-stone-800 outline-none focus:border-emerald-500"
            />
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-stone-500">
            执行载荷 JSON
            <textarea
              ref={payloadRef}
              value={payloadJson}
              onChange={(event) => setPayloadJson(event.target.value)}
              className="min-h-24 rounded-md border border-stone-900/10 px-2 py-1 font-mono text-[11px] font-normal text-stone-800 outline-none focus:border-emerald-500"
            />
          </label>
          {editError ? <p className="text-[11px] font-medium text-red-600">{editError}</p> : null}
        </div>
      ) : (
        <>
          <p className="mt-2 text-xs leading-5 text-stone-600">{props.action.summary}</p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {props.action.details.map((detail) => (
              <div key={`${props.action.id}-${detail.label}`} className="min-w-0">
                <dt className="text-stone-400">{detail.label}</dt>
                <dd className="truncate font-semibold text-stone-800">{detail.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {isPending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={props.busy}
            onClick={() => (editing ? handleSave() : setEditing(true))}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
          >
            {editing ? <Save className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            {editing ? '保存编辑' : '编辑'}
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => props.onConfirm(props.action.id)}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-stone-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-stone-800 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            确认执行
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => (editing ? setEditing(false) : props.onCancel(props.action.id))}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            {editing ? '退出编辑' : '取消'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
