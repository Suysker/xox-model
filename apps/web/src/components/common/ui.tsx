import { forwardRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../../lib/format'
import { actionText, controlValue, eyebrowTracking, headerTracking, label, meta, pageTitle, sectionTitle, summaryValue } from './typography'

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
  description?: string | undefined
  dark?: boolean | undefined
  aside?: ReactNode
  titleScale?: 'page' | 'section' | undefined
}) {
  const Icon = props.icon
  const titleClass = props.titleScale === 'page' ? pageTitle : sectionTitle

  return (
    <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-start md:justify-between">
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
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p
              className={
                props.dark
                  ? cx('shrink-0 text-stone-400', label, eyebrowTracking)
                  : cx('shrink-0 text-stone-500', label, eyebrowTracking)
              }
            >
              {props.eyebrow}
            </p>
            <h2 className={cx('min-w-0', titleClass, props.dark ? 'text-white' : 'text-stone-950')}>
              {props.title}
            </h2>
          </div>
          {props.description ? (
            <p
              className={props.dark ? cx('max-w-4xl text-stone-300', meta) : cx('max-w-4xl text-stone-600', meta)}
            >
              {props.description}
            </p>
          ) : null}
        </div>
      </div>
      {props.aside ? <div className="min-w-0 md:ml-auto">{props.aside}</div> : null}
    </div>
  )
}

export function StatCard(props: {
  label: string
  value: string
  dark?: boolean | undefined
  layout?: 'stacked' | 'inline' | undefined
}) {
  const inline = props.layout === 'inline'

  return (
    <div
      className={cx(
        props.dark
          ? 'rounded-[22px] border border-white/10 bg-white/5 p-4'
          : 'rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4',
        inline && 'flex items-center justify-between gap-4',
      )}
    >
      <p
        className={cx(
          props.dark
            ? inline
              ? cx('text-stone-300', label)
              : cx('text-stone-400 uppercase tracking-[0.2em]', label)
            : inline
              ? cx('text-stone-600', label)
              : cx('text-stone-500 uppercase tracking-[0.2em]', label),
          inline && 'whitespace-nowrap',
        )}
      >
        {props.label}
      </p>
      <p
        className={cx(
          props.dark ? cx('text-white', summaryValue) : cx('text-stone-950', summaryValue),
          !inline && 'mt-2',
          inline && 'whitespace-nowrap',
        )}
      >
        {props.value}
      </p>
    </div>
  )
}

export function InlineStatPill(props: {
  label: string
  value: string
  tone?: 'default' | 'ok' | 'warn' | 'accent' | undefined
  dark?: boolean | undefined
  className?: string | undefined
}) {
  const lightToneClass =
    props.tone === 'ok'
      ? 'border-emerald-200 bg-emerald-50'
      : props.tone === 'warn'
        ? 'border-amber-200 bg-amber-50'
        : props.tone === 'accent'
          ? 'border-sky-200 bg-sky-50'
          : 'border-stone-900/10 bg-stone-50/90'
  const darkToneClass =
    props.tone === 'accent' ? 'border-amber-300/30 bg-amber-300/12' : 'border-white/10 bg-white/5'

  return (
    <div
      className={cx(
        'inline-flex min-w-[170px] items-center justify-between gap-4 rounded-[18px] border px-4 py-3 whitespace-nowrap',
        props.dark ? darkToneClass : lightToneClass,
        props.className,
      )}
    >
      <span className={props.dark ? cx('text-stone-300', label) : cx('text-stone-600', label)}>
        {props.label}
      </span>
      <span className={props.dark ? cx('text-white', summaryValue) : cx('text-stone-950', summaryValue)}>
        {props.value}
      </span>
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
            'rounded-full px-4 transition',
            props.compact ? 'py-1.5' : 'py-2',
            actionText,
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
  className?: string | undefined
}) {
  return (
    <th
      rowSpan={props.rowSpan}
      colSpan={props.colSpan}
      className={cx(
        'whitespace-nowrap px-2 py-2 align-middle text-center',
        meta,
        headerTracking,
        props.align === 'left' && 'text-left',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
        props.className,
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
        'px-2 py-1.5 align-middle text-center text-stone-700',
        controlValue,
        props.align === 'left' && 'text-left',
        props.align === 'right' && 'text-right',
        props.align === 'center' && 'text-center',
        props.className,
      )}
    >
      {props.children}
    </td>
  )
}

type DenseFieldSize = 'xs' | 'sm' | 'md'
type DenseFieldSurface = 'soft' | 'white' | 'ghost'

function getDenseFieldSizeClass(fieldSize: DenseFieldSize) {
  if (fieldSize === 'xs') {
    return cx('h-8 rounded-md px-2', controlValue)
  }

  if (fieldSize === 'sm') {
    return cx('h-9 rounded-lg px-2.5', controlValue)
  }

  return cx('h-11 rounded-2xl px-4', controlValue)
}

function getDenseFieldSurfaceClass(surface: DenseFieldSurface) {
  if (surface === 'ghost') {
    return 'border-transparent bg-transparent focus:border-transparent focus:bg-transparent'
  }

  if (surface === 'white') {
    return 'border-stone-900/10 bg-white focus:border-emerald-500'
  }

  return 'border-stone-900/10 bg-stone-50 focus:border-emerald-500 focus:bg-white'
}

export const DenseFieldInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  fieldSize?: DenseFieldSize | undefined
  align?: 'left' | 'center' | 'right' | undefined
  surface?: DenseFieldSurface | undefined
}>(function DenseFieldInput(
  props,
  ref,
) {
  const { fieldSize = 'sm', align, surface = 'soft', className, ...rest } = props

  return (
    <input
      {...rest}
      ref={ref}
      className={cx(
        'w-full border text-stone-900 outline-none transition disabled:cursor-not-allowed disabled:opacity-60',
        getDenseFieldSizeClass(fieldSize),
        getDenseFieldSurfaceClass(surface),
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        className,
      )}
    />
  )
})

export const DenseFieldSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & {
  fieldSize?: DenseFieldSize | undefined
  align?: 'left' | 'center' | 'right' | undefined
  surface?: DenseFieldSurface | undefined
}>(function DenseFieldSelect(
  props,
  ref,
) {
  const { fieldSize = 'sm', align, surface = 'soft', className, children, ...rest } = props

  return (
    <select
      {...rest}
      ref={ref}
      className={cx(
        'w-full border text-stone-900 outline-none transition disabled:cursor-not-allowed disabled:opacity-60',
        getDenseFieldSizeClass(fieldSize),
        getDenseFieldSurfaceClass(surface),
        align === 'center' && 'text-center',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </select>
  )
})

export function CompactNumberInput(props: {
  value: number
  onChange: (value: number) => void
  prefix?: string | undefined
  step?: number | 'any' | undefined
  min?: number | undefined
  max?: number | undefined
  suffix?: string | undefined
  size?: 'xs' | 'sm' | 'md' | undefined
  align?: 'left' | 'center' | 'right' | undefined
  className?: string | undefined
  inputClassName?: string | undefined
  emptyWhenZero?: boolean | undefined
}) {
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const resolvedValue = Number.isFinite(props.value) ? props.value : 0
  const displayValue = draftValue ?? (props.emptyWhenZero && resolvedValue === 0 ? '' : resolvedValue)

  return (
    <div
      className={cx(
        'flex items-center overflow-hidden border border-stone-900/10 bg-stone-50 focus-within:border-emerald-500 focus-within:bg-white',
        props.size === 'xs'
          ? 'h-8 rounded-md'
          : props.size === 'sm'
            ? 'h-9 rounded-lg'
            : 'h-10 rounded-xl',
        props.className,
      )}
    >
      {props.prefix ? (
        <span
          className={cx(
            'shrink-0 text-stone-500',
            meta,
            props.size === 'xs' ? 'pl-1.5' : props.size === 'sm' ? 'pl-2' : 'pl-3',
          )}
        >
          {props.prefix}
        </span>
      ) : null}
      <input
        className={cx(
          'compact-number-input-field h-full min-w-0 flex-1 border-none bg-transparent tabular-nums text-stone-900 outline-none',
          controlValue,
          props.size === 'xs' ? 'px-2' : props.size === 'sm' ? 'px-2.5' : 'px-3',
          props.align === 'center' && 'text-center',
          props.align === 'right' && 'text-right',
          props.inputClassName,
        )}
        type="number"
        value={displayValue}
        step={props.step}
        min={props.min}
        max={props.max}
        onChange={(event) => {
          const nextValue = event.target.value
          setDraftValue(nextValue)
          props.onChange(nextValue === '' ? 0 : Number(nextValue))
        }}
        onBlur={() => setDraftValue(null)}
      />
      {props.suffix ? (
        <span
          className={cx(
            'uppercase text-stone-500',
            meta,
            headerTracking,
            props.size === 'xs' ? 'pr-1.5' : props.size === 'sm' ? 'pr-2' : 'pr-3',
          )}
        >
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
        <span className={cx('text-stone-800', label)}>{props.label}</span>
        {props.helper ? <p className={cx('text-stone-500', meta)}>{props.helper}</p> : null}
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
          className={cx('h-full flex-1 border-none bg-transparent px-4 text-stone-900 outline-none', controlValue)}
          type="number"
          value={Number.isFinite(props.value) ? props.value : 0}
          step={props.step}
          min={props.min}
          max={props.max}
          onChange={(event) => props.onChange(Number(event.target.value))}
        />
        {props.suffix ? (
          <span className={cx('pr-4 uppercase text-stone-500 tracking-[0.18em]', meta)}>
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
        className={cx(
          'min-h-28 rounded-2xl border border-stone-900/10 bg-stone-100/80 px-4 py-3 text-stone-900 outline-none transition focus:border-emerald-500 focus:bg-white',
          controlValue,
        )}
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
