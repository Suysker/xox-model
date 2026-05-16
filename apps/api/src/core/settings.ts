import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Settings = {
  databaseUrl: string
  sessionCookieName: string
  sessionTtlDays: number
  corsOrigin: string
  llmProvider: string
  deepseekBaseUrl: string
  deepseekModel: string
  deepseekApiKey: string | null
}

function defaultDatabaseUrl() {
  const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  return `sqlite:///${resolve(apiRoot, '..', 'data', 'xox.db').replaceAll('\\', '/')}`
}

export function getSettings(): Settings {
  return {
    databaseUrl: process.env.XOX_DATABASE_URL ?? defaultDatabaseUrl(),
    sessionCookieName: process.env.XOX_SESSION_COOKIE_NAME ?? 'xox_session',
    sessionTtlDays: Number(process.env.XOX_SESSION_TTL_DAYS ?? 14),
    corsOrigin: process.env.XOX_CORS_ORIGIN ?? 'http://127.0.0.1:5173',
    llmProvider: process.env.LLM_PROVIDER ?? 'deepseek',
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? null,
  }
}

export function sqlitePathFromUrl(databaseUrl: string) {
  if (!databaseUrl.startsWith('sqlite:///')) {
    throw new Error(`Only sqlite:/// URLs are supported by the local API runtime: ${databaseUrl}`)
  }

  return databaseUrl.slice('sqlite:///'.length)
}
