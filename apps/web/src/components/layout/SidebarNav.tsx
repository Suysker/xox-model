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
    <>
      <aside className="xl:hidden">
        <Panel className="overflow-hidden p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-100/80 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-stone-600">
              <Sparkles className="h-4 w-4 text-amber-600" />
              XOX 工作台
            </div>
            <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-600">
              {snapshotCountLabel}
            </span>
          </div>

          <button
            type="button"
            onClick={props.onOpenWorkspace}
            className="mt-3 flex w-full items-center justify-between gap-3 rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-3 text-left transition hover:bg-white"
          >
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-500">当前工作区</p>
              <p className="mt-1 truncate text-base font-semibold text-stone-950">{props.workspaceName}</p>
              <div className="mt-2 inline-flex items-center gap-2 text-xs text-stone-500">
                <Clock3 className="h-3.5 w-3.5 text-amber-600" />
                <span>{props.lastSavedAt ? formatDateTime(props.lastSavedAt) : '自动保存中'}</span>
              </div>
            </div>
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-stone-900/10 bg-white text-stone-700">
              <FolderKanban className="h-4 w-4 text-amber-600" />
            </span>
          </button>

          <nav className="mt-3 grid grid-cols-2 gap-2">
            {props.mainItems.map((item, index) => (
              <CompactNavPill
                key={item.value}
                icon={item.icon}
                step={index + 1}
                label={item.label}
                active={props.mainValue === item.value}
                onClick={() => props.onMainChange(item.value)}
              />
            ))}
          </nav>

          {props.secondaryItems.length > 1 ? (
            <div className="mt-3 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-stone-500">
                <Layers3 className="h-4 w-4 text-emerald-600" />
                {props.secondaryTitle}
              </div>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {props.secondaryItems.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => props.onSecondaryChange(item.value)}
                    className={cx(
                      'shrink-0 rounded-full border px-3 py-2 text-sm font-semibold transition',
                      props.secondaryValue === item.value
                        ? 'border-amber-300 bg-amber-100 text-amber-800'
                        : 'border-stone-900/10 bg-white text-stone-600 hover:bg-stone-100',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex items-center justify-between gap-3 rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-stone-950 text-sm font-semibold text-amber-100">
                {getInitials(userName)}
              </div>
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-stone-500">
                  <UserCircle2 className="h-4 w-4 text-stone-500" />
                  当前账号
                </div>
                <p className="mt-1 truncate text-sm font-semibold text-stone-950">{userName}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={props.onLogout}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-900/10 bg-white text-stone-700 transition hover:bg-stone-100"
                aria-label="退出登录"
              >
                <LogOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={props.onCancelAccount}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-rose-200 bg-rose-50 text-rose-700 transition hover:bg-rose-100"
                aria-label="注销账号"
              >
                <ShieldAlert className="h-4 w-4" />
              </button>
            </div>
          </div>
        </Panel>
      </aside>

      <aside className="hidden xl:block xl:w-[244px] xl:shrink-0 xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)]">
        <Panel className="flex h-full flex-col gap-3 overflow-hidden p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex min-w-0 items-center gap-2 rounded-full border border-stone-900/10 bg-stone-100/80 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-stone-600">
              <Sparkles className="h-4 w-4 shrink-0 text-amber-600" />
              <span className="truncate">XOX 工作台</span>
            </div>
            <span className="rounded-full border border-stone-900/10 bg-white px-2.5 py-1 text-[11px] font-semibold text-stone-600">
              {snapshotCountLabel}
            </span>
          </div>

          <button
            type="button"
            onClick={props.onOpenWorkspace}
            className="rounded-[22px] border border-stone-900/10 bg-white/90 p-3 text-left transition hover:bg-white"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.16em] text-stone-500">当前工作区</p>
                <p className="mt-1 line-clamp-2 text-base font-semibold text-stone-950">{props.workspaceName}</p>
                <div className="mt-2 inline-flex items-center gap-2 text-xs text-stone-500">
                  <Clock3 className="h-3.5 w-3.5 text-amber-600" />
                  <span>{props.lastSavedAt ? formatDateTime(props.lastSavedAt) : '自动保存中'}</span>
                </div>
              </div>
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-stone-900/10 bg-stone-50 text-stone-700">
                <FolderKanban className="h-4 w-4 text-amber-600" />
              </span>
            </div>
          </button>

          <nav className="grid gap-2">
            {props.mainItems.map((item, index) => (
              <MainNavRow
                key={item.value}
                icon={item.icon}
                step={index + 1}
                label={item.label}
                description={item.description}
                active={props.mainValue === item.value}
                onClick={() => props.onMainChange(item.value)}
              />
            ))}
          </nav>

          {props.secondaryItems.length > 1 ? (
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.16em] text-stone-500">
                <Layers3 className="h-4 w-4 text-emerald-600" />
                {props.secondaryTitle}
              </div>
              <div className="mt-2 grid gap-2">
                {props.secondaryItems.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => props.onSecondaryChange(item.value)}
                    className={cx(
                      'w-full rounded-full border px-3 py-2 text-sm font-semibold whitespace-nowrap transition',
                      props.secondaryValue === item.value
                        ? 'border-amber-300 bg-amber-100 text-amber-800'
                        : 'border-stone-900/10 bg-white text-stone-600 hover:bg-stone-100',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-auto rounded-[22px] border border-stone-900/10 bg-stone-50/80 p-3">
            <div className="flex items-center gap-3">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-stone-950 text-sm font-semibold text-amber-100">
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

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={props.onLogout}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-stone-900/10 bg-white px-3 py-2.5 text-sm font-semibold text-stone-700 whitespace-nowrap transition hover:bg-stone-100"
              >
                <LogOut className="h-4 w-4" />
                退出
              </button>
              <button
                type="button"
                onClick={props.onCancelAccount}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-semibold text-rose-700 whitespace-nowrap transition hover:bg-rose-100"
              >
                <ShieldAlert className="h-4 w-4" />
                注销
              </button>
            </div>
          </div>
        </Panel>
      </aside>
    </>
  )
}

function CompactNavPill(props: {
  icon: LucideIcon
  step: number
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
        'inline-flex min-h-[60px] w-full items-center gap-3 rounded-[20px] border px-3 py-3 text-left transition',
        props.active
          ? 'border-stone-950 bg-stone-950 text-white shadow-[0_12px_28px_rgba(41,37,36,0.14)]'
          : 'border-stone-900/10 bg-stone-50 text-stone-800 hover:bg-white',
      )}
    >
      <span
        className={
          props.active
            ? 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-amber-200'
            : 'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-stone-900/10 bg-white text-amber-700'
        }
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className={props.active ? 'text-[11px] font-semibold tracking-[0.16em] text-stone-400' : 'text-[11px] font-semibold tracking-[0.16em] text-stone-500'}>
          {String(props.step).padStart(2, '0')}
        </span>
        <span className={props.active ? 'mt-1 block text-sm font-semibold text-white' : 'mt-1 block text-sm font-semibold text-stone-950'}>
          {props.label}
        </span>
      </span>
    </button>
  )
}

function MainNavRow(props: {
  icon: LucideIcon
  step: number
  label: string
  description: string
  active: boolean
  onClick: () => void
}) {
  const Icon = props.icon

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cx(
        'flex min-h-[72px] items-center gap-3 rounded-[20px] border px-3 py-3 text-left transition',
        props.active
          ? 'border-stone-950 bg-stone-950 text-white shadow-[0_12px_28px_rgba(41,37,36,0.14)]'
          : 'border-stone-900/10 bg-white/85 text-stone-800 hover:bg-white',
      )}
    >
      <span
        className={
          props.active
            ? 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-amber-200'
            : 'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-stone-900/10 bg-stone-950 text-amber-100'
        }
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className={props.active ? 'text-[11px] font-semibold tracking-[0.16em] text-stone-400' : 'text-[11px] font-semibold tracking-[0.16em] text-stone-500'}>
          {String(props.step).padStart(2, '0')}
        </span>
        <span className={props.active ? 'mt-1 block text-sm font-semibold text-white' : 'mt-1 block text-sm font-semibold text-stone-950'}>
          {props.label}
        </span>
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
