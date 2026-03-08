import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../../lib/format'

export function Panel(props: {
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <section
      className={cx(
        'rounded-[28px] border border-stone-900/10 bg-white/88 p-5 shadow-[0_18px_50px_rgba(70,52,17,0.08)] backdrop-blur md:p-6',
        props.className,
      )}
    >
      {props.children}
    </section>
  )
}

export function SectionTitle(props: {
  icon: LucideIcon
  eyebrow: string
  title: string
  description: string
  dark?: boolean | undefined
  aside?: ReactNode
}) {
  const Icon = props.icon

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
      <div className="flex items-start gap-3">
        <div
          className={
            props.dark
              ? 'rounded-2xl border border-white/10 bg-white/10 p-3 text-amber-200'
              : 'rounded-2xl border border-stone-900/10 bg-stone-950 p-3 text-amber-100'
          }
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="space-y-2">
          <p
            className={
              props.dark
                ? 'text-xs font-semibold uppercase tracking-[0.28em] text-stone-400'
                : 'text-xs font-semibold uppercase tracking-[0.28em] text-stone-500'
            }
          >
            {props.eyebrow}
          </p>
          <h2 className={props.dark ? 'text-2xl font-bold text-white' : 'text-2xl font-bold text-stone-950'}>
            {props.title}
          </h2>
          <p className={props.dark ? 'max-w-4xl text-sm leading-7 text-stone-300' : 'max-w-4xl text-sm leading-7 text-stone-600'}>
            {props.description}
          </p>
        </div>
      </div>
      {props.aside ? <div className="shrink-0">{props.aside}</div> : null}
    </div>
  )
}

export function StatCard(props: {
  label: string
  value: string
  dark?: boolean | undefined
}) {
  return (
    <div
      className={
        props.dark
          ? 'rounded-[22px] border border-white/10 bg-white/5 p-4'
          : 'rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4'
      }
    >
      <p
        className={
          props.dark
            ? 'text-xs uppercase tracking-[0.2em] text-stone-400'
            : 'text-xs uppercase tracking-[0.2em] text-stone-500'
        }
      >
        {props.label}
      </p>
      <p className={props.dark ? 'mt-2 text-lg font-bold text-white' : 'mt-2 text-lg font-bold text-stone-950'}>
        {props.value}
      </p>
    </div>
  )
}

export function SegmentTabs<T extends string>(props: {
  value: T
  items: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  dark?: boolean | undefined
  compact?: boolean | undefined
}) {
  return (
    <div
      className={cx(
        'inline-flex flex-wrap gap-2 rounded-full border px-2 py-2',
        props.dark ? 'border-white/10 bg-white/5' : 'border-stone-900/10 bg-stone-100/70',
      )}
    >
      {props.items.map((item) => (
        <button
          key={item.value}
          type="button"
          onClick={() => props.onChange(item.value)}
          className={cx(
            'rounded-full px-4 font-medium transition',
            props.compact ? 'py-1.5 text-xs' : 'py-2 text-sm',
            props.value === item.value
              ? props.dark
                ? 'bg-amber-300/15 text-amber-100'
                : 'bg-stone-950 text-white'
              : props.dark
                ? 'text-stone-300 hover:bg-white/10'
                : 'text-stone-600 hover:bg-white',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function HeaderCell(props: {
  children: ReactNode
  align?: 'left' | 'right' | 'center' | undefined
  rowSpan?: number | undefined
  colSpan?: number | undefined
}) {
  return (
    <th
      rowSpan={props.rowSpan}
      colSpan={props.colSpan}
      className={cx(
        'px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em]',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
      )}
    >
      {props.children}
    </th>
  )
}

export function BodyCell(props: {
  children: ReactNode
  align?: 'left' | 'right' | 'center' | undefined
  className?: string | undefined
}) {
  return (
    <td
      className={cx(
        'px-4 py-3 align-top text-stone-700',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
        props.className,
      )}
    >
      {props.children}
    </td>
  )
}

export function CompactNumberInput(props: {
  value: number
  onChange: (value: number) => void
  step?: number | 'any' | undefined
  min?: number | undefined
  max?: number | undefined
  suffix?: string | undefined
}) {
  return (
    <div className="flex h-10 items-center overflow-hidden rounded-xl border border-stone-900/10 bg-stone-50 focus-within:border-emerald-500 focus-within:bg-white">
      <input
        className="h-full min-w-0 flex-1 border-none bg-transparent px-3 text-sm font-medium text-stone-900 outline-none"
        type="number"
        value={Number.isFinite(props.value) ? props.value : 0}
        step={props.step}
        min={props.min}
        max={props.max}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      {props.suffix ? (
        <span className="pr-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-500">
          {props.suffix}
        </span>
      ) : null}
    </div>
  )
}

function FieldShell(props: {
  label: string
  helper?: string | undefined
  children: ReactNode
}) {
  return (
    <label className="grid gap-2">
      <div className="space-y-1">
        <span className="text-sm font-semibold text-stone-800">{props.label}</span>
        {props.helper ? <p className="text-xs leading-5 text-stone-500">{props.helper}</p> : null}
      </div>
      {props.children}
    </label>
  )
}

export function NumberField(props: {
  label: string
  value: number
  onChange: (value: number) => void
  helper?: string | undefined
  step?: number | 'any' | undefined
  min?: number | undefined
  max?: number | undefined
  suffix?: string | undefined
  compact?: boolean | undefined
}) {
  return (
    <FieldShell label={props.label} helper={props.helper}>
      <div
        className={cx(
          'flex items-center overflow-hidden rounded-2xl border border-stone-900/10 bg-stone-100/80 focus-within:border-emerald-500 focus-within:bg-white',
          props.compact ? 'h-10' : 'h-11',
        )}
      >
        <input
          className="h-full flex-1 border-none bg-transparent px-4 text-sm font-medium text-stone-900 outline-none"
          type="number"
          value={Number.isFinite(props.value) ? props.value : 0}
          step={props.step}
          min={props.min}
          max={props.max}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        {props.suffix ? (
          <span className="pr-4 text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
            {props.suffix}
          </span>
        ) : null}
      </div>
    </FieldShell>
  )
}

export function TextAreaField(props: {
  label: string
  value: string
  onChange: (value: string) => void
  helper?: string | undefined
}) {
  return (
    <FieldShell label={props.label} helper={props.helper}>
      <textarea
        className="min-h-28 rounded-2xl border border-stone-900/10 bg-stone-100/80 px-4 py-3 text-sm font-medium text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </FieldShell>
  )
}

export function InlinePairField(props: {
  leftValue: number
  rightValue: number
  leftLabel: string
  rightLabel: string
  leftStep?: number | 'any' | undefined
  rightStep?: number | 'any' | undefined
  onLeftChange: (value: number) => void
  onRightChange: (value: number) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <CompactNumberInput
        value={props.leftValue}
        min={0}
        step={props.leftStep}
        suffix={props.leftLabel}
        onChange={props.onLeftChange}
      />
      <CompactNumberInput
        value={props.rightValue}
        min={0}
        step={props.rightStep}
        suffix={props.rightLabel}
        onChange={props.onRightChange}
      />
    </div>
  )
}
