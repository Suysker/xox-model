import { Download, Rocket, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatDateTime } from '../../lib/format'
import { Panel, SectionTitle, StatCard } from '../common/ui'
import type { WorkspaceSnapshot } from '../../types'

export function WorkspacePanel(props: {
  snapshots: WorkspaceSnapshot[]
  onLoadSnapshot: (id: string) => void
  onDeleteSnapshot: (id: string) => void
  onPromoteToRelease: (id: string) => void
}) {
  const releaseSnapshots = props.snapshots.filter((snapshot) => snapshot.kind === 'release')
  const normalSnapshots = props.snapshots.filter((snapshot) => snapshot.kind === 'snapshot')

  return (
    <Panel>
      <SectionTitle
        icon={Download}
        eyebrow="Workspace"
        title="版本与快照"
        description="这里管理本地版本。发布版适合做里程碑基线，普通快照适合存草稿。"
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="发布版本" value={`${releaseSnapshots.length} 个`} />
        <StatCard label="普通快照" value={`${normalSnapshots.length} 个`} />
        <StatCard label="总版本数" value={`${props.snapshots.length} 个`} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-[24px] border border-stone-900/10 bg-stone-50/90 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">发布版</p>
          <div className="mt-3 grid gap-3">
            {releaseSnapshots.length > 0 ? (
              releaseSnapshots.map((snapshot) => (
                <SnapshotCard
                  key={snapshot.id}
                  snapshot={snapshot}
                  onLoad={() => props.onLoadSnapshot(snapshot.id)}
                  onDelete={() => props.onDeleteSnapshot(snapshot.id)}
                />
              ))
            ) : (
              <EmptyState text="还没有发布版。用顶部的“发布版本”固化一个基线。" />
            )}
          </div>
        </div>

        <div className="rounded-[24px] border border-stone-900/10 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">普通快照</p>
          <div className="mt-3 grid gap-3">
            {normalSnapshots.length > 0 ? (
              normalSnapshots.map((snapshot) => (
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
                      升级为发布版
                    </button>
                  }
                />
              ))
            ) : (
              <EmptyState text="还没有普通快照。用顶部的“保存快照”记录阶段性状态。" />
            )}
          </div>
        </div>
      </div>
    </Panel>
  )
}

function SnapshotCard(props: {
  snapshot: WorkspaceSnapshot
  onLoad: () => void
  onDelete: () => void
  extraAction?: ReactNode
}) {
  return (
    <div className="rounded-[20px] border border-stone-900/10 bg-white px-4 py-4 shadow-[0_10px_30px_rgba(70,52,17,0.05)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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
            加载
          </button>
          {props.extraAction}
          <button
            type="button"
            onClick={props.onDelete}
            className="inline-flex items-center gap-1 rounded-full border border-stone-900/10 bg-white px-3 py-1 text-xs font-semibold text-stone-700 transition hover:bg-stone-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </button>
        </div>
      </div>
    </div>
  )
}

function EmptyState(props: { text: string }) {
  return (
    <div className="rounded-[20px] border border-dashed border-stone-300 bg-stone-100/70 px-4 py-6 text-sm leading-7 text-stone-500">
      {props.text}
    </div>
  )
}
