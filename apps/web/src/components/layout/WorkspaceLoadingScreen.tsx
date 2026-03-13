import { LoaderCircle, Sparkles } from 'lucide-react'
import { Panel } from '../common/ui'

export function WorkspaceLoadingScreen(props: {
  title: string
  description: string
}) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(16,185,129,0.12),_transparent_28%),linear-gradient(180deg,_#fcfaf5_0%,_#f2ebe0_100%)] px-4 py-8 text-stone-900 md:px-6">
      <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center">
        <Panel className="w-full max-w-xl rounded-[32px] p-8 md:p-10">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-100/80 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-stone-600">
            <Sparkles className="h-4 w-4 text-amber-600" />
            XOX 工作台
          </div>
          <div className="mt-6 flex items-center gap-3">
            <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-stone-900/10 bg-stone-950 text-amber-100">
              <LoaderCircle className="h-5 w-5 animate-spin" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-stone-950">{props.title}</h1>
              <p className="mt-2 text-sm leading-6 text-stone-600">{props.description}</p>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
