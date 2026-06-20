import type { Kysely } from 'kysely'
import type { AgentProviderSettingRecord } from '@xox/contracts'
import {
  probeOpenAICompatibleProvider as probeProviderOpenAICompatibleProvider,
  type OpenAiCompatibleFunctionToolDescriptor,
  type OpenAICompatibleProviderProbeCheck,
  type OpenAICompatibleProviderProbeResult,
} from '@agentic-os/runtime-openai-compatible'
import type { Settings } from '../core/settings.js'
import { unprocessable } from '../core/http.js'
import { newId } from '../core/security.js'
import { utcNow } from '../core/time.js'
import type { Database, Row } from '../db/schema.js'
import type { CurrentUser } from '../modules/auth.js'
import { decryptProviderApiKey, encryptProviderApiKey, isEncryptedProviderApiKey } from './provider-key-codec.js'

export type AgentProviderSettingInput = {
  provider: string
  baseUrl: string
  model: string
  apiKey?: string | null | undefined
}

export type AgentProviderProbeInput = {
  provider?: string | undefined
  baseUrl?: string | undefined
  model?: string | undefined
  apiKey?: string | undefined
}

export type ProviderProbeResult = {
  status: 'passed' | 'failed' | 'warning'
  provider: string
  model: string
  checks: Array<{
    name: 'auth' | 'model' | 'chat' | 'tools' | 'stream'
    status: 'passed' | 'failed' | 'warning' | 'skipped'
    message: string
  }>
  message: string
}

type ProviderProbeCheck = ProviderProbeResult['checks'][number]

const PROBE_TOOL: OpenAiCompatibleFunctionToolDescriptor = {
  type: 'function',
  function: {
    name: 'xox_provider_probe',
    description: '用于验证当前 provider 是否支持 OpenAI-compatible tool_calls。必须调用这个工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', description: '固定传 true。' },
      },
    },
  },
}

function normalizeProvider(value: string) {
  const provider = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(provider)) {
    throw unprocessable('Provider name is invalid')
  }
  if (provider === 'rules') {
    throw unprocessable('Rules provider cannot be saved as a user model setting')
  }
  return provider
}

function normalizeBaseUrl(value: string) {
  const baseUrl = value.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw unprocessable('Provider baseUrl must be a valid URL')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw unprocessable('Provider baseUrl must use http or https')
  }
  return baseUrl
}

function normalizeModel(value: string) {
  const model = value.trim()
  if (!model || model.length > 128) {
    throw unprocessable('Provider model is invalid')
  }
  return model
}

function normalizeApiKey(value: string | null | undefined) {
  if (value === undefined || value === null) return null
  const apiKey = value.trim()
  if (!apiKey || apiKey.length > 4096) {
    throw unprocessable('Provider API key is invalid')
  }
  return apiKey
}

function missingKeyProbeResult(provider: string, model: string): ProviderProbeResult {
  return {
    status: 'failed',
    provider,
    model,
    checks: [
      { name: 'auth', status: 'failed', message: '没有可用 API key。' },
      { name: 'model', status: 'skipped', message: '认证失败前不检查模型。' },
      { name: 'chat', status: 'skipped', message: '认证失败前不检查对话。' },
      { name: 'tools', status: 'skipped', message: '认证失败前不检查工具调用。' },
      { name: 'stream', status: 'skipped', message: '认证失败前不检查流式输出。' },
    ],
    message: 'Provider probe failed: missing API key.',
  }
}

function localizeProbeCheck(input: {
  check: OpenAICompatibleProviderProbeCheck
  model: string
  result: OpenAICompatibleProviderProbeResult
}): ProviderProbeCheck {
  const httpFailure = input.result.status === 'failed' && input.result.message.startsWith('HTTP ')
  const transportFailure = input.result.status === 'failed' && !httpFailure

  if (input.check.name === 'auth' && input.check.status === 'passed') {
    return { name: 'auth', status: 'passed', message: 'API key 可用于当前 provider。' }
  }
  if (input.check.name === 'model' && input.check.status === 'passed') {
    return { name: 'model', status: 'passed', message: `模型 ${input.model} 返回了有效响应。` }
  }
  if (input.check.name === 'chat' && input.check.status === 'passed') {
    return { name: 'chat', status: 'passed', message: 'Chat Completions 请求成功。' }
  }
  if (input.check.name === 'tools') {
    if (input.check.status === 'passed') {
      return { name: 'tools', status: 'passed', message: '模型返回了 provider-native tool_calls。' }
    }
    if (input.check.status === 'warning') {
      return { name: 'tools', status: 'warning', message: '模型响应成功，但本次未返回 tool_call。' }
    }
    if (input.check.status === 'skipped') {
      return {
        name: 'tools',
        status: 'skipped',
        message: httpFailure ? '对话请求失败，未检查工具调用。' : '请求失败，未检查工具调用。',
      }
    }
  }
  if (input.check.name === 'stream' && input.check.status === 'skipped') {
    if (input.result.status === 'passed' || input.result.status === 'warning') {
      return {
        name: 'stream',
        status: 'skipped',
        message: '当前 probe 使用非流式低成本请求；真实运行会继续使用服务端流式 trace。',
      }
    }
    return {
      name: 'stream',
      status: 'skipped',
      message: transportFailure ? '请求失败，未检查流式输出。' : '当前 probe 使用非流式低成本请求。',
    }
  }
  return input.check
}

function toXoxProbeResult(result: OpenAICompatibleProviderProbeResult): ProviderProbeResult {
  return {
    status: result.status,
    provider: result.provider,
    model: result.model,
    checks: result.checks.map((check) => localizeProbeCheck({
      check,
      model: result.model,
      result,
    })),
    message: result.message,
  }
}

export function serializeAgentProviderSetting(row: Row<'agent_provider_settings'>): AgentProviderSettingRecord {
  return {
    provider: row.provider,
    baseUrl: row.base_url,
    model: row.model,
    hasApiKey: Boolean(row.api_key),
    updatedAt: row.updated_at,
  }
}

export async function getAgentProviderSetting(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
) {
  return db
    .selectFrom('agent_provider_settings')
    .selectAll()
    .where('workspace_id', '=', workspace.id)
    .where('user_id', '=', user.id)
    .executeTakeFirst()
}

export async function upsertAgentProviderSetting(
  db: Kysely<Database>,
  settings: Settings,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  input: AgentProviderSettingInput,
) {
  const provider = normalizeProvider(input.provider)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const model = normalizeModel(input.model)
  const explicitApiKey = normalizeApiKey(input.apiKey)
  const existing = await getAgentProviderSetting(db, workspace, user)
  const storedApiKey = explicitApiKey
    ? encryptProviderApiKey(settings, explicitApiKey)
    : existing?.api_key && settings.agentProviderKeyEncryptionSecret && !isEncryptedProviderApiKey(existing.api_key)
      ? encryptProviderApiKey(settings, existing.api_key)
      : existing?.api_key
  if (!storedApiKey) {
    throw unprocessable('Provider API key is required')
  }

  const now = utcNow()
  if (existing) {
    await db
      .updateTable('agent_provider_settings')
      .set({
        provider,
        base_url: baseUrl,
        model,
        api_key: storedApiKey,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .execute()
  } else {
    await db
      .insertInto('agent_provider_settings')
      .values({
        id: newId(),
        workspace_id: workspace.id,
        user_id: user.id,
        provider,
        base_url: baseUrl,
        model,
        api_key: storedApiKey,
        created_at: now,
        updated_at: now,
      })
      .execute()
  }

  const row = await getAgentProviderSetting(db, workspace, user)
  if (!row) throw unprocessable('Provider setting could not be saved')
  return row
}

export async function deleteAgentProviderSetting(
  db: Kysely<Database>,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
) {
  await db
    .deleteFrom('agent_provider_settings')
    .where('workspace_id', '=', workspace.id)
    .where('user_id', '=', user.id)
    .execute()
}

export async function resolveAgentRuntimeSettings(
  db: Kysely<Database>,
  baseSettings: Settings,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
): Promise<Settings> {
  const setting = await getAgentProviderSetting(db, workspace, user)
  if (!setting) return baseSettings

  return {
    ...baseSettings,
    llmProvider: setting.provider === 'openai' ? 'openai-compatible' : setting.provider,
    openaiCompatibleProvider: setting.provider,
    openaiCompatibleBaseUrl: setting.base_url,
    openaiCompatibleModel: setting.model,
    openaiCompatibleApiKey: decryptProviderApiKey(baseSettings, setting.api_key),
  }
}

export async function probeAgentProviderSetting(
  db: Kysely<Database>,
  settings: Settings,
  workspace: Row<'workspaces'>,
  user: CurrentUser,
  input: AgentProviderProbeInput,
): Promise<ProviderProbeResult> {
  const existing = await getAgentProviderSetting(db, workspace, user)
  const provider = normalizeProvider(input.provider ?? existing?.provider ?? settings.openaiCompatibleProvider)
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? existing?.base_url ?? settings.openaiCompatibleBaseUrl)
  const model = normalizeModel(input.model ?? existing?.model ?? settings.openaiCompatibleModel)
  const explicitApiKey = normalizeApiKey(input.apiKey)
  const apiKey = explicitApiKey ?? (existing ? decryptProviderApiKey(settings, existing.api_key) : settings.openaiCompatibleApiKey)
  if (!apiKey) return missingKeyProbeResult(provider, model)

  return toXoxProbeResult(await probeProviderOpenAICompatibleProvider({
    provider,
    baseUrl,
    model,
    apiKey,
    probeTool: PROBE_TOOL,
    probeMessage: '请调用 xox_provider_probe，参数 ok=true。不要输出解释文字。',
    timeoutMs: Math.min(settings.agentProviderRequestTimeoutMs, 20_000),
    maxTokens: 80,
  }))
}
