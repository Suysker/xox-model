import { useState } from 'react'
import { LockKeyhole, UserRoundPlus } from 'lucide-react'
import { Panel, SectionTitle } from '../common/ui'

type Mode = 'login' | 'register'

export function AuthScreen(props: {
  loading: boolean
  error: string | null
  onLogin: (payload: { email: string; password: string }) => Promise<void>
  onRegister: (payload: { email: string; password: string; displayName: string }) => Promise<void>
}) {
  const [mode, setMode] = useState<Mode>('login')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit() {
    if (mode === 'login') {
      await props.onLogin({ email, password })
      return
    }

    await props.onRegister({ email, password, displayName })
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.16),_transparent_28%),linear-gradient(180deg,_#fbf8f1_0%,_#f3ede3_100%)] px-4 py-8 text-stone-900 md:px-6">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <Panel className="p-8">
          <SectionTitle
            icon={LockKeyhole}
            eyebrow="Platform"
            title="Forecast, actuals, and versioned planning"
            description="Sign in to continue editing your forecast draft, publish baseline versions, record actual entries, and review variance by month."
          />
          <div className="mt-8 grid gap-4 text-sm leading-7 text-stone-600 md:grid-cols-2">
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              Forecast drafts autosave to the backend and keep a mutable working copy.
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              Published versions stay immutable and can be used as variance baselines.
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              Bookkeeping entries can be posted against forecast income and cost subjects.
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              Variance analysis compares actuals with the current period baseline.
            </div>
          </div>
        </Panel>

        <Panel className="p-6">
          <SectionTitle
            icon={UserRoundPlus}
            eyebrow="Access"
            title={mode === 'login' ? 'Login' : 'Create account'}
            description={mode === 'login' ? 'Use your existing account.' : 'A default workspace will be created for you.'}
          />

          <div className="mt-6 inline-flex rounded-full border border-stone-900/10 bg-stone-100/80 p-1">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={mode === 'login' ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white' : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600'}
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={mode === 'register' ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white' : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600'}
            >
              Register
            </button>
          </div>

          <div className="mt-6 grid gap-4">
            {mode === 'register' ? (
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-stone-700">Display name</span>
                <input
                  className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            ) : null}

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-700">Email</span>
              <input
                className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-semibold text-stone-700">Password</span>
              <input
                className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
              />
            </label>

            {props.error ? <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{props.error}</p> : null}

            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={props.loading}
              className="rounded-2xl bg-stone-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.loading ? 'Working...' : mode === 'login' ? 'Login' : 'Register'}
            </button>
          </div>
        </Panel>
      </div>
    </div>
  )
}
