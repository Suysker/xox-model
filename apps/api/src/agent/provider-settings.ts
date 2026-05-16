import type { Kysely } from 'kysely'
import type { AgentProviderSettingRecord } from '@xox/contracts'
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
