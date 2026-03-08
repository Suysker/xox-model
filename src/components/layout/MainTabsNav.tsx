import type { LucideIcon } from 'lucide-react'
import { cx } from '../../lib/format'

export function MainTabsNav<T extends string>(props: {
  tabs: Array<{
    value: T
    label: string
    description: string
    icon: LucideIcon
  }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <nav className="rounded-[24px] border border-stone-900/10 bg-white/88 p-2 shadow-[0_18px_50px_rgba(70,52,17,0.08)] backdrop-blur">
      <div className="grid gap-2 lg:grid-cols-3">
        {props.tabs.map((tab) => (
          <MainTabButton
            key={tab.value}
            icon={tab.icon}
            label={tab.label}
            description={tab.description}
            active={props.value === tab.value}
            onClick={() => props.onChange(tab.value)}
          />
        ))}
      </div>
    </nav>
  )
}

function MainTabButton(props: {
  icon: LucideIcon
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
        'rounded-[20px] border p-3 text-left transition',
        props.active
          ? 'border-amber-300 bg-amber-100/90 shadow-[0_12px_30px_rgba(70,52,17,0.08)]'
          : 'border-stone-900/10 bg-white/88 hover:bg-white',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-2xl border border-stone-900/10 bg-stone-950 p-2.5 text-amber-100">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-stone-950">{props.label}</h3>
            <p className="mt-1 truncate text-xs text-stone-500">{props.description}</p>
          </div>
        </div>
        <span
          className={
            props.active
              ? 'rounded-full border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800'
              : 'rounded-full border border-stone-900/10 bg-stone-50 px-2 py-1 text-[11px] font-semibold text-stone-500'
          }
        >
          {props.active ? '当前页' : '切换'}
        </span>
      </div>
    </button>
  )
}
