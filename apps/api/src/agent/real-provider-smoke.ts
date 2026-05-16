import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { createApp } from '../server.js'
import { createDatabase } from '../db/database.js'
import type { Settings } from '../core/settings.js'

type JsonResponse = {
  statusCode: number
  json: any
}

type SmokeSummary = {
  ok: true
  provider: string
  model: string
  plannerSources: string[]
  coveredDirections: string[]
  memoryCount: number
  newThreadMemoryInjected: true
  maxMultiStepCount: number
  editableActionExecutedAmount: number
  editedDraftRevision: number
  actionKinds: string[]
  publishCreatedShare: true
  auditCount: number
}

class SmokeClient {
  private cookie = ''

  constructor(private readonly app: FastifyInstance) {}

  async request(method: string, url: string, payload?: unknown): Promise<JsonResponse> {
    const requestOptions: {
      method: string
      url: string
      payload?: unknown
      headers?: Record<string, string>
    } = { method, url }
    if (payload !== undefined) requestOptions.payload = payload
    if (this.cookie) requestOptions.headers = { cookie: this.cookie }

    const response = await (this.app.inject as any)(requestOptions)
    const setCookie = response.headers['set-cookie']
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie
    if (rawCookie) this.cookie = rawCookie.split(';')[0] ?? this.cookie

    return {
      statusCode: response.statusCode,
      json: response.body ? JSON.parse(response.body) : null,
    }
  }

  get(url: string) {
    return this.request('GET', url)
  }

  post(url: string, payload?: unknown) {
    return this.request('POST', url, payload)
  }

  patch(url: string, payload?: unknown) {
    return this.request('PATCH', url, payload)
  }

  put(url: string, payload?: unknown) {
    return this.request('PUT', url, payload)
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

function parseDotenvValue(raw: string) {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback)
  return Number.isFinite(parsed) ? parsed : fallback
}

function loadDotenvFile(path: string) {
  if (!existsSync(path)) return
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key, value] = match
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = parseDotenvValue(value ?? '')
  }
}

function loadLocalEnvFiles() {
  const agentDir = dirname(fileURLToPath(import.meta.url))
  const apiRoot = resolve(agentDir, '../..')
  const repoRoot = resolve(apiRoot, '../..')
  loadDotenvFile(resolve(repoRoot, '.env'))
  loadDotenvFile(resolve(apiRoot, '.env'))
}

function redactedResponse(response: JsonResponse) {
  return JSON.stringify({
    statusCode: response.statusCode,
    json: response.json,
  })
}

function editableLedgerPayload(payload: any) {
  const originalAmount = Number(payload?.amount)
  assertSmoke(Number.isFinite(originalAmount) && originalAmount > 0, 'ledger action payload amount is invalid')
  assertSmoke(Array.isArray(payload.allocations) && payload.allocations.length > 0, 'ledger action payload has no allocations')

  return {
    ...payload,
    amount: Math.round(originalAmount * 2 * 100) / 100,
    description: 'Agent smoke edited before execution',
    allocations: payload.allocations.map((allocation: any) => ({
      ...allocation,
      amount: Math.round(Number(allocation.amount) * 2 * 100) / 100,
    })),
  }
}

function rememberCoverage(covered: Set<string>, direction: string) {
  covered.add(direction)
}

function assertOk(response: JsonResponse, label: string) {
  assertSmoke(response.statusCode === 200, `${label} failed: ${redactedResponse(response)}`)
}

function assertPlannerSource(value: unknown, label: string, planners: Set<string>) {
  assertSmoke(value === 'openai_compatible_tool_calls', `${label} did not use real tool calls: ${String(value)}`)
  planners.add(value)
}

function assertPlanner(response: JsonResponse, label: string, planners: Set<string>) {
  assertPlannerSource(response.json.planner, label, planners)
}

function findAction(response: JsonResponse, kind: string, label: string) {
  const action = response.json.actionRequests.find((item: any) => item.kind === kind)
  assertSmoke(action, `${label} missing ${kind} action: ${JSON.stringify(response.json.actionRequests)}`)
  return action
}

function versionNoFromResult(result: any) {
  const version = result?.version ?? result
  const versionNo = Number(version?.versionNo ?? version?.version_no)
  assertSmoke(Number.isFinite(versionNo) && versionNo > 0, `version number missing from result: ${JSON.stringify(result)}`)
  return versionNo
}

async function sendAgentMessage(
  client: SmokeClient,
  planners: Set<string>,
  input: { label: string; message: string; threadId?: string | null },
) {
  const response = await client.post('/api/v1/agent/messages', {
    threadId: input.threadId ?? null,
    message: input.message,
  })
  assertOk(response, input.label)
  assertPlanner(response, input.label, planners)
  return response
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForThreadRun(client: SmokeClient, threadId: string, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await client.get(`/api/v1/agent/threads/${encodeURIComponent(threadId)}`)
    assertOk(state, label)
    const latestRun = state.json.runs?.[0]
    if (latestRun?.status !== 'running') return state
    await sleep(1000)
  }
  fail(`${label} did not finish within timeout`)
}

async function confirmAction(client: SmokeClient, action: any, label: string, actionKinds: Set<string>) {
  const response = await client.post(`/api/v1/agent/action-requests/${action.id}/confirm`)
  assertOk(response, label)
  assertSmoke(response.json.actionRequest.status === 'executed', `${label} action was not executed`)
  actionKinds.add(action.kind)
  return response
}

export async function runRealProviderSmoke(): Promise<SmokeSummary> {
  loadLocalEnvFiles()
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    fail('OPENAI_COMPATIBLE_API_KEY or DEEPSEEK_API_KEY is required for npm run smoke:agent. Put it in local .env or export it in the shell; this command never falls back to rules.')
  }

  const provider = process.env.OPENAI_COMPATIBLE_PROVIDER ?? 'deepseek'
  const compatibleBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
  const compatibleModel = process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro'
  const dir = mkdtempSync(join(tmpdir(), 'xox-agent-real-provider-'))
  const settings: Settings = {
    databaseUrl: `sqlite:///${join(dir, 'smoke.db').replaceAll('\\', '/')}`,
    sessionCookieName: 'xox_session',
    sessionTtlDays: 14,
    corsOrigin: 'http://127.0.0.1:5173',
    llmProvider: process.env.LLM_PROVIDER ?? 'rules',
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-5.4-mini',
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    openaiCompatibleProvider: provider,
    openaiCompatibleBaseUrl: compatibleBaseUrl,
    openaiCompatibleModel: compatibleModel,
    openaiCompatibleApiKey: null,
    agentProviderKeyEncryptionSecret: process.env.AGENT_PROVIDER_KEY_ENCRYPTION_SECRET ?? `smoke-provider-secret-${process.pid}`,
    agentWorkerId: process.env.AGENT_WORKER_ID ?? `smoke-${process.pid}`,
    agentRunLeaseTtlMs: Math.max(1000, numberEnv(process.env.AGENT_RUN_LEASE_TTL_MS, 45_000)),
    agentRunWorkerPollMs: Math.max(250, numberEnv(process.env.AGENT_RUN_WORKER_POLL_MS, 2_000)),
  }

  const db = createDatabase(settings)
  const app = await createApp({ settings, db })
  const client = new SmokeClient(app)
  const coveredDirections = new Set<string>()
  const plannerSources = new Set<string>()
  const actionKinds = new Set<string>()
  let maxMultiStepCount = 0
  let editableActionExecutedAmount = 0
  let editedDraftRevision = 0

  try {
    const email = `agent-smoke-${Date.now()}@example.com`
    const registered = await client.post('/api/v1/auth/register', {
      email,
      password: 'password123',
      displayName: 'Agent Smoke',
    })
    assertSmoke(registered.statusCode === 200, `register failed: ${redactedResponse(registered)}`)

    const providerSetting = await client.put('/api/v1/agent/provider-settings', {
      provider,
      baseUrl: compatibleBaseUrl,
      model: compatibleModel,
      apiKey,
    })
    assertSmoke(providerSetting.statusCode === 200, `provider setting failed: ${redactedResponse(providerSetting)}`)
    assertSmoke(providerSetting.json.setting?.provider === provider, `provider setting did not persist provider: ${redactedResponse(providerSetting)}`)
    assertSmoke(providerSetting.json.setting?.hasApiKey === true, 'provider setting did not mark key as present')
    assertSmoke(!JSON.stringify(providerSetting.json).includes(apiKey), 'provider setting response leaked API key')
    const fetchedProviderSetting = await client.get('/api/v1/agent/provider-settings')
    assertSmoke(fetchedProviderSetting.statusCode === 200, `provider setting fetch failed: ${redactedResponse(fetchedProviderSetting)}`)
    assertSmoke(fetchedProviderSetting.json.setting?.model === compatibleModel, 'provider setting fetch returned the wrong model')
    assertSmoke(!JSON.stringify(fetchedProviderSetting.json).includes(apiKey), 'provider setting fetch leaked API key')
    rememberCoverage(coveredDirections, 'tenant_provider_settings')

    const forecast = await sendAgentMessage(client, plannerSources, {
      label: 'forecast',
      message: '如果 4 月线上系数变成 0.3，利润会怎样',
    })
    assertSmoke(Array.isArray(forecast.json.actionRequests) && forecast.json.actionRequests.length === 0, 'read-only forecast created a write confirmation')
    assertSmoke(
      Array.isArray(forecast.json.navigationEvents) && forecast.json.navigationEvents.some((event: any) => event.route?.mainTab === 'inputs'),
      'forecast did not navigate to model page',
    )
    rememberCoverage(coveredDirections, 'read_only_forecast')

    const dataQuestionStarted = await client.post('/api/v1/agent/messages', {
      threadId: forecast.json.threadId,
      message: '3 月计划收入和计划成本分别是多少？只回答当前工作区数据，不要修改任何内容',
      background: true,
    })
    assertOk(dataQuestionStarted, 'data agent background start')
    assertSmoke(dataQuestionStarted.json.status === 'running', `background data question did not start running: ${redactedResponse(dataQuestionStarted)}`)
    assertSmoke(dataQuestionStarted.json.planner === null, 'background start should not claim a planner before the model finishes')
    const dataQuestion = await waitForThreadRun(client, dataQuestionStarted.json.threadId, 'data agent background completion')
    assertSmoke(dataQuestion.json.runs[0].status === 'completed', `background data question failed: ${redactedResponse(dataQuestion)}`)
    assertPlannerSource(dataQuestion.json.runs[0].planner, 'data agent background completion', plannerSources)
    assertSmoke(Array.isArray(dataQuestion.json.actionRequests) && dataQuestion.json.actionRequests.length === 0, 'data question created a write confirmation')
    assertSmoke(
      Array.isArray(dataQuestion.json.runEvents) &&
        dataQuestion.json.runEvents.some((event: any) => event.type === 'model_planning') &&
        dataQuestion.json.runEvents.some((event: any) => event.type === 'run_completed'),
      `background data question did not persist run trace: ${redactedResponse(dataQuestion)}`,
    )
    assertSmoke(
      String(dataQuestion.json.messages.at(-1)?.content ?? '').includes('3月计划收入') &&
        String(dataQuestion.json.messages.at(-1)?.content ?? '').includes('计划成本'),
      `data question did not answer with period metrics: ${String(dataQuestion.json.messages.at(-1)?.content ?? '')}`,
    )
    rememberCoverage(coveredDirections, 'data_agent_period_question')
    rememberCoverage(coveredDirections, 'background_run_recovery')
    rememberCoverage(coveredDirections, 'agent_run_trace')

    const clarification = await sendAgentMessage(client, plannerSources, {
      label: 'clarification for missing ledger fields',
      threadId: forecast.json.threadId,
      message: '我想记一笔收入，但我还没告诉你月份、成员、线下张数和线上张数，请先问我需要补充什么',
    })
    assertSmoke(Array.isArray(clarification.json.actionRequests) && clarification.json.actionRequests.length === 0, 'clarification unexpectedly created a write confirmation')
    assertSmoke(
      String(clarification.json.messages.at(-1)?.content ?? '').includes('补充') ||
        String(clarification.json.messages.at(-1)?.content ?? '').includes('请'),
      `clarification did not ask the user for missing details: ${String(clarification.json.messages.at(-1)?.content ?? '')}`,
    )
    assertSmoke(
      clarification.json.planSteps.some((step: any) => String(step.title).includes('补充') || String(step.description).includes('月份')),
      `clarification step missing: ${JSON.stringify(clarification.json.planSteps)}`,
    )
    rememberCoverage(coveredDirections, 'clarification_request')

    const memoryWrite = await client.post('/api/v1/agent/messages', {
      threadId: forecast.json.threadId,
      message: '记住：默认记账成员是 成员 A',
    })
    assertSmoke(memoryWrite.statusCode === 200, `memory write failed: ${redactedResponse(memoryWrite)}`)
    plannerSources.add(memoryWrite.json.planner)
    const memories = await client.get('/api/v1/agent/memories')
    assertSmoke(memories.statusCode === 200, `memory list failed: ${redactedResponse(memories)}`)
    assertSmoke(
      memories.json.memories.some((memory: any) => String(memory.value).includes('默认记账成员是 成员 A')),
      'tenant memory was not stored',
    )
    rememberCoverage(coveredDirections, 'memory_write')

    const multi = await sendAgentMessage(client, plannerSources, {
      label: 'multi-step ledger and account refusal',
      threadId: null,
      message: '把 3 月默认记账成员线下 1 张、线上 0 张入账；同时帮我注销账号',
    })
    assertSmoke(multi.json.threadId !== forecast.json.threadId, 'new conversation did not create a new thread')
    assertSmoke(Array.isArray(multi.json.planSteps) && multi.json.planSteps.length >= 2, `multi-step did not expose multiple steps: ${multi.json.planSteps?.length}`)
    maxMultiStepCount = Math.max(maxMultiStepCount, multi.json.planSteps.length)

    const ledgerAction = findAction(multi, 'ledger.create_entry', 'multi-step ledger')
    assertSmoke(String(ledgerAction.targetLabel).includes('成员 A'), `memory was not injected into new-thread ledger action: ${ledgerAction.targetLabel}`)
    assertSmoke(
      multi.json.planSteps.some((step: any) => String(step.title).includes('账号') || String(step.description).includes('账号')),
      'account-forbidden step missing',
    )
    rememberCoverage(coveredDirections, 'new_thread_memory_injection')
    rememberCoverage(coveredDirections, 'multi_step_planning')
    rememberCoverage(coveredDirections, 'account_action_forbidden')
    rememberCoverage(coveredDirections, 'ledger_confirmation_card')

    const editedPayload = editableLedgerPayload(ledgerAction.payload)
    const editedLedger = await client.patch(`/api/v1/agent/action-requests/${ledgerAction.id}`, {
      summary: `${ledgerAction.summary}（smoke 已编辑确认卡载荷）`,
      payload: editedPayload,
    })
    assertSmoke(editedLedger.statusCode === 200, `edit ledger action failed: ${redactedResponse(editedLedger)}`)
    assertSmoke(Number(editedLedger.json.actionRequest.payload.amount) === Number(editedPayload.amount), 'edited action payload was not persisted')
    rememberCoverage(coveredDirections, 'editable_confirmation_payload')

    const confirmedLedger = await confirmAction(client, ledgerAction, 'confirm ledger', actionKinds)
    assertSmoke(Number(confirmedLedger.json.result.amount) === Number(editedPayload.amount), 'confirmed ledger did not use edited payload')
    editableActionExecutedAmount = Number(confirmedLedger.json.result.amount)

    const voidEntry = await sendAgentMessage(client, plannerSources, {
      label: 'void ledger entry',
      threadId: multi.json.threadId,
      message: '作废 3 月成员 A 这笔入账',
    })
    const voidAction = findAction(voidEntry, 'ledger.void_entry', 'void ledger entry')
    await confirmAction(client, voidAction, 'confirm void ledger entry', actionKinds)
    rememberCoverage(coveredDirections, 'ledger_void_entry')

    const onlineFactorWrite = await sendAgentMessage(client, plannerSources, {
      label: 'write online factor',
      threadId: multi.json.threadId,
      message: '把 4 月线上系数改成 0.3 并保存',
    })
    const onlineFactorAction = findAction(onlineFactorWrite, 'workspace.update_draft', 'write online factor')
    const confirmedOnlineFactor = await confirmAction(client, onlineFactorAction, 'confirm online factor write', actionKinds)
    editedDraftRevision = Number(confirmedOnlineFactor.json.result.revision)
    assertSmoke(Number.isFinite(editedDraftRevision) && editedDraftRevision > 0, 'online factor write did not return a draft revision')
    rememberCoverage(coveredDirections, 'draft_specialized_write')

    const genericPatch = await sendAgentMessage(client, plannerSources, {
      label: 'generic draft patch',
      threadId: multi.json.threadId,
      message: '把项目规划月份改成 13 并保存',
    })
    const patchAction = findAction(genericPatch, 'workspace.update_draft', 'generic draft patch')
    const confirmedPatch = await confirmAction(client, patchAction, 'confirm generic draft patch', actionKinds)
    assertSmoke(Number(confirmedPatch.json.result.revision) > editedDraftRevision, 'generic patch did not advance draft revision')
    editedDraftRevision = Number(confirmedPatch.json.result.revision)
    rememberCoverage(coveredDirections, 'draft_generic_patch')

    const bundleExport = await sendAgentMessage(client, plannerSources, {
      label: 'export workspace bundle',
      threadId: multi.json.threadId,
      message: '导出当前工作区 JSON bundle',
    })
    assertSmoke(bundleExport.json.actionRequests.length === 0, 'bundle export unexpectedly created a write confirmation')
    assertSmoke(bundleExport.json.navigationEvents.some((event: any) => event.panel === 'workspace'), 'bundle export did not open workspace panel')
    rememberCoverage(coveredDirections, 'workspace_export_bundle')

    const sourceBundle = await client.get('/api/v1/workspace/bundle')
    assertOk(sourceBundle, 'read exported workspace bundle')
    const importBundle = {
      schemaVersion: sourceBundle.json.schemaVersion,
      workspaceName: 'Agent 导入工作区',
      currentConfig: {
        ...sourceBundle.json.currentConfig,
        operating: {
          ...sourceBundle.json.currentConfig.operating,
          offlineUnitPrice: 333,
        },
      },
      snapshots: [],
      lastSavedAt: null,
    }
    const bundleImport = await sendAgentMessage(client, plannerSources, {
      label: 'import workspace bundle',
      threadId: multi.json.threadId,
      message: `导入这个工作区 bundle 并覆盖当前草稿：${JSON.stringify(importBundle)}`,
    })
    const importAction = findAction(bundleImport, 'workspace.import_bundle', 'import workspace bundle')
    const confirmedImport = await confirmAction(client, importAction, 'confirm workspace bundle import', actionKinds)
    assertSmoke(confirmedImport.json.result.workspaceName === 'Agent 导入工作区', 'bundle import did not update workspace name')
    assertSmoke(Number(confirmedImport.json.result.config.operating.offlineUnitPrice) === 333, 'bundle import did not apply currentConfig')
    rememberCoverage(coveredDirections, 'workspace_import_bundle')

    const lockPeriod = await sendAgentMessage(client, plannerSources, {
      label: 'lock period',
      threadId: multi.json.threadId,
      message: '锁定 3 月账期',
    })
    const lockAction = findAction(lockPeriod, 'ledger.lock_period', 'lock period')
    await confirmAction(client, lockAction, 'confirm lock period', actionKinds)
    rememberCoverage(coveredDirections, 'ledger_lock_period')

    const unlockPeriod = await sendAgentMessage(client, plannerSources, {
      label: 'unlock period',
      threadId: multi.json.threadId,
      message: '解锁 3 月账期',
    })
    const unlockAction = findAction(unlockPeriod, 'ledger.unlock_period', 'unlock period')
    await confirmAction(client, unlockAction, 'confirm unlock period', actionKinds)
    rememberCoverage(coveredDirections, 'ledger_unlock_period')

    const snapshot = await sendAgentMessage(client, plannerSources, {
      label: 'save snapshot',
      threadId: multi.json.threadId,
      message: '保存当前草稿快照',
    })
    const snapshotAction = findAction(snapshot, 'workspace.save_snapshot', 'save snapshot')
    const confirmedSnapshot = await confirmAction(client, snapshotAction, 'confirm save snapshot', actionKinds)
    const snapshotVersionNo = versionNoFromResult(confirmedSnapshot.json.result)
    rememberCoverage(coveredDirections, 'workspace_save_snapshot')

    const publish = await sendAgentMessage(client, plannerSources, {
      label: 'publish and share',
      threadId: multi.json.threadId,
      message: '发布当前版本并创建分享链接',
    })
    const publishAction = findAction(publish, 'workspace.publish_release', 'publish and share')
    assertSmoke(publishAction.navigation?.panel === 'workspace', 'publish action did not open workspace/version panel')

    const confirmedPublish = await confirmAction(client, publishAction, 'confirm publish and share', actionKinds)
    assertSmoke(confirmedPublish.json.result.version?.kind === 'release', 'confirmed publish did not create a release')
    assertSmoke(
      Boolean(confirmedPublish.json.result.share?.share_token || confirmedPublish.json.result.share?.shareToken),
      'confirmed publish did not create a share link',
    )
    const releaseVersionNo = versionNoFromResult(confirmedPublish.json.result)
    rememberCoverage(coveredDirections, 'workspace_publish_release')
    rememberCoverage(coveredDirections, 'share_create')

    const revokeShare = await sendAgentMessage(client, plannerSources, {
      label: 'revoke share',
      threadId: multi.json.threadId,
      message: `撤销发布版 ${releaseVersionNo} 的分享链接`,
    })
    const revokeAction = findAction(revokeShare, 'share.revoke', 'revoke share')
    await confirmAction(client, revokeAction, 'confirm revoke share', actionKinds)
    rememberCoverage(coveredDirections, 'share_revoke')

    const rollback = await sendAgentMessage(client, plannerSources, {
      label: 'rollback version',
      threadId: multi.json.threadId,
      message: `恢复到版本 ${snapshotVersionNo}`,
    })
    const rollbackAction = findAction(rollback, 'workspace.rollback_version', 'rollback version')
    await confirmAction(client, rollbackAction, 'confirm rollback version', actionKinds)
    rememberCoverage(coveredDirections, 'workspace_rollback_version')

    const deleteSnapshot = await sendAgentMessage(client, plannerSources, {
      label: 'delete snapshot',
      threadId: multi.json.threadId,
      message: `删除版本 ${snapshotVersionNo}`,
    })
    const deleteAction = findAction(deleteSnapshot, 'workspace.delete_version', 'delete snapshot')
    await confirmAction(client, deleteAction, 'confirm delete snapshot', actionKinds)
    rememberCoverage(coveredDirections, 'workspace_delete_version')

    const resetDraft = await sendAgentMessage(client, plannerSources, {
      label: 'reset draft',
      threadId: multi.json.threadId,
      message: '重置当前草稿为默认模型',
    })
    const resetAction = findAction(resetDraft, 'workspace.reset_draft', 'reset draft')
    await confirmAction(client, resetAction, 'confirm reset draft', actionKinds)
    rememberCoverage(coveredDirections, 'workspace_reset_draft')

    const auditCount = await db
      .selectFrom('audit_logs')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('action', '=', 'agent.action_executed')
      .executeTakeFirstOrThrow()
    assertSmoke(Number(auditCount.count) >= actionKinds.size, `agent execution audit count too low: ${auditCount.count}`)
    rememberCoverage(coveredDirections, 'agent_execution_audit')
    assertSmoke(coveredDirections.size >= 10, `real-provider coverage is too small: ${Array.from(coveredDirections).join(', ')}`)

    return {
      ok: true,
      provider,
      model: compatibleModel,
      plannerSources: Array.from(plannerSources),
      coveredDirections: Array.from(coveredDirections),
      memoryCount: memories.json.memories.length,
      newThreadMemoryInjected: true,
      maxMultiStepCount,
      editableActionExecutedAmount,
      editedDraftRevision,
      actionKinds: Array.from(actionKinds),
      publishCreatedShare: true,
      auditCount: Number(auditCount.count),
    }
  } finally {
    await app.close()
    await db.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  const summary = await runRealProviderSmoke()
  console.log(JSON.stringify(summary, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
