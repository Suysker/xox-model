import { Download, FolderUp, Rocket, RotateCcw, Save, Trash2, X } from 'lucide-react'
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
    <section className="flex h-full flex-col overflow-hidden rounded-[30px] border border-stone-900/10 bg-white/96 shadow-[0_30px_90px_rgba(41,37,36,0.22)] backdrop-blur">
      <div className="flex items-start justify-between gap-4 border-b border-stone-900/10 px-5 py-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">Workspace</p>
          <h2 className="mt-2 text-2xl font-bold text-stone-950">Versions and draft flow</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Save snapshots, publish releases, export or import bundles, and roll back from version history here.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close workspace panel"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-900/10 bg-stone-50 text-stone-700 transition hover:bg-stone-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="grid gap-5">
          <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/90 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Workspace name</p>
            <input
              className="mt-3 h-11 w-full rounded-2xl border border-stone-900/10 bg-white px-4 text-base font-semibold text-stone-950 outline-none transition focus:border-emerald-500"
              value={props.workspaceName}
              onChange={(event) => props.onNameChange(event.target.value)}
              placeholder="Forecast workspace"
            />
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <MetaChip label="Last autosave" value={formatDateTime(props.lastSavedAt)} />
              <MetaChip label="Versions" value={`${props.snapshots.length}`} />
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <ActionButton icon={Save} label="Save snapshot" tone="primary" onClick={props.onSaveSnapshot} />
            <ActionButton icon={Rocket} label="Publish release" tone="primary" onClick={props.onPublishRelease} />
            <ActionButton icon={Download} label="Export JSON" onClick={props.onExport} />
            <ActionButton icon={FolderUp} label="Import JSON" onClick={props.onImportClick} />
            <ActionButton icon={RotateCcw} label="Reset draft" onClick={props.onReset} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Releases" value={`${releaseSnapshots.length}`} />
            <StatCard label="Snapshots" value={`${normalSnapshots.length}`} />
            <StatCard label="Draft status" value={props.lastSavedAt ? 'Autosaved' : 'Unsaved'} />
          </div>

          <SnapshotSection
            title="Published releases"
            emptyText="No release has been published yet. Publish one when you want to lock a baseline for bookkeeping and variance analysis."
          >
            {releaseSnapshots.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
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

          <SnapshotSection
            title="Working snapshots"
            emptyText="No working snapshot yet. Save one before making a risky change if you want a quick rollback point."
          >
            {normalSnapshots.map((snapshot) => (
              <SnapshotCard
                key={snapshot.id}
                snapshot={snapshot}
                onLoad={() => props.onLoadSnapshot(snapshot.id)}
                onDelete={() => props.onDeleteSnapshot(snapshot.id)}
                extraAction={
                  <button
                    type="button"
                    onClick={() => props.onPromoteToRelease(snapshot.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 transition hover:bg-amber-200"
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    Promote
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
  tone?: 'default' | 'primary' | undefined
}) {
  const Icon = props.icon

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        props.tone === 'primary'
          ? 'inline-flex items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-stone-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-800'
          : 'inline-flex items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-white px-4 py-3 text-sm font-medium text-stone-700 transition hover:bg-stone-100'
      }
    >
      <Icon className="h-4 w-4" />
      {props.label}
    </button>
  )
}

function MetaChip(props: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-full border border-stone-900/10 bg-white px-3 py-2 text-stone-600">
      <span className="font-medium text-stone-500">{props.label}</span>
      <span className="ml-2 font-semibold text-stone-900">{props.value}</span>
    </div>
  )
}

function StatCard(props: {
  label: string
  value: string
}) {
  return (
    <div className="rounded-[20px] border border-stone-900/10 bg-stone-50/90 p-4">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{props.label}</p>
      <p className="mt-2 text-lg font-bold text-stone-950">{props.value}</p>
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
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">{props.title}</p>
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
  onLoad: () => void
  onDelete: () => void
  extraAction?: ReactNode
  shareDetails?: ReactNode
}) {
  return (
    <div className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(70,52,17,0.05)]">
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold text-stone-950">{props.snapshot.name}</p>
          <p className="mt-1 text-xs text-stone-500">{formatDateTime(props.snapshot.createdAt)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={props.onLoad}
            className="rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1 text-xs font-semibold text-white transition hover:bg-stone-800"
          >
            Roll back
          </button>
          {props.extraAction}
          <button
            type="button"
            onClick={props.onDelete}
            className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">Share link</p>
          <p className="mt-1 text-sm text-stone-600">
            {props.share ? 'A public read-only link is active for this release.' : 'Create a public read-only link for this release.'}
          </p>
          {props.share ? (
            <p className="mt-2 truncate rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-medium text-stone-700">
              {props.share.sharePath}
            </p>
          ) : null}
        </div>
        <p className="shrink-0 text-xs text-stone-500">{props.share ? formatDateTime(props.share.updatedAt) : 'Inactive'}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {props.share ? (
          <>
            <button
              type="button"
              onClick={props.onCopy}
              className="rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1 text-xs font-semibold text-white transition hover:bg-stone-800"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={props.onRevoke}
              className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
            >
              Revoke
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={props.onCreate}
            className="rounded-full border border-stone-900/10 bg-stone-950 px-3 py-1 text-xs font-semibold text-white transition hover:bg-stone-800"
          >
            Create share
          </button>
        )}
      </div>
    </div>
  )
}
