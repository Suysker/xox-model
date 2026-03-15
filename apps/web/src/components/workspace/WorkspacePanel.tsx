import { Copy, Download, FolderUp, Rocket, RotateCcw, Save, Trash2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { VersionShareResponse } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import type { WorkspaceSnapshot } from '../../types'

export function WorkspacePanel(props: {
  workspaceName: string
  lastSavedAt: string | null
  snapshots: WorkspaceSnapshot[]
  shareLinks: Record<string, VersionShareResponse | null>
  onNameChange: (value: string) => void
  onSaveSnapshot: () => void
  onPublishRelease: () => void
  onExport: () => void
  onImportClick: () => void
  onReset: () => void
  onLoadSnapshot: (id: string) => void
  onDeleteSnapshot: (id: string) => void
  onPromoteToRelease: (id: string) => void
  onCreateShare: (id: string) => void
  onCopyShareLink: (id: string) => void
  onRevokeShare: (id: string) => void
  onClose: () => void
}) {
  const releaseSnapshots = props.snapshots.filter((snapshot) => snapshot.kind === 'release')
  const normalSnapshots = props.snapshots.filter((snapshot) => snapshot.kind === 'snapshot')

  return (
    <section className="flex h-full min-w-0 flex-col overflow-hidden rounded-[30px] border border-stone-900/10 bg-white/96 shadow-[0_30px_90px_rgba(41,37,36,0.22)] backdrop-blur">
      <div className="flex items-start justify-between gap-4 border-b border-stone-900/10 px-4 py-4 sm:px-5 sm:py-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-[0.18em] text-stone-500">工作区</p>
          <h2 className="mt-2 text-2xl font-bold text-stone-950">版本管理</h2>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="关闭版本管理"
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-900/10 bg-stone-50 text-stone-700 transition hover:bg-stone-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-5 sm:py-5">
        <div className="grid min-w-0 gap-4">
          <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/90 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold tracking-[0.16em] text-stone-500">工作区名称</p>
                <input
                  className="mt-3 h-11 w-full rounded-2xl border border-stone-900/10 bg-white px-4 text-base font-semibold text-stone-950 outline-none transition focus:border-emerald-500"
                  value={props.workspaceName}
                  onChange={(event) => props.onNameChange(event.target.value)}
                  placeholder="我的测算工作区"
                />
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <MetaChip label="最近保存" value={formatDateTime(props.lastSavedAt)} />
                <MetaChip label="版本数" value={`${props.snapshots.length}`} />
              </div>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <ActionButton icon={Save} label="存草稿快照" tone="primary" onClick={props.onSaveSnapshot} />
              <ActionButton icon={Rocket} label="发正式版本" tone="primary" onClick={props.onPublishRelease} />
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <ActionButton icon={Download} label="导出" compact onClick={props.onExport} />
              <ActionButton icon={FolderUp} label="导入" compact onClick={props.onImportClick} />
              <ActionButton icon={RotateCcw} label="重置草稿" compact onClick={props.onReset} />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <StatusChip label="正式版" value={`${releaseSnapshots.length}`} />
              <StatusChip label="快照" value={`${normalSnapshots.length}`} />
              <StatusChip label="当前草稿" value={props.lastSavedAt ? '已保存' : '待保存'} />
            </div>
          </div>

          <SnapshotSection title="正式版本" emptyText="还没有正式版本。">
            {releaseSnapshots.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                primaryActionLabel="恢复到草稿"
                onLoad={() => props.onLoadSnapshot(snapshot.id)}
                onDelete={() => props.onDeleteSnapshot(snapshot.id)}
                shareDetails={
                  <ShareCard
                    share={props.shareLinks[snapshot.id] ?? null}
                    onCreate={() => props.onCreateShare(snapshot.id)}
                    onCopy={() => props.onCopyShareLink(snapshot.id)}
                    onRevoke={() => props.onRevokeShare(snapshot.id)}
                  />
                }
              />
            ))}
          </SnapshotSection>

          <SnapshotSection title="草稿快照" emptyText="还没有草稿快照。">
            {normalSnapshots.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                primaryActionLabel="恢复到草稿"
                onLoad={() => props.onLoadSnapshot(snapshot.id)}
                onDelete={() => props.onDeleteSnapshot(snapshot.id)}
                extraAction={
                  <button
                    type="button"
                    onClick={() => props.onPromoteToRelease(snapshot.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800 transition hover:bg-amber-200"
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    发正式版
                  </button>
                }
              />
            ))}
          </SnapshotSection>
        </div>
      </div>
    </section>
  )
}

function ActionButton(props: {
  icon: typeof Save
  label: string
  onClick: () => void
  tone?: 'default' | 'primary'
  compact?: boolean
}) {
  const Icon = props.icon

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        props.compact
          ? 'inline-flex min-w-0 items-center gap-2 rounded-full border border-stone-900/10 bg-white px-3 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-100'
          : props.tone === 'primary'
            ? 'inline-flex min-w-0 items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-stone-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-800'
            : 'inline-flex min-w-0 items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-white px-4 py-3 text-sm font-medium text-stone-700 transition hover:bg-stone-100'
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{props.label}</span>
    </button>
  )
}

function MetaChip(props: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0 rounded-full border border-stone-900/10 bg-white px-3 py-2 text-stone-600">
      <span className="font-medium text-stone-500">{props.label}</span>
      <span className="ml-2 font-semibold text-stone-900">{props.value}</span>
    </div>
  )
}

function StatusChip(props: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-full border border-stone-900/10 bg-white px-3 py-2 text-sm text-stone-700">
      <span className="text-stone-500">{props.label}</span>
      <span className="ml-2 font-semibold text-stone-950">{props.value}</span>
    </div>
  )
}

function SnapshotSection(props: {
  title: string
  emptyText: string
  children: ReactNode
}) {
  const items = Array.isArray(props.children) ? props.children.filter(Boolean) : [props.children].filter(Boolean)

  return (
    <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/70 p-4">
      <p className="text-sm font-semibold text-stone-950">{props.title}</p>
      <div className="mt-3 grid gap-3">
        {items.length > 0 ? (
          items
        ) : (
          <div className="rounded-[18px] border border-dashed border-stone-300 bg-white/80 px-4 py-5 text-sm leading-7 text-stone-500">
            {props.emptyText}
          </div>
        )}
      </div>
    </div>
  )
}

function SnapshotCard(props: {
  snapshot: WorkspaceSnapshot
  primaryActionLabel: string
  onLoad: () => void
  onDelete: () => void
  extraAction?: ReactNode
  shareDetails?: ReactNode
}) {
  return (
    <div className="min-w-0 rounded-[20px] border border-stone-900/10 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(70,52,17,0.05)]">
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <p className="break-words text-base font-semibold text-stone-950">{props.snapshot.name}</p>
          <p className="mt-1 text-xs text-stone-500">{formatDateTime(props.snapshot.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onLoad}
            className="rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-stone-800"
          >
            {props.primaryActionLabel}
          </button>
          {props.extraAction}
          <button
            type="button"
            onClick={props.onDelete}
            className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
        {props.shareDetails}
      </div>
    </div>
  )
}

function ShareCard(props: {
  share: VersionShareResponse | null
  onCreate: () => void
  onCopy: () => void
  onRevoke: () => void
}) {
  return (
    <div className="rounded-[18px] border border-stone-900/10 bg-stone-50/90 p-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold tracking-[0.16em] text-stone-500">分享链接</p>
          <p className="shrink-0 text-xs text-stone-500">{props.share ? formatDateTime(props.share.updatedAt) : '未启用'}</p>
        </div>
        <p className="text-sm text-stone-600">{props.share ? '当前版本已经开放只读分享。' : '创建一个对外只读的版本链接。'}</p>
        {props.share ? (
          <div className="rounded-2xl border border-stone-900/10 bg-white px-3 py-2 text-xs font-medium text-stone-700 break-all">
            {props.share.sharePath}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {props.share ? (
          <>
            <button
              type="button"
              onClick={props.onCopy}
              className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-stone-800"
            >
              <Copy className="h-3.5 w-3.5" />
              复制链接
            </button>
            <button
              type="button"
              onClick={props.onRevoke}
              className="rounded-full border border-stone-900/10 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
            >
              撤销分享
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={props.onCreate}
            className="rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-stone-800"
          >
            创建分享
          </button>
        )}
      </div>
    </div>
  )
}
