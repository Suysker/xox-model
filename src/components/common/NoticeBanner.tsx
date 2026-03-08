import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cx } from '../../lib/format'

type NoticeTone = 'success' | 'error' | 'info'

const toneMeta: Record<
  NoticeTone,
  {
    icon: typeof Info
    className: string
  }
> = {
  success: {
    icon: CheckCircle2,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  error: {
    icon: AlertCircle,
    className: 'border-rose-200 bg-rose-50 text-rose-800',
  },
  info: {
    icon: Info,
    className: 'border-sky-200 bg-sky-50 text-sky-800',
  },
}

export function NoticeBanner(props: {
  tone: NoticeTone
  message: string
  onDismiss: () => void
}) {
  const Icon = toneMeta[props.tone].icon

  return (
    <div
      className={cx(
        'flex items-start justify-between gap-4 rounded-[22px] border px-4 py-3 text-sm shadow-[0_10px_30px_rgba(70,52,17,0.05)]',
        toneMeta[props.tone].className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="leading-6">{props.message}</p>
      </div>
      <button
        type="button"
        onClick={props.onDismiss}
        className="rounded-full border border-current/15 p-1 transition hover:bg-white/50"
        aria-label="关闭提示"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export type { NoticeTone }
