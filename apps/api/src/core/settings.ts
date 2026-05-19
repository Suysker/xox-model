import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

export type Settings = {
  databaseUrl: string
  sessionCookieName: string
  sessionTtlDays: number
  corsOrigin: string
  llmProvider: string
  openaiBaseUrl: string
  openaiModel: string
  openaiApiKey: string | null
  openaiCompatibleProvider: string
  openaiCompatibleBaseUrl: string
  openaiCompatibleModel: string
  openaiCompatibleApiKey: string | null
  agentProviderKeyEncryptionSecret: string | null
  agentWorkerId: string
  agentRunLeaseTtlMs: number
  agentRunWorkerPollMs: number
  agentProviderRequestTimeoutMs: number
}

const generatedAgentWorkerId = `api-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`

function defaultDatabaseUrl() {
  const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  return `sqlite:///${resolve(apiRoot, '..', 'data', 'xox.db').replaceAll('\\', '/')}`
}

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function getSettings(): Settings {
  const llmProvider = process.env.LLM_PROVIDER ?? process.env.OPENAI_COMPATIBLE_PROVIDER ?? 'deepseek'
  const agentRunLeaseTtlMs = Math.max(1000, numberEnv(process.env.AGENT_RUN_LEASE_TTL_MS, 45_000))
  const agentRunWorkerPollMs = Math.max(250, numberEnv(process.env.AGENT_RUN_WORKER_POLL_MS, 2_000))
  const agentProviderRequestTimeoutMs = Math.max(5_000, numberEnv(process.env.AGENT_PROVIDER_REQUEST_TIMEOUT_MS, 90_000))
  return {
    databaseUrl: process.env.XOX_DATABASE_URL ?? defaultDatabaseUrl(),
    sessionCookieName: process.env.XOX_SESSION_COOKIE_NAME ?? 'xox_session',
    sessionTtlDays: Number(process.env.XOX_SESSION_TTL_DAYS ?? 14),
    corsOrigin: process.env.XOX_CORS_ORIGIN ?? 'http://127.0.0.1:5173',
    llmProvider,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-5.4-mini',
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    openaiCompatibleProvider: process.env.OPENAI_COMPATIBLE_PROVIDER ?? llmProvider,
    openaiCompatibleBaseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    openaiCompatibleModel: process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro',
    openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? null,
    agentProviderKeyEncryptionSecret: process.env.AGENT_PROVIDER_KEY_ENCRYPTION_SECRET ?? null,
    agentWorkerId: process.env.AGENT_WORKER_ID ?? generatedAgentWorkerId,
    agentRunLeaseTtlMs,
    agentRunWorkerPollMs,
    agentProviderRequestTimeoutMs,
  }
}

export function sqlitePathFromUrl(databaseUrl: string) {
  if (!databaseUrl.startsWith('sqlite:///')) {
    throw new Error(`Only sqlite:/// URLs are supported by the local API runtime: ${databaseUrl}`)
  }

  return databaseUrl.slice('sqlite:///'.length)
}
