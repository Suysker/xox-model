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
            eyebrow="平台"
            title="测算、实账与版本化经营规划"
            description="登录后继续编辑测算草稿、发布预算版本、登记实账，并按月份查看预实差异。"
          />
          <div className="mt-8 grid gap-4 text-sm leading-7 text-stone-600 md:grid-cols-2">
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              测算草稿会自动保存到后端，并保留一份可继续编辑的工作副本。
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              已发布版本保持不可变，可直接作为预实分析的预算基线。
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              记账分录可以直接挂到预测收入项和成本项之下。
            </div>
            <div className="rounded-[22px] border border-stone-900/10 bg-stone-50/90 p-4">
              预实分析会将实际结果与当前期间的预算基线进行对比。
            </div>
          </div>
        </Panel>

        <Panel className="p-6">
          <SectionTitle
            icon={UserRoundPlus}
            eyebrow="访问"
            title={mode === 'login' ? '登录' : '创建账号'}
            description={mode === 'login' ? '使用已有账号登录。' : '系统会自动为你创建默认工作区。'}
          />

          <div className="mt-6 inline-flex rounded-full border border-stone-900/10 bg-stone-100/80 p-1">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={mode === 'login' ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white' : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600'}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={mode === 'register' ? 'rounded-full bg-stone-950 px-4 py-2 text-sm font-semibold text-white' : 'rounded-full px-4 py-2 text-sm font-semibold text-stone-600'}
            >
              注册
            </button>
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
                  className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
            ) : null}

            <label className="grid gap-2" htmlFor="auth-email">
              <span className="text-sm font-semibold text-stone-700">邮箱</span>
              <input
                id="auth-email"
                name="email"
                autoComplete="email"
                className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
              />
            </label>

            <label className="grid gap-2" htmlFor="auth-password">
              <span className="text-sm font-semibold text-stone-700">密码</span>
              <input
                id="auth-password"
                name="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className="h-11 rounded-2xl border border-stone-900/10 bg-stone-50 px-4 text-sm font-medium text-stone-900 outline-none focus:border-emerald-500 focus:bg-white"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
              />
            </label>

            {props.error ? <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{props.error}</p> : null}

            <button
              type="submit"
              disabled={props.loading}
              className="rounded-2xl bg-stone-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {props.loading ? '提交中...' : mode === 'login' ? '登录' : '注册'}
            </button>
          </form>
        </Panel>
      </div>
    </div>
  )
}
