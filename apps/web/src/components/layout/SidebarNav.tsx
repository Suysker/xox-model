import type { LucideIcon } from 'lucide-react'
import {
  Clock3,
  FolderKanban,
  Layers3,
  LogOut,
  ShieldAlert,
  Sparkles,
  UserCircle2,
} from 'lucide-react'
import type { AuthUser } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { Panel } from '../common/ui'

export function SidebarNav<T extends string, U extends string>(props: {
  title: string
  subtitle: string
  workspaceName: string
  lastSavedAt: string | null
  snapshotCount: number
  workspaceOpen: boolean
  currentUser: AuthUser | null
  onOpenWorkspace: () => void
  onLogout: () => void
  onCancelAccount: () => void
  mainItems: Array<{
    value: T
    label: string
    description: string
    icon: LucideIcon
  }>
  mainValue: T
  onMainChange: (value: T) => void
  secondaryTitle: string
  secondaryItems: Array<{ value: U; label: string; description?: string | undefined }>
  secondaryValue: U
  onSecondaryChange: (value: U) => void
}) {
  const snapshotCountLabel = props.snapshotCount > 0 ? `${props.snapshotCount} 个版本` : '草稿中'
  const userName = props.currentUser?.displayName?.trim() || props.currentUser?.email || '当前账号'

  return (
    <aside className="flex flex-col gap-3 xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)]">
      <Panel className="overflow-hidden p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-100/80 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-stone-600">
            <Sparkles className="h-4 w-4 text-amber-600" />
            XOX 工作台
          </div>
          <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-600">
            {snapshotCountLabel}
          </span>
        </div>

        <div className="mt-4 rounded-[24px] border border-stone-900/10 bg-stone-950 px-4 py-4 text-white shadow-[0_16px_36px_rgba(41,37,36,0.16)]">
          <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-400">当前工作区</p>
          <p className="mt-2 truncate text-base font-semibold text-white">{props.workspaceName}</p>
          <div className="mt-2 inline-flex items-center gap-2 text-xs text-stone-300">
            <Clock3 className="h-3.5 w-3.5 text-amber-300" />
            <span>{props.lastSavedAt ? `最近保存 ${formatDateTime(props.lastSavedAt)}` : '草稿会自动保存'}</span>
          </div>
          <button
            type="button"
            onClick={props.onOpenWorkspace}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15"
          >
            <FolderKanban className="h-4 w-4 text-amber-200" />
            {props.workspaceOpen ? '收起版本面板' : '打开版本面板'}
          </button>
        </div>
      </Panel>

      <Panel className="p-3">
        <div className="space-y-1 px-1 pb-2">
          <p className="text-xs font-semibold tracking-[0.18em] text-stone-500">主导航</p>
        </div>
        <div className="grid gap-2">
          {props.mainItems.map((item) => (
            <MainNavRow
              key={item.value}
              icon={item.icon}
              label={item.label}
              active={props.mainValue === item.value}
              onClick={() => props.onMainChange(item.value)}
            />
          ))}
        </div>
      </Panel>

      {props.secondaryItems.length > 1 ? (
        <Panel className="p-3">
          <div className="flex items-center gap-2 px-1 pb-3 text-xs font-semibold tracking-[0.18em] text-stone-500">
            <Layers3 className="h-4 w-4 text-emerald-600" />
            {props.secondaryTitle}
          </div>
          <div className="flex flex-wrap gap-2">
            {props.secondaryItems.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => props.onSecondaryChange(item.value)}
                className={cx(
                  'rounded-full border px-3 py-2 text-sm font-semibold transition',
                  props.secondaryValue === item.value
                    ? 'border-amber-300 bg-amber-100 text-amber-800'
                    : 'border-stone-900/10 bg-stone-50 text-stone-600 hover:bg-white',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel className="mt-auto p-3">
        <div className="flex items-center gap-3 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-stone-950 text-base font-semibold text-amber-100">
            {getInitials(userName)}
          </div>
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-stone-500">
              <UserCircle2 className="h-4 w-4 text-stone-500" />
              当前账号
            </div>
            <p className="mt-1 truncate text-sm font-semibold text-stone-950">{userName}</p>
            <p className="truncate text-xs text-stone-500">{props.currentUser?.email ?? '未登录邮箱'}</p>
          </div>
        </div>

        <div className="mt-3 grid gap-2">
          <button
            type="button"
            onClick={props.onLogout}
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-white px-4 py-3 text-sm font-semibold text-stone-700 transition hover:bg-stone-100"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
          <button
            type="button"
            onClick={props.onCancelAccount}
            className="inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
          >
            <ShieldAlert className="h-4 w-4" />
            注销账号
          </button>
        </div>
      </Panel>
    </aside>
  )
}

function MainNavRow(props: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  const Icon = props.icon

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        'flex items-center gap-3 rounded-[20px] border px-3 py-3 text-left transition',
        props.active
          ? 'border-stone-950 bg-stone-950 text-white shadow-[0_14px_30px_rgba(41,37,36,0.14)]'
          : 'border-stone-900/10 bg-stone-50/80 text-stone-800 hover:bg-white',
      )}
    >
      <span
        className={
          props.active
            ? 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-amber-200'
            : 'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-stone-900/10 bg-stone-950 text-amber-100'
        }
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className={props.active ? 'text-base font-semibold text-white' : 'text-base font-semibold text-stone-950'}>
        {props.label}
      </span>
    </button>
  )
}

function getInitials(value: string) {
  const trimmed = value.trim()

  if (!trimmed) {
    return 'X'
  }

  const parts = trimmed.split(/\s+/).filter(Boolean)

  if (parts.length >= 2) {
    const first = parts[0] ?? ''
    const second = parts[1] ?? ''
    return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase()
  }

  return trimmed.slice(0, 2).toUpperCase()
}
