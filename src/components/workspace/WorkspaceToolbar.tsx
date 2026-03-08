import { Download, FolderUp, History, Rocket, Save, Sparkles } from 'lucide-react'
import { formatDateTime } from '../../lib/format'

export function WorkspaceToolbar(props: {
  workspaceName: string
  snapshotCount: number
  lastSavedAt: string | null
  onNameChange: (value: string) => void
  onSaveSnapshot: () => void
  onPublishRelease: () => void
  onExport: () => void
  onImportClick: () => void
  onReset: () => void
}) {
  return (
    <div className="rounded-[28px] border border-stone-900/10 bg-white/88 p-4 shadow-[0_18px_50px_rgba(70,52,17,0.08)] backdrop-blur">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-col gap-3 xl:min-w-[380px]">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Workspace
          </div>
          <input
            className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-lg font-semibold text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white"
            value={props.workspaceName}
            onChange={(event) => props.onNameChange(event.target.value)}
            placeholder="工作区名称"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 xl:items-center">
          <div className="rounded-[20px] border border-stone-900/10 bg-stone-50/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-stone-500">最后存档</p>
            <p className="mt-2 text-sm font-semibold text-stone-900">{formatDateTime(props.lastSavedAt)}</p>
          </div>
          <div className="rounded-[20px] border border-stone-900/10 bg-stone-50/80 px-4 py-3">
            <p className="text-xs uppercase tracking-[0.18em] text-stone-500">快照数量</p>
            <p className="mt-2 text-sm font-semibold text-stone-900">{props.snapshotCount} 个版本</p>
          </div>
          <div className="flex flex-wrap gap-2 xl:justify-end">
            <ToolbarButton icon={Save} label="保存快照" onClick={props.onSaveSnapshot} />
            <ToolbarButton icon={Rocket} label="发布版本" onClick={props.onPublishRelease} />
            <ToolbarButton icon={Download} label="导出" onClick={props.onExport} />
            <ToolbarButton icon={FolderUp} label="导入" onClick={props.onImportClick} />
            <ToolbarButton icon={History} label="新建草稿" onClick={props.onReset} subtle />
          </div>
        </div>
      </div>
    </div>
  )
}

function ToolbarButton(props: {
  icon: typeof Save
  label: string
  onClick: () => void
  subtle?: boolean | undefined
}) {
  const Icon = props.icon

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        props.subtle
          ? 'inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-100'
          : 'inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800'
      }
    >
      <Icon className="h-4 w-4" />
      {props.label}
    </button>
  )
}
