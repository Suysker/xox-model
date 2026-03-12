import type { LucideIcon } from 'lucide-react'
import { Compass, Layers3 } from 'lucide-react'
import { cx } from '../../lib/format'
import { Panel } from '../common/ui'

export function SidebarNav<T extends string, U extends string>(props: {
  title: string
  subtitle: string
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
  return (
    <aside className="grid gap-4 xl:sticky xl:top-4 xl:self-start">
      <Panel className="p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
          <Compass className="h-4 w-4 text-amber-500" />
          Navigation
        </div>
        <h2 className="mt-3 text-lg font-semibold text-stone-950">{props.title}</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">{props.subtitle}</p>

        <div className="mt-4 grid gap-2">
          {props.mainItems.map((item) => (
            <MainNavButton
              key={item.value}
              icon={item.icon}
              label={item.label}
              description={item.description}
              active={props.mainValue === item.value}
              onClick={() => props.onMainChange(item.value)}
            />
          ))}
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-stone-500">
          <Layers3 className="h-4 w-4 text-emerald-600" />
          {props.secondaryTitle}
        </div>
        <div className="mt-4 grid gap-2">
          {props.secondaryItems.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => props.onSecondaryChange(item.value)}
              className={cx(
                'rounded-[18px] border px-4 py-3 text-left transition',
                props.secondaryValue === item.value
                  ? 'border-amber-300 bg-amber-100/90'
                  : 'border-stone-900/10 bg-stone-50/80 hover:bg-white',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-stone-950">{item.label}</span>
                <span
                  className={
                    props.secondaryValue === item.value
                      ? 'rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-800'
                      : 'rounded-full border border-stone-900/10 bg-white px-2 py-0.5 text-[11px] font-semibold text-stone-500'
                  }
                >
                  {props.secondaryValue === item.value ? '当前' : '切换'}
                </span>
              </div>
              {item.description ? (
                <p className="mt-2 text-xs leading-5 text-stone-500">{item.description}</p>
              ) : null}
            </button>
          ))}
        </div>
      </Panel>
    </aside>
  )
}

function MainNavButton(props: {
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
        'rounded-[20px] border px-4 py-3 text-left transition',
        props.active
          ? 'border-stone-950 bg-stone-950 text-white shadow-[0_14px_30px_rgba(41,37,36,0.16)]'
          : 'border-stone-900/10 bg-stone-50/80 text-stone-900 hover:bg-white',
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={
            props.active
              ? 'rounded-2xl border border-white/10 bg-white/10 p-2.5 text-amber-200'
              : 'rounded-2xl border border-stone-900/10 bg-stone-950 p-2.5 text-amber-100'
          }
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className={props.active ? 'text-sm font-semibold text-white' : 'text-sm font-semibold text-stone-950'}>
            {props.label}
          </p>
          <p className={props.active ? 'mt-1 text-xs leading-5 text-stone-300' : 'mt-1 text-xs leading-5 text-stone-500'}>
            {props.description}
          </p>
        </div>
      </div>
    </button>
  )
}
