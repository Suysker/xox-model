import { AlertCircle, ArrowRight, LockKeyhole, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Panel } from '../common/ui'

type Mode = 'login' | 'register'

export function AuthScreen(props: {
  loading: boolean
  error: string | null
  onLogin: (payload: { email: string; password: string }) => Promise<void>
  onRegister: (payload: { email: string; password: string; displayName: string }) => Promise<void>
  onClearError?: (() => void) | undefined
}) {
  const [mode, setMode] = useState<Mode>('login')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  function clearError() {
    props.onClearError?.()
  }

  async function handleSubmit() {
    clearError()

    if (mode === 'login') {
      await props.onLogin({ email, password })
      return
    }

    await props.onRegister({ email, password, displayName })
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(16,185,129,0.1),_transparent_26%),linear-gradient(180deg,_#fcfaf5_0%,_#f2ebe0_100%)] px-4 py-8 text-stone-900 md:px-6">
      <div className="mx-auto flex min-h-screen max-w-6xl items-center">
        <div className="grid w-full gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <section className="relative overflow-hidden rounded-[36px] bg-stone-950 px-6 py-8 text-white shadow-[0_32px_100px_rgba(41,37,36,0.28)] md:px-8 md:py-10">
            <div className="absolute -right-10 top-0 h-40 w-40 rounded-full bg-amber-300/18 blur-3xl" />
            <div className="absolute bottom-0 left-0 h-32 w-32 rounded-full bg-emerald-300/10 blur-3xl" />

            <div className="relative flex h-full flex-col justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold tracking-[0.18em] text-stone-300">
                  <Sparkles className="h-4 w-4 text-amber-300" />
                  XOX 经营测算平台
                </div>

                <div className="mt-10 max-w-2xl">
                  <h1 className="text-3xl font-bold tracking-tight text-white md:text-5xl">进入经营工作台</h1>
                  <p className="mt-4 text-sm leading-7 text-stone-300 md:text-base">登录后继续处理测算、版本和记账。</p>
                </div>
              </div>
            </div>
          </section>

          <Panel className="self-center rounded-[32px] p-6 md:p-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-stone-900/10 bg-stone-100/80 px-3 py-1.5 text-xs font-semibold tracking-[0.16em] text-stone-600">
              <LockKeyhole className="h-4 w-4 text-amber-600" />
              账号访问
            </div>

            <div className="mt-5 flex items-center justify-between gap-3">
              <h2 className="text-3xl font-bold tracking-tight text-stone-950">{mode === 'login' ? '登录' : '注册'}</h2>
              <div className="inline-flex rounded-full border border-stone-900/10 bg-stone-100/90 p-1">
                <button
                  type="button"
                  disabled={props.loading}
                  onClick={() => {
                    clearError()
                    setMode('login')
                  }}
                  className={
                    mode === 'login'
                      ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(41,37,36,0.16)]'
                      : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600 transition hover:bg-white'
                  }
                >
                  登录
                </button>
                <button
                  type="button"
                  disabled={props.loading}
                  onClick={() => {
                    clearError()
                    setMode('register')
                  }}
                  className={
                    mode === 'register'
                      ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(41,37,36,0.16)]'
                      : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600 transition hover:bg-white'
                  }
                >
                  注册
                </button>
              </div>
            </div>

            <form
              className="mt-6 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSubmit()
              }}
            >
              {mode === 'register' ? (
                <label className="grid gap-2" htmlFor="auth-display-name">
                  <span className="text-sm font-semibold text-stone-700">显示名称</span>
                  <input
                    id="auth-display-name"
                    name="displayName"
                    autoComplete="name"
                    disabled={props.loading}
                    required
                    placeholder="例如：运营负责人"
                    className="h-12 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                    value={displayName}
                    onChange={(event) => {
                      clearError()
                      setDisplayName(event.target.value)
                    }}
                  />
                </label>
              ) : null}

              <label className="grid gap-2" htmlFor="auth-email">
                <span className="text-sm font-semibold text-stone-700">邮箱</span>
                <input
                  id="auth-email"
                  name="email"
                  autoComplete="email"
                  disabled={props.loading}
                  required
                  placeholder="name@company.com"
                  className="h-12 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  value={email}
                  onChange={(event) => {
                    clearError()
                    setEmail(event.target.value)
                  }}
                  type="email"
                />
              </label>

              <label className="grid gap-2" htmlFor="auth-password">
                <span className="text-sm font-semibold text-stone-700">密码</span>
                <input
                  id="auth-password"
                  name="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  disabled={props.loading}
                  required
                  minLength={6}
                  placeholder={mode === 'login' ? '输入密码' : '至少 6 位'}
                  className="h-12 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-60"
                  value={password}
                  onChange={(event) => {
                    clearError()
                    setPassword(event.target.value)
                  }}
                  type="password"
                />
              </label>

              {props.error ? (
                <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="leading-6">{props.error}</p>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={props.loading}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-stone-950 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {props.loading ? '处理中...' : mode === 'login' ? '进入工作区' : '创建并进入'}
                {props.loading ? null : <ArrowRight className="h-4 w-4" />}
              </button>
            </form>
          </Panel>
        </div>
      </div>
    </div>
  )
}
