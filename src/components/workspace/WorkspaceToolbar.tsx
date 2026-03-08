import { History } from 'lucide-react'

export function WorkspaceToolbar(props: {
  snapshotCount: number
  libraryOpen: boolean
  onToggleLibrary: () => void
}) {
  const badge = props.snapshotCount > 99 ? '99+' : `${props.snapshotCount}`

  return (
    <button
      type="button"
      aria-label={props.libraryOpen ? '收起版本库' : '打开版本库'}
      title={props.libraryOpen ? '收起版本库' : '打开版本库'}
      onClick={props.onToggleLibrary}
      className={
        props.libraryOpen
          ? 'relative inline-flex h-12 w-12 items-center justify-center rounded-full border border-stone-900/10 bg-stone-950 text-white shadow-[0_20px_40px_rgba(41,37,36,0.26)] transition hover:bg-stone-800'
          : 'relative inline-flex h-12 w-12 items-center justify-center rounded-full border border-stone-900/10 bg-white/92 text-stone-800 shadow-[0_20px_40px_rgba(70,52,17,0.16)] backdrop-blur transition hover:bg-white'
      }
    >
      <History className="h-5 w-5" />
      {props.snapshotCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-stone-950">
          {badge}
        </span>
      ) : null}
    </button>
  )
}
