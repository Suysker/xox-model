import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { createApp } from '../src/server.js'
import { createDatabase } from '../src/db/database.js'
import { runMigrations } from '../src/db/migrations.js'
import type { Database } from '../src/db/schema.js'
import type { Settings } from '../src/core/settings.js'
import {
  AGENT_MANUAL_CAPABILITY_COVERAGE,
  AGENT_TOOL_CATALOG,
  AGENT_TOOL_REGISTRY,
  agentWritableConfigPatterns,
  buildAgentWritableConfigCatalog,
} from '../src/agent/tool-catalog.js'
import { buildRuntimeToolCatalogProjection } from '../src/agent/tool-gateway.js'
import { sanitizeAgentGoalFacts } from '../src/agent/runtime-goal-facts.js'
import { resolveActionAuthority } from '../src/agent/tool-policy.js'
import { createProductDefaultModel, projectModel } from '@xox/domain'
import { recoverRunningAgentRuns } from '../src/agent/agentic-os/xox-run-worker-adapter.js'
import {
  decideMemoryCandidate,
  memoryCandidateFromCompletedGoal,
  memoryCandidateFromEvaluatorFinding,
  memoryCandidatesFromExecutedActions,
  rememberAgentMemory,
  retrieveAgentMemories,
} from '../src/agent/memory.js'
import { addRunEvent } from '../src/agent/agentic-os/xox-run-event-store-adapter.js'

type JsonResponse = {
  statusCode: number
  json: any
}

type FakeCapability = 'data' | 'draft' | 'import_export' | 'ledger' | 'memory' | 'navigation' | 'sandbox' | 'share' | 'version'

type FakeProviderOptions = {
  autoSelectCapabilities?: boolean
  turnLane?: 'agent_goal' | 'direct_answer' | ((body: any, request: IncomingMessage) => unknown | Promise<unknown>)
  capabilities?: FakeCapability[]
  requiredActionCapabilities?: FakeCapability[]
  goalFacts?: Record<string, unknown>
  finalAnswerClaims?: Array<Record<string, unknown>> | ((body: any, request: IncomingMessage) => unknown | Promise<unknown>)
  finalizerResponse?: (body: any, request: IncomingMessage) => unknown | Promise<unknown>
  observationContinuationResponse?: false | ((body: any, request: IncomingMessage) => unknown | Promise<unknown>)
}

const DEFAULT_FAKE_CAPABILITIES: FakeCapability[] = ['data', 'draft', 'import_export', 'ledger', 'memory', 'navigation', 'sandbox', 'share', 'version']

function testSettings(databasePath: string): Settings {
  return {
    databaseUrl: `sqlite:///${databasePath.replaceAll('\\', '/')}`,
    sessionCookieName: 'xox_session',
    sessionTtlDays: 14,
    corsOrigin: 'http://127.0.0.1:5173',
    llmProvider: 'rules',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-5.4-mini',
    openaiApiKey: null,
    openaiCompatibleProvider: 'deepseek',
    openaiCompatibleBaseUrl: 'https://api.deepseek.com',
    openaiCompatibleModel: 'deepseek-v4-pro',
    openaiCompatibleApiKey: null,
    agentProviderKeyEncryptionSecret: null,
    agentWorkerId: `test-worker-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    agentRunLeaseTtlMs: 10_000,
    agentRunWorkerPollMs: 10_000,
    agentProviderRequestTimeoutMs: 10_000,
  }
}

function fakeProviderSettings(baseUrl: string): Partial<Settings> {
  return {
    llmProvider: 'openai-compatible',
    openaiCompatibleProvider: 'test-compatible',
    openaiCompatibleBaseUrl: baseUrl,
    openaiCompatibleApiKey: 'test-key',
  }
}

function isCapabilityRouterRequest(body: any) {
  const toolNames = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name)
    : []
  return toolNames.includes('tool_catalog_select_capabilities') ||
    JSON.stringify(body).includes('Tool Context Engine router')
}

function isTurnLaneResolverRequest(body: any) {
  const toolNames = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name)
    : []
  return toolNames.includes('turn_lane_resolve')
}

function isFinalAnswerClaimExtractorRequest(body: any) {
  const toolNames = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name)
    : []
  return toolNames.includes('final_answer_extract_claims')
}

function fakeTurnLaneResolutionResponse(
  lane: 'agent_goal' | 'direct_answer' = 'agent_goal',
  goalFacts: Record<string, unknown> = {},
) {
  return fakeOpenAIChatToolResponse('turn_lane_resolve', {
    lane,
    requiresTools: lane === 'agent_goal',
    reasonCode: lane === 'direct_answer' ? 'ordinary_conversation' : 'requires_workspace_tools',
    confidence: 0.95,
    missingContext: [],
    goalFacts,
    reason: 'test-turn-lane',
  })
}

function fakeCapabilitySelectionResponse(
  capabilities: FakeCapability[] = DEFAULT_FAKE_CAPABILITIES,
  input: { requiredActionCapabilities?: FakeCapability[]; goalFacts?: Record<string, unknown> } = {},
) {
  return fakeOpenAIChatToolResponse('tool_catalog_select_capabilities', {
    capabilities,
    requiredActionCapabilities: input.requiredActionCapabilities ?? [],
    goalFacts: input.goalFacts ?? {},
    reason: 'test-selected-capabilities',
  })
}

function fakeFinalAnswerClaimExtractionResponse(claims: Array<Record<string, unknown>> = []) {
  return fakeOpenAIChatToolResponse('final_answer_extract_claims', { claims })
}

async function buildHarness(name: string, overrides: Partial<Settings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `xox-api-${name}-`))
  const settings = { ...testSettings(join(dir, 'test.db')), ...overrides }
  const db = createDatabase(settings)
  const app = await createApp({ settings, db })
  return { app, db, settings }
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function withFakeOpenAICompatibleProvider(
  handler: (body: any, request: IncomingMessage) => unknown | Promise<unknown>,
  run: (baseUrl: string) => Promise<void>,
  options: FakeProviderOptions = {},
) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const rawBody = await readRequestBody(request)
    if (!rawBody.trim()) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'empty request body' } }))
      return
    }
    const body = JSON.parse(rawBody)
    const bodyText = JSON.stringify(body)
    const hasToolObservations = Array.isArray(body?.messages) &&
      (body.messages.some((message: any) => message?.role === 'tool') ||
        bodyText.includes('上一轮模型自己选择的 tool_calls'))
    const isObservationFinalizerRequest =
      (!Array.isArray(body?.tools) || body.tools.length === 0) &&
      hasToolObservations
    const isObservationContinuationPlanningRequest =
      Array.isArray(body?.tools) &&
      body.tools.length > 0 &&
      hasToolObservations
    const shouldAutoAnswerObservationPlanning =
      isObservationContinuationPlanningRequest &&
      options.observationContinuationResponse !== false &&
      !(options.requiredActionCapabilities && options.requiredActionCapabilities.length > 0)
    const payload = isObservationFinalizerRequest
      ? options.finalizerResponse
        ? await options.finalizerResponse(body, request)
        : fakeObservationFinalizerResponse(body)
      : shouldAutoAnswerObservationPlanning
        ? options.observationContinuationResponse
          ? await options.observationContinuationResponse(body, request)
          : fakeObservationFinalizerResponse(body)
      : isTurnLaneResolverRequest(body)
        ? typeof options.turnLane === 'function'
          ? await options.turnLane(body, request)
          : fakeTurnLaneResolutionResponse(options.turnLane ?? 'agent_goal', {
              ...(options.goalFacts ?? {}),
              ...(options.requiredActionCapabilities ? { requiredActionCapabilities: options.requiredActionCapabilities } : {}),
            })
      : isFinalAnswerClaimExtractorRequest(body)
        ? typeof options.finalAnswerClaims === 'function'
          ? await options.finalAnswerClaims(body, request)
          : fakeFinalAnswerClaimExtractionResponse(options.finalAnswerClaims ?? [])
      : (options.autoSelectCapabilities ?? true) && isCapabilityRouterRequest(body)
        ? fakeCapabilitySelectionResponse(options.capabilities ?? DEFAULT_FAKE_CAPABILITIES, {
            ...(options.requiredActionCapabilities ? { requiredActionCapabilities: options.requiredActionCapabilities } : {}),
            ...(options.goalFacts ? { goalFacts: options.goalFacts } : {}),
          })
        : await handler(body, request)
    if (payload && typeof payload === 'object' && '__statusCode' in payload) {
      const statusPayload = payload as { __statusCode: number; body: unknown }
      response.writeHead(statusPayload.__statusCode, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(statusPayload.body))
      return
    }
    if (payload && typeof payload === 'object' && '__stream' in payload) {
      const streamPayload = payload as { __stream: unknown[]; delayMs?: number }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      for (const item of streamPayload.__stream) {
        response.write(`data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`)
        if (streamPayload.delayMs && streamPayload.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, streamPayload.delayMs))
        }
      }
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

class Client {
  private cookie = ''

  constructor(private readonly app: FastifyInstance) {}

  async request(method: string, url: string, payload?: unknown): Promise<JsonResponse> {
    const response = await (this.app.inject as any)({
      method,
      url,
      payload,
      headers: this.cookie ? { cookie: this.cookie } : undefined,
    })
    const setCookie = response.headers['set-cookie']
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie
    if (rawCookie) {
      this.cookie = rawCookie.split(';')[0] ?? this.cookie
    }
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

  put(url: string, payload?: unknown) {
    return this.request('PUT', url, payload)
  }

  patch(url: string, payload?: unknown) {
    return this.request('PATCH', url, payload)
  }

  delete(url: string) {
    return this.request('DELETE', url)
  }

  cookieHeader() {
    return this.cookie
  }
}

async function registerUser(client: Client, email: string, displayName = 'User') {
  const response = await client.post('/api/v1/auth/register', {
    email,
    password: 'password123',
    displayName,
  })
  expect(response.statusCode).toBe(200)
  return response.json
}

async function loginUser(client: Client, email: string) {
  const response = await client.post('/api/v1/auth/login', {
    email,
    password: 'password123',
  })
  expect(response.statusCode).toBe(200)
  return response.json
}

async function closeHarness(harness: { app: FastifyInstance; db: Kysely<Database> }) {
  await harness.app.close()
}

function fakeToolResponse(name: string, args: Record<string, unknown> = {}) {
  return fakeToolResponses([{ name, args }])
}

type FakeProviderPayload = Record<string, unknown> | unknown[] | string | number | boolean | null

type FakeProviderScriptStep =
  | FakeProviderPayload
  | ((body: any, request: IncomingMessage, index: number) => unknown | Promise<unknown>)

function resolveFakeProviderScriptStep(
  step: FakeProviderScriptStep,
  body: any,
  request: IncomingMessage,
  index: number,
) {
  return typeof step === 'function'
    ? step(body, request, index)
    : step
}

function scriptedProvider(steps: FakeProviderScriptStep[]) {
  let index = 0
  return async (body: any, request: IncomingMessage) => {
    const step = steps[index]
    if (step === undefined) throw new Error(`Unexpected fake provider planning request #${index + 1}`)
    index += 1
    return await resolveFakeProviderScriptStep(step, body, request, index - 1)
  }
}

function mutableScriptedProvider(initialStep: FakeProviderScriptStep) {
  let step = initialStep
  return {
    setStep(nextStep: FakeProviderScriptStep) {
      step = nextStep
    },
    handler: async (body: any, request: IncomingMessage) => {
      return await resolveFakeProviderScriptStep(step, body, request, 0)
    },
  }
}

function expectProviderTools(body: any, expected: string[]) {
  const toolNames = new Set((body.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name))
  for (const name of expected) expect(toolNames.has(name)).toBe(true)
}

function fakeAssistantTextResponse(content: string) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content,
      },
    }],
  }
}

function fakeMoney(value: unknown) {
  const numberValue = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return `¥${Math.round(numberValue).toLocaleString('zh-CN')}`
}

function parseJsonObject(value: string): any | null {
  try {
    const firstBrace = value.indexOf('{')
    const lastBrace = value.lastIndexOf('}')
    if (firstBrace < 0 || lastBrace <= firstBrace) return null
    return JSON.parse(value.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

function fakeObservationTextFromStructuredData(data: any) {
  if (!data || typeof data !== 'object') return ''
  if (data.scope === 'period_summary') {
    return `${data.monthLabel}计划收入 ${fakeMoney(data.plannedRevenue)}，计划成本 ${fakeMoney(data.plannedCost)}。`
  }
  if (data.scope === 'team_summary') {
    const names = Array.isArray(data.names) && data.names.length > 0 ? `，分别是：${data.names.join('、')}` : ''
    return `当前工作区共有 ${data.memberCount} 个成员${names}。`
  }
  if (data.scope === 'entity_summary') {
    const shareholders = Array.isArray(data.shareholders)
      ? data.shareholders.map((shareholder: any) => `${shareholder.index}. ${shareholder.name} ${fakeMoney(shareholder.investmentAmount)}`).join('、')
      : ''
    return `当前工作区有 ${data.memberCount} 个成员、${data.shareholderCount} 个股东。${shareholders ? `股东：${shareholders}。` : ''}`
  }
  if (data.scope === 'workspace_summary') {
    return `基准场景总收入 ${fakeMoney(data.grossSales)}，总成本 ${fakeMoney(data.totalCost)}，总利润 ${fakeMoney(data.totalProfit)}，期末现金 ${fakeMoney(data.netCashAfterInvestment)}，回本周期 ${data.paybackMonthLabel ?? '未回本'}。`
  }
  if (data.observationType === 'sandbox_execution') {
    const summary = typeof data.result?.summary === 'string'
      ? data.result.summary
      : typeof data.extraction?.summary === 'string'
        ? data.extraction.summary
        : typeof data.outputText === 'string'
          ? data.outputText
          : ''
    return summary ? `沙箱结果：${summary}` : ''
  }
  if (data.scope === 'ledger_history') {
    const preview = Array.isArray(data.preview) && data.preview.length > 0 ? `：${data.preview.join('；')}` : ''
    return `已按“${data.filterText}”筛选账本历史，命中 ${data.count} 笔${preview}。`
  }
  if (data.scope === 'variance_detail') {
    const lines = Array.isArray(data.lines) && data.lines.length > 0
      ? ` ${data.lines.map((line: any) => `${line.subjectName ?? line.subjectKey} 差异 ${fakeMoney(line.varianceAmount)}`).join('；')}。`
      : ''
    return `${data.monthLabel}收入差异 ${fakeMoney(data.revenueVarianceAmount)}，成本差异 ${fakeMoney(data.costVarianceAmount)}。${lines}`
  }
  if (typeof data.displayPreview === 'string') return data.displayPreview
  return ''
}

function fakeObservationFinalizerResponse(body: any) {
  const toolMessages = Array.isArray(body?.messages)
    ? body.messages.filter((message: any) => message?.role === 'tool')
    : []
  const previews = toolMessages.map((message: any) => {
    const content = typeof message?.content === 'string' ? message.content : ''
    try {
      const parsed = JSON.parse(content)
      const structuredText = fakeObservationTextFromStructuredData(parsed)
      if (structuredText) return structuredText
      if (typeof parsed?.displayPreview === 'string') return parsed.displayPreview
    } catch {
      // Use the raw tool content below when the observation is not JSON.
    }
    return content
  }).filter((item: string) => item.trim().length > 0)
  if (previews.length === 0 && Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      const content = typeof message?.content === 'string' ? message.content : ''
      const packet = parseJsonObject(content)
      const observations = Array.isArray(packet?.observations) ? packet.observations : []
      for (const observation of observations) {
        const modelContent = typeof observation?.modelContent === 'string' ? observation.modelContent : ''
        const parsedModelContent = parseJsonObject(modelContent)
        const structuredText = fakeObservationTextFromStructuredData(parsedModelContent)
        if (structuredText) previews.push(structuredText)
        else if (typeof observation?.displayPreview === 'string') previews.push(observation.displayPreview)
      }
    }
  }
  return fakeAssistantTextResponse(previews.join('\n') || '已根据工具结果完成回复。')
}

function fakeToolResponses(calls: Array<{ name: string; args?: Record<string, unknown> }>) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call, index) => ({
          id: `call_${index}_${call.name}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        })),
      },
    }],
  }
}

function fakeMalformedToolResponse(name: string, malformedArguments: string) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_malformed_${name}`,
          type: 'function',
          function: {
            name,
            arguments: malformedArguments,
          },
        }],
      },
    }],
  }
}

function flattenTranscriptNodes(nodes: any[]): any[] {
  return nodes.flatMap((node) => [node, ...flattenTranscriptNodes(Array.isArray(node?.children) ? node.children : [])])
}

function fakeOpenAIChatToolResponse(name: string, args: Record<string, unknown> = {}) {
  return {
    id: `chatcmpl_${name}`,
    object: 'chat.completion',
    created: 0,
    model: 'fake-openai',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${name}`,
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify(args),
          },
        }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

async function insertRunningAgentRun(
  db: Kysely<Database>,
  userId: string,
  input: {
    message: string
    partialOutput?: boolean
    suffix: string
    workerId?: string | null
    leaseExpiresAt?: string | null
    heartbeatAt?: string | null
  },
) {
  const workspace = await db.selectFrom('workspaces').selectAll().where('owner_id', '=', userId).executeTakeFirstOrThrow()
  const now = new Date().toISOString()
  const threadId = `thread-${input.suffix}`
  const runId = `run-${input.suffix}`
  const messageId = `message-${input.suffix}`
  await db.insertInto('agent_threads').values({
    id: threadId,
    workspace_id: workspace.id,
    user_id: userId,
    title: 'Agent 对话',
    created_at: now,
    updated_at: now,
  }).execute()
  await db.insertInto('agent_messages').values({
    id: messageId,
    thread_id: threadId,
    role: 'user',
    content: input.message,
    created_at: now,
  }).execute()
  await db.insertInto('agent_runs').values({
    id: runId,
    thread_id: threadId,
    user_id: userId,
    status: 'running',
    input_message_id: messageId,
    input_message: input.message,
    planner_source: null,
    automation_level: 'manual',
    goal_status: 'interpreting',
    worker_id: input.workerId ?? null,
    lease_expires_at: input.leaseExpiresAt ?? null,
    heartbeat_at: input.heartbeatAt ?? null,
    created_at: now,
    completed_at: null,
  }).execute()

  if (input.partialOutput) {
    const actionId = `action-${input.suffix}`
    await db.insertInto('agent_action_requests').values({
      id: actionId,
      thread_id: threadId,
      run_id: runId,
      workspace_id: workspace.id,
      user_id: userId,
      kind: 'workspace.update_draft',
      status: 'pending',
      title: '半成品确认卡',
      summary: '这个动作应该在恢复时被取消。',
      target_label: workspace.name,
      risk_level: 'medium',
      details_json: JSON.stringify([]),
      navigation_json: JSON.stringify({
        type: 'navigation',
        route: { mainTab: 'inputs', secondaryTab: 'revenue' },
        reason: '半成品导航。',
      }),
      payload_json: JSON.stringify({ revision: 1, workspaceName: workspace.name, config: createProductDefaultModel() }),
      created_at: now,
      executed_at: null,
      error_message: null,
    }).execute()
    await db.insertInto('agent_plan_steps').values({
      id: `step-${input.suffix}`,
      thread_id: threadId,
      run_id: runId,
      action_request_id: actionId,
      sequence_no: 1,
      title: '半成品步骤',
      description: '这个步骤应该在恢复时失败。',
      status: 'ready',
      navigation_json: null,
      created_at: now,
      updated_at: now,
    }).execute()
  }

  return { workspace, threadId, runId, messageId }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseSseEvents(buffer: string) {
  const chunks = buffer.split(/\r?\n\r?\n/)
  const completeChunks = /\r?\n\r?\n$/.test(buffer) ? chunks : chunks.slice(0, -1)
  return completeChunks
    .filter((chunk) => chunk.includes('data: '))
    .map((chunk) => {
      const event = chunk.match(/^event: (.+)$/m)?.[1] ?? 'message'
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n')
      return { event, data: JSON.parse(data) }
    })
}

async function collectSseEvents(
  url: string,
  cookie: string,
  count: number,
  onFirstEvent?: () => Promise<void>,
) {
  const controller = new AbortController()
  const response = await fetch(url, {
    headers: { cookie },
    signal: controller.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE response body is not readable')
  const decoder = new TextDecoder()
  let buffer = ''
  let triggered = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = parseSseEvents(buffer)
      if (!triggered && events.length >= 1 && onFirstEvent) {
        triggered = true
        await onFirstEvent()
      }
      if (events.length >= count) return events.slice(0, count)
    }
  } finally {
    controller.abort()
    reader.releaseLock()
  }
  return parseSseEvents(buffer)
}

async function listenOnFetchSafePort(app: FastifyInstance) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 41_000 + Math.floor(Math.random() * 10_000)
    try {
      await app.listen({ port, host: '127.0.0.1' })
      return `http://127.0.0.1:${port}`
    } catch {
      // Retry another high port; low random ports may hit Fetch's blocked-port list.
    }
  }
  await app.listen({ port: 45_321, host: '127.0.0.1' })
  return 'http://127.0.0.1:45321'
}

describe('xox TypeScript API', () => {
  it('runs migrations repeatedly and serves health', async () => {
    const harness = await buildHarness('migrations')
    const client = new Client(harness.app)
    const health = await client.get('/api/v1/health')
    expect(health.statusCode).toBe(200)
    expect(health.json.status).toBe('ok')
    await closeHarness(harness)
  })

  it('handles auth session lifecycle and audit', async () => {
    const harness = await buildHarness('auth')
    const client = new Client(harness.app)

    await registerUser(client, 'owner@example.com', 'Owner')
    expect((await client.get('/api/v1/auth/me')).json.email).toBe('owner@example.com')
    expect((await client.post('/api/v1/auth/logout')).statusCode).toBe(200)
    expect((await client.get('/api/v1/auth/me')).statusCode).toBe(401)
    await loginUser(client, 'owner@example.com')
    expect((await client.delete('/api/v1/auth/me')).statusCode).toBe(200)
    expect((await client.post('/api/v1/auth/login', { email: 'owner@example.com', password: 'password123' })).statusCode).toBe(401)

    const actions = await harness.db.selectFrom('audit_logs').select('action').execute()
    expect(actions.map((item) => item.action)).toEqual(expect.arrayContaining(['auth.register', 'auth.login', 'auth.logout', 'auth.cancel_account', 'auth.session_refreshed']))
    await closeHarness(harness)
  })

  it('keeps session restore idempotent when concurrent auth checks use the same cookie', async () => {
    const harness = await buildHarness('auth-concurrent-me')
    const register = await (harness.app.inject as any)({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'auth-concurrent@example.com',
        password: 'password123',
        displayName: 'Concurrent',
      },
    })
    expect(register.statusCode).toBe(200)
    const rawCookie = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'][0] : register.headers['set-cookie']
    const cookie = rawCookie.split(';')[0]

    const [first, second] = await Promise.all([
      (harness.app.inject as any)({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } }),
      (harness.app.inject as any)({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } }),
    ])
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(first.body).email).toBe('auth-concurrent@example.com')
    expect(JSON.parse(second.body).email).toBe('auth-concurrent@example.com')
    await closeHarness(harness)
  })

  it('serializes concurrent agent run events for one run', async () => {
    const harness = await buildHarness('run-event-concurrency')
    const client = new Client(harness.app)
    await registerUser(client, 'run-event-concurrency@example.com', 'Run Event')
    const me = (await client.get('/api/v1/auth/me')).json
    const workspace = await harness.db
      .selectFrom('workspaces')
      .selectAll()
      .where('owner_id', '=', me.id)
      .executeTakeFirstOrThrow()
    const now = new Date().toISOString()
    const threadId = 'thread-run-event-concurrency'
    const runId = 'run-run-event-concurrency'
    const messageId = 'message-run-event-concurrency'

    await harness.db.insertInto('agent_threads').values({
      id: threadId,
      workspace_id: workspace.id,
      user_id: me.id,
      title: 'Agent 对话',
      created_at: now,
      updated_at: now,
    }).execute()
    await harness.db.insertInto('agent_messages').values({
      id: messageId,
      thread_id: threadId,
      role: 'user',
      content: '并发事件测试',
      created_at: now,
    }).execute()
    await harness.db.insertInto('agent_runs').values({
      id: runId,
      thread_id: threadId,
      user_id: me.id,
      status: 'running',
      input_message_id: messageId,
      input_message: '并发事件测试',
      planner_source: null,
      automation_level: 'manual',
      goal_status: 'interpreting',
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
      created_at: now,
      completed_at: null,
    }).execute()

    await Promise.all(Array.from({ length: 24 }, (_, index) => addRunEvent(harness.db, {
      threadId,
      runId,
      type: `concurrent_${index}`,
      title: `并发事件 ${index}`,
      message: `event ${index}`,
      status: 'info',
    })))

    const events = await harness.db
      .selectFrom('agent_run_events')
      .select(['sequence_no', 'event_type'])
      .where('run_id', '=', runId)
      .orderBy('sequence_no', 'asc')
      .execute()
    expect(events).toHaveLength(24)
    expect(events.map((event) => event.sequence_no)).toEqual(Array.from({ length: 24 }, (_, index) => index + 1))
    expect(new Set(events.map((event) => event.event_type)).size).toBe(24)
    await closeHarness(harness)
  })

  it('autosaves drafts, rejects stale revisions, and publishes fact tables', async () => {
    const harness = await buildHarness('draft')
    const client = new Client(harness.app)
    await registerUser(client, 'planner@example.com', 'Planner')

    const draft = (await client.get('/api/v1/workspace/draft')).json
    draft.config.operating.offlineUnitPrice = 99
    const save = await client.patch('/api/v1/workspace/draft', {
      revision: draft.revision,
      workspaceName: 'Updated Workspace',
      config: draft.config,
    })
    expect(save.statusCode).toBe(200)
    expect(save.json.revision).toBe(draft.revision + 1)

    const stale = await client.patch('/api/v1/workspace/draft', {
      revision: draft.revision,
      workspaceName: 'Stale',
      config: draft.config,
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json.detail).toBe('Draft revision conflict')

    const snapshot = await client.post('/api/v1/workspace/versions', { kind: 'snapshot', name: 'Draft Snapshot' })
    const release = await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V1' })
    expect(snapshot.json.versionNo).toBe(1)
    expect(release.json.versionNo).toBe(2)
    expect((await client.get('/api/v1/workspace/versions')).json.map((item: any) => item.versionNo)).toEqual([2, 1])

    const monthFacts = await harness.db.selectFrom('forecast_month_facts').select(({ fn }) => fn.countAll<number>().as('count')).where('version_id', '=', release.json.id).executeTakeFirstOrThrow()
    const lineFacts = await harness.db.selectFrom('forecast_line_item_facts').select(({ fn }) => fn.countAll<number>().as('count')).where('version_id', '=', release.json.id).executeTakeFirstOrThrow()
    expect(Number(monthFacts.count)).toBeGreaterThan(0)
    expect(Number(lineFacts.count)).toBeGreaterThan(0)
    await closeHarness(harness)
  })

  it('serves ledger from the current draft and reconciles variance', async () => {
    const harness = await buildHarness('ledger')
    const client = new Client(harness.app)
    await registerUser(client, 'finance@example.com', 'Finance')

    const periods = (await client.get('/api/v1/ledger/periods')).json
    expect(periods[0].plannedRevenue).toBeGreaterThan(0)
    const period = periods[0]
    const subjects = (await client.get(`/api/v1/ledger/periods/${period.id}/subjects`)).json
    const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))
    expect(subjectMap['revenue.offline_sales']).toBeTruthy()
    expect(subjectMap['cost.training.rehearsal']).toBeTruthy()
    expect(subjectMap['cost.other.refund'].subjectType).toBe('revenue')

    expect(
      (await client.post('/api/v1/ledger/entries', {
        ledgerPeriodId: period.id,
        direction: 'expense',
        amount: 120,
        allocations: [{ ...subjectMap['cost.training.rehearsal'], amount: 120 }],
      })).statusCode,
    ).toBe(200)
    expect(
      (await client.post('/api/v1/ledger/entries', {
        ledgerPeriodId: period.id,
        direction: 'income',
        amount: 50,
        allocations: [{ ...subjectMap['cost.other.refund'], amount: 50 }],
      })).statusCode,
    ).toBe(200)

    const variance = (await client.get(`/api/v1/variance/periods/${period.id}`)).json
    expect(variance.actualRevenue).toBe(50)
    expect(variance.actualCost).toBe(120)
    await closeHarness(harness)
  })

  it('shrinks ledger periods with the current draft horizon', async () => {
    const harness = await buildHarness('horizon')
    const client = new Client(harness.app)
    await registerUser(client, 'horizon@example.com')

    const draft = (await client.get('/api/v1/workspace/draft')).json
    const expandedConfig = { ...draft.config, planning: { ...draft.config.planning, horizonMonths: 24 } }
    expandedConfig.months = Array.from({ length: 24 }, (_, index) => ({
      ...(draft.config.months[index] ?? draft.config.months.at(-1)),
      id: `month-test-${index + 1}`,
      label: `${((draft.config.planning.startMonth - 1 + index) % 12) + 1}月`,
    }))
    const expanded = await client.patch('/api/v1/workspace/draft', {
      revision: draft.revision,
      workspaceName: draft.workspaceName,
      config: expandedConfig,
    })
    expect(expanded.statusCode).toBe(200)
    expect((await client.get('/api/v1/ledger/periods')).json).toHaveLength(24)

    const shrinkConfig = { ...expanded.json.config, planning: { ...expanded.json.config.planning, horizonMonths: 12 }, months: expanded.json.config.months.slice(0, 12) }
    const shrunk = await client.patch('/api/v1/workspace/draft', {
      revision: expanded.json.revision,
      workspaceName: expanded.json.workspaceName,
      config: shrinkConfig,
    })
    expect(shrunk.statusCode).toBe(200)
    expect((await client.get('/api/v1/ledger/periods')).json.map((item: any) => item.monthIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    await closeHarness(harness)
  })

  it('rolls back versions and shares immutable release payloads', async () => {
    const harness = await buildHarness('share')
    const client = new Client(harness.app)
    await registerUser(client, 'share@example.com', 'Sharer')

    const draft = (await client.get('/api/v1/workspace/draft')).json
    draft.config.operating.offlineUnitPrice = 88
    const save = await client.patch('/api/v1/workspace/draft', { revision: draft.revision, workspaceName: draft.workspaceName, config: draft.config })
    expect(save.statusCode).toBe(200)
    const releaseV1 = await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V1' })

    const refreshed = (await client.get('/api/v1/workspace/draft')).json
    refreshed.config.operating.offlineUnitPrice = 120
    await client.patch('/api/v1/workspace/draft', { revision: refreshed.revision, workspaceName: refreshed.workspaceName, config: refreshed.config })
    await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V2' })

    const rolledBack = await client.post(`/api/v1/workspace/versions/${releaseV1.json.id}/rollback`)
    expect(rolledBack.json.config.operating.offlineUnitPrice).toBe(88)
    expect((await client.get('/api/v1/workspace/versions')).json.map((item: any) => item.versionNo)).toEqual([2, 1])

    const share = await client.post(`/api/v1/workspace/versions/${releaseV1.json.id}/share`)
    expect(share.statusCode).toBe(200)
    const publicPayload = await client.get(`/api/v1/public/shares/${share.json.shareToken}`)
    expect(publicPayload.statusCode).toBe(200)
    expect(publicPayload.json.config.operating.offlineUnitPrice).toBe(88)

    expect((await client.delete(`/api/v1/workspace/versions/${releaseV1.json.id}/share`)).statusCode).toBe(200)
    expect((await client.get(`/api/v1/public/shares/${share.json.shareToken}`)).statusCode).toBe(404)
    const reissued = await client.post(`/api/v1/workspace/versions/${releaseV1.json.id}/share`)
    expect(reissued.json.shareToken).not.toBe(share.json.shareToken)
    await closeHarness(harness)
  })

  it('returns 403 for cross-workspace private access', async () => {
    const harness = await buildHarness('access')
    const owner = new Client(harness.app)
    const outsider = new Client(harness.app)
    await registerUser(owner, 'owner@example.com', 'Owner')
    await registerUser(outsider, 'outsider@example.com', 'Outsider')

    const release = await owner.post('/api/v1/workspace/versions', { kind: 'release', name: 'Owner Budget' })
    const ownerPeriod = (await owner.get('/api/v1/ledger/periods')).json[0]
    const requests = [
      await outsider.get(`/api/v1/ledger/periods/${ownerPeriod.id}/subjects`),
      await outsider.get(`/api/v1/ledger/entries?periodId=${ownerPeriod.id}`),
      await outsider.get(`/api/v1/variance/periods/${ownerPeriod.id}`),
      await outsider.post(`/api/v1/workspace/versions/${release.json.id}/rollback`),
      await outsider.delete(`/api/v1/workspace/versions/${release.json.id}`),
      await outsider.post(`/api/v1/workspace/versions/${release.json.id}/share`),
    ]
    expect(requests.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403, 403])
    await closeHarness(harness)
  })

  it('derives, updates, voids, and restores member commission entries', async () => {
    const harness = await buildHarness('member-income')
    const client = new Client(harness.app)
    await registerUser(client, 'member-income@example.com')
    await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V1' })

    const period = (await client.get('/api/v1/ledger/periods')).json[0]
    const subjects = (await client.get(`/api/v1/ledger/periods/${period.id}/subjects`)).json
    const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))

    const created = await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: period.id,
      direction: 'income',
      amount: 880,
      occurredAt: '2026-03-05T10:00:00+00:00',
      relatedEntityType: 'teamMember',
      relatedEntityId: 'member-a',
      allocations: [{ ...subjectMap['revenue.offline_sales'], amount: 880 }],
    })
    expect(created.statusCode).toBe(200)
    const entries = (await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json
    const manual = entries.find((item: any) => item.id === created.json.id)
    const derived = entries.find((item: any) => item.sourceEntryId === manual.id)
    expect(derived.amount).toBe(308)
    expect(derived.allocations[0].subjectKey).toBe('cost.member.commission')

    const updated = await client.patch(`/api/v1/ledger/entries/${manual.id}`, {
      amount: 1000,
      occurredAt: '2026-03-06T12:00:00+00:00',
      relatedEntityType: 'teamMember',
      relatedEntityId: 'member-a',
      allocations: [
        { ...subjectMap['revenue.offline_sales'], amount: 700 },
        { ...subjectMap['revenue.online_sales'], amount: 300 },
      ],
    })
    expect(updated.statusCode).toBe(200)
    const afterUpdate = (await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json
    const updatedDerived = afterUpdate.find((item: any) => item.sourceEntryId === manual.id && item.status === 'posted')
    expect(updatedDerived.amount).toBe(350)

    expect((await client.patch(`/api/v1/ledger/entries/${updatedDerived.id}`, { amount: 350, allocations: [{ ...subjectMap['cost.member.commission'], amount: 350 }] })).statusCode).toBe(409)
    expect((await client.post(`/api/v1/ledger/entries/${updatedDerived.id}/void`)).statusCode).toBe(409)
    expect((await client.post(`/api/v1/ledger/entries/${manual.id}/void`)).statusCode).toBe(200)
    expect((await client.get(`/api/v1/variance/periods/${period.id}`)).json.actualRevenue).toBe(0)
    expect((await client.post(`/api/v1/ledger/entries/${updatedDerived.id}/restore`)).statusCode).toBe(409)
    expect((await client.post(`/api/v1/ledger/entries/${manual.id}/restore`)).statusCode).toBe(200)
    expect((await client.get(`/api/v1/variance/periods/${period.id}`)).json.actualRevenue).toBe(1000)
    await closeHarness(harness)
  })

  it('posts explicit occurred dates into the matching period and realigns dirty rows', async () => {
    const harness = await buildHarness('occurred')
    const client = new Client(harness.app)
    await registerUser(client, 'occurred@example.com')
    await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V1' })
    const [march, april] = (await client.get('/api/v1/ledger/periods')).json
    const subjects = (await client.get(`/api/v1/ledger/periods/${march.id}/subjects`)).json
    const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))

    const created = await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: march.id,
      direction: 'income',
      amount: 88,
      occurredAt: '2026-04-05T12:00:00+00:00',
      allocations: [{ ...subjectMap['revenue.offline_sales'], amount: 88 }],
    })
    expect(created.json.ledgerPeriodId).toBe(april.id)
    expect((await client.get(`/api/v1/ledger/entries?periodId=${march.id}`)).json.some((item: any) => item.id === created.json.id)).toBe(false)
    expect((await client.get(`/api/v1/ledger/entries?periodId=${april.id}`)).json.some((item: any) => item.id === created.json.id)).toBe(true)

    await sql`UPDATE actual_entries SET occurred_at = '2026-03-05T12:00:00.000Z' WHERE id = ${created.json.id}`.execute(harness.db)
    expect((await client.get(`/api/v1/ledger/entries?periodId=${march.id}`)).json.some((item: any) => item.id === created.json.id)).toBe(true)
    await closeHarness(harness)
  })

  it('locks periods and reconciles multi-allocation variance', async () => {
    const harness = await buildHarness('lock')
    const client = new Client(harness.app)
    await registerUser(client, 'lock@example.com')
    await client.post('/api/v1/workspace/versions', { kind: 'release', name: 'Budget V1' })
    const [firstPeriod, secondPeriod] = (await client.get('/api/v1/ledger/periods')).json
    const subjects = (await client.get(`/api/v1/ledger/periods/${firstPeriod.id}/subjects`)).json
    const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))

    const income = await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: firstPeriod.id,
      direction: 'income',
      amount: 1000,
      allocations: [
        { ...subjectMap['revenue.offline_sales'], amount: 700 },
        { ...subjectMap['revenue.online_sales'], amount: 300 },
      ],
    })
    expect(income.statusCode).toBe(200)
    expect((await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: firstPeriod.id,
      direction: 'income',
      amount: 100,
      allocations: [{ ...subjectMap['cost.member.commission'], amount: 100 }],
    })).statusCode).toBe(422)
    expect((await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: secondPeriod.id,
      direction: 'expense',
      amount: 200,
      allocations: [{ ...subjectMap['cost.member.commission'], amount: 200 }],
    })).statusCode).toBe(422)
    expect((await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: secondPeriod.id,
      direction: 'expense',
      amount: 450,
      allocations: [
        { ...subjectMap['cost.member.base_pay'], amount: 200 },
        { ...subjectMap['cost.employee.base_pay'], amount: 250 },
      ],
    })).statusCode).toBe(200)

    const firstVariance = (await client.get(`/api/v1/variance/periods/${firstPeriod.id}`)).json
    expect(firstVariance.actualRevenue).toBe(1000)
    expect(firstVariance.revenueVarianceAmount).toBe(firstVariance.actualRevenue - firstVariance.plannedRevenue)
    const secondVariance = (await client.get(`/api/v1/variance/periods/${secondPeriod.id}`)).json
    expect(secondVariance.cumulativeActualRevenue).toBe(firstVariance.actualRevenue + secondVariance.actualRevenue)

    expect((await client.post(`/api/v1/ledger/periods/${firstPeriod.id}/lock`)).json.status).toBe('locked')
    expect((await client.post('/api/v1/ledger/entries', {
      ledgerPeriodId: firstPeriod.id,
      direction: 'income',
      amount: 50,
      allocations: [{ ...subjectMap['revenue.offline_sales'], amount: 50 }],
    })).statusCode).toBe(422)
    expect((await client.post(`/api/v1/ledger/entries/${income.json.id}/void`)).statusCode).toBe(409)
    expect((await client.post(`/api/v1/ledger/periods/${firstPeriod.id}/unlock`)).json.status).toBe('open')
    expect((await client.post(`/api/v1/ledger/entries/${income.json.id}/void`)).statusCode).toBe(200)
    expect((await client.get(`/api/v1/variance/periods/${firstPeriod.id}`)).json.actualRevenue).toBe(0)
    await closeHarness(harness)
  })

  it('sanitizes model-provided goal facts without parsing prose locally', () => {
    const facts = sanitizeAgentGoalFacts({
      workspaceName: '星河 50 期启动测算',
      expectedMemberCount: 50,
      expectedShareholderCount: 5,
      expectedHorizonMonths: 12,
      expectedStartMonth: 3,
      requiresForecastSummary: true,
      requiresSandboxComputation: true,
      forbiddenActions: ['publish_release', 'unknown'],
      ignored: 'not persisted',
    })
    expect(facts).toEqual({
      workspaceName: '星河 50 期启动测算',
      expectedMemberCount: 50,
      expectedShareholderCount: 5,
      expectedHorizonMonths: 12,
      expectedStartMonth: 3,
      requiresForecastSummary: true,
      requiresSandboxComputation: true,
      forbiddenActions: ['publish_release'],
    })

    expect(sanitizeAgentGoalFacts('我们几个月才能回本？帮我第一个股东注资100w')).toEqual({})
  })

  it('treats automation level as execution authority instead of planner effort', () => {
    expect(resolveActionAuthority({
      automationLevel: 'manual',
      kind: 'ledger.create_entry',
      riskLevel: 'medium',
    })).toMatchObject({ mode: 'require_confirmation' })
    expect(resolveActionAuthority({
      automationLevel: 'medium',
      kind: 'ledger.create_entry',
      riskLevel: 'medium',
    })).toMatchObject({ mode: 'auto_execute' })
    expect(resolveActionAuthority({
      automationLevel: 'high',
      kind: 'workspace.update_draft',
      riskLevel: 'high',
    })).toMatchObject({ mode: 'require_confirmation' })
    expect(resolveActionAuthority({
      automationLevel: 'high',
      kind: 'account.delete',
      riskLevel: 'high',
    })).toMatchObject({ mode: 'forbidden' })
  })

  it('creates agent navigation events, confirmation cards, and executes confirmed ledger writes', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponse('ledger_create_member_income', {
      monthLabel: '3月',
      memberName: '成员 A',
      offlineUnits: 10,
      onlineUnits: 2,
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-ledger', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-ledger@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 10 张、线上 2 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.navigationEvents[0].route.mainTab).toBe('bookkeeping')
      expect(planned.json.planSteps).toHaveLength(1)
      expect(planned.json.planSteps[0].status).toBe('ready')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].status).toBe('pending')
      expect(planned.json.runEvents.map((event: any) => event.type)).toEqual(
        expect.arrayContaining(['run_queued', 'worker_claimed', 'model_planning', 'tool_plan_ready', 'confirmation_ready', 'run_completed']),
      )
      const visibleTranscript = planned.json.transcriptItems
        .filter((item: any) => item.visibility === 'user')
        .map((item: any) => `${item.title}\n${item.summary}`)
        .join('\n')
      expect(visibleTranscript).toContain('你')
      expect(visibleTranscript).toContain('确认成员收入入账')
      expect(visibleTranscript).not.toContain('需要你确认动作')
      expect(visibleTranscript).not.toContain('待确认动作卡')
      expect(visibleTranscript).not.toContain('Worker 已认领')
      expect(visibleTranscript).not.toContain('run lease')
      const visibleTimeline = planned.json.timelineItems
        .filter((item: any) => item.visibility === 'user')
        .map((item: any) => `${item.kind}:${item.title}\n${item.summary}`)
        .join('\n')
      expect(visibleTimeline).toContain('user_message:你')
      expect(visibleTimeline).toContain('tool_call:调用工具')
      expect(planned.json.timelineItems.some((item: any) => item.kind === 'tool_call' && item.actionRequest?.id === planned.json.actionRequests[0].id)).toBe(true)
      expect(visibleTimeline).not.toContain('Worker 已认领')
      expect(visibleTimeline).not.toContain('run lease')
      expect(planned.json.actionRequests[0].details).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: '发生日', value: expect.stringMatching(/-03-01$/) })]),
      )

      const confirmed = await client.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json.actionRequest.status).toBe('executed')
      expect(confirmed.json.result.amount).toBe(1056)
      expect(confirmed.json.runEvents.some((event: any) => event.type === 'action_executed')).toBe(true)
      const projected = await client.get(`/api/v1/agent/threads/${planned.json.threadId}/ag-ui-events`)
      expect(projected.statusCode).toBe(200)
      expect(projected.json.events.some((event: any) => event.type === 'TOOL_CALL_RESULT' && event.toolName === 'ledger.create_entry')).toBe(true)
      expect(projected.json.transcriptItems.some((item: any) => item.kind === 'tool_result' && item.title === '已执行动作')).toBe(true)
      expect(projected.json.timelineItems.some((item: any) => item.kind === 'tool_result' && item.toolName === 'ledger.create_entry')).toBe(true)

      const periodId = planned.json.navigationEvents[0].route.selectedPeriodId
      const entries = (await client.get(`/api/v1/ledger/entries?periodId=${periodId}`)).json
      const memberEntry = entries.find((entry: any) => entry.relatedEntityId === 'member-a' && entry.amount === 1056)
      expect(memberEntry).toBeTruthy()
      expect(memberEntry.occurredAt).toContain('-03-01T')
      const audit = await harness.db.selectFrom('audit_logs').select('action').where('action', '=', 'agent.action_executed').execute()
      expect(audit).toHaveLength(1)
      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('auto-executes eligible medium-risk writes at medium automation', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponse('ledger_create_member_income', {
      monthLabel: '3月',
      memberName: '成员 A',
      onlineUnits: 10,
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-medium-auto-exec-ledger', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-medium-auto-exec-ledger@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '帮我记一笔成员 A 3 月线上 10 张',
        automationLevel: 'medium',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.automationLevel).toBe('medium')
      expect(response.json.actionRequests).toHaveLength(1)
      expect(response.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(response.json.actionRequests[0].status).toBe('executed')
      expect(response.json.planSteps.find((step: any) => step.actionRequestId === response.json.actionRequests[0].id)?.status).toBe('executed')
      expect(response.json.runEvents.some((event: any) => event.type === 'action_auto_executed')).toBe(true)
      expect(response.json.runEvents.some((event: any) => event.type === 'confirmation_ready')).toBe(false)

      const periodId = response.json.actionRequests[0].payload.ledgerPeriodId
      const entries = (await client.get(`/api/v1/ledger/entries?periodId=${periodId}`)).json
      expect(entries.some((entry: any) => entry.relatedEntityId === 'member-a' && entry.amount === 880)).toBe(true)
      const audit = await harness.db.selectFrom('audit_logs').select('action').where('action', '=', 'agent.action_executed').execute()
      expect(audit).toHaveLength(1)
      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('plans multiple agent steps and lets users edit pending action payloads before execution', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 B',
        offlineUnits: 1,
        onlineUnits: 1,
      }),
      () => fakeToolResponse('workspace_update_online_factor', {
        monthLabel: '4月',
        onlineSalesFactor: 0.3,
        mode: 'write',
      }),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-multi-edit', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-multi-edit@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 B 线下 1 张、线上 1 张入账；把 4 月线上系数改成 0.3 并保存',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.planSteps).toHaveLength(2)
      expect(planned.json.actionRequests.map((action: any) => action.kind)).toEqual([
        'ledger.create_entry',
        'workspace.update_draft',
      ])

      const ledgerAction = planned.json.actionRequests[0]
      const invalidNavigation = await client.patch(`/api/v1/agent/action-requests/${ledgerAction.id}`, {
        navigation: {
          type: 'navigation',
          route: { mainTab: 'dashboard', secondaryTab: 'overview' },
          reason: '试图把记账确认卡切到错误页面。',
        },
      })
      expect(invalidNavigation.statusCode).toBe(422)

      const editedPayload = {
        ...ledgerAction.payload,
        amount: 264,
        allocations: ledgerAction.payload.allocations.map((allocation: any, index: number) => ({
          ...allocation,
          amount: index === 0 ? 176 : 88,
        })),
      }
      const edited = await client.patch(`/api/v1/agent/action-requests/${ledgerAction.id}`, {
        summary: '编辑后：3月成员 B 入账 264 元。',
        details: [...ledgerAction.details.filter((detail: any) => detail.label !== '入账金额'), { label: '入账金额', value: '264' }],
        payload: editedPayload,
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json.actionRequest.summary).toContain('264')
      expect(edited.json.planSteps[0].description).toContain('264')
      expect(edited.json.runEvents.some((event: any) => event.type === 'action_updated')).toBe(true)

      const confirmedLedger = await client.post(`/api/v1/agent/action-requests/${ledgerAction.id}/confirm`)
      expect(confirmedLedger.statusCode).toBe(200)
      expect(confirmedLedger.json.result.amount).toBe(264)
      expect(confirmedLedger.json.planSteps[0].status).toBe('executed')
      expect(confirmedLedger.json.runEvents.some((event: any) => event.type === 'action_executed')).toBe(true)

      const draftAction = planned.json.actionRequests[1]
      const confirmedDraft = await client.post(`/api/v1/agent/action-requests/${draftAction.id}/confirm`)
      expect(confirmedDraft.statusCode).toBe(200)
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.months.find((month: any) => month.label === '4月').onlineSalesFactor).toBe(0.3)
      await closeHarness(harness)
    }, { capabilities: ['ledger', 'draft'], requiredActionCapabilities: ['ledger', 'draft'] })
  })

  it('repairs a cross-domain goal and auto-executes eligible writes under high automation', async () => {
    let goalPlanningCalls = 0
    const finalizerRequests: any[] = []
    const provider = mutableScriptedProvider(fakeAssistantTextResponse('已按当前对话记录这个上下文。'))
    await withFakeOpenAICompatibleProvider(provider.handler, async (baseUrl) => {
      const harness = await buildHarness('agent-cross-domain-goal-repair', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-cross-domain-goal-repair@example.com')

      const contextTurn = await client.post('/api/v1/agent/messages', {
        message: '今天是 5.24。第一个股东是股东 A，另外的股东不需要删除。',
      })
      expect(contextTurn.statusCode).toBe(200)

      provider.setStep((body) => {
        const prompt = body.messages.map((message: any) => message.content).join('\n')
        expect(prompt).toContain('今天是 5.24')
        expect(prompt).toContain('第一个股东是股东 A')
        expect(body.messages[0].content).not.toContain('shareholders[0].investmentAmount')
        expect(body.messages[0].content).not.toContain('第一个股东是股东 A')

        goalPlanningCalls += 1
        if (goalPlanningCalls === 1) {
          return fakeToolResponse('data_query_workspace', {
            question: '我们几个月才能回本？',
            scope: 'workspace_summary',
            metrics: ['payback', 'cash', 'roi'],
          })
        }
        if (goalPlanningCalls === 2) {
          return fakeToolResponses([
            {
              name: 'ledger_create_member_income',
              args: {
                memberName: '成员 A',
                onlineUnits: 10,
                occurredAt: '2026-05-24',
              },
            },
            {
              name: 'workspace_patch_config',
              args: {
                patches: [
                  { path: 'shareholders[0].name', value: '股东 A', label: '股东 1 名称' },
                  { path: 'shareholders[0].investmentAmount', value: 1065000, label: '股东 1 投资额' },
                ],
              },
            },
          ])
        }
        return fakeAssistantTextResponse('当前仍未回本；成员入账和股东注资动作已处理。')
      })

      const response = await client.post('/api/v1/agent/messages', {
        threadId: contextTurn.json.threadId,
        message: '我们几个月才能回本？帮我记一笔成员A的今天的线上10张，然后帮我第一个股东注资100w',
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      expect(goalPlanningCalls).toBeGreaterThanOrEqual(2)
      expect(goalPlanningCalls).toBeLessThanOrEqual(3)
      expect(finalizerRequests.length).toBeGreaterThanOrEqual(1)
      expect(response.json.actionRequests).toHaveLength(2)
      expect(response.json.actionRequests.every((action: any) => action.status === 'executed')).toBe(true)
      expect(response.json.actionRequests.map((action: any) => action.kind).sort()).toEqual(['ledger.create_entry', 'workspace.update_draft'])
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.evaluations.map((evaluation: any) => evaluation.status)).toEqual(['continue', 'pass'])
      expect(response.json.runEvents.filter((event: any) => event.type === 'memory_recall_started')).toHaveLength(1)
      expect(response.json.runEvents.filter((event: any) => event.type === 'action_auto_executed')).toHaveLength(2)
      expect(response.json.messages.at(-1).content).toContain('自动执行 2 个动作')
      expect(response.json.messages.at(-1).content).toContain('成员 A')
      expect(response.json.messages.at(-1).content).toContain('股东 A')

      const ledgerAction = response.json.actionRequests.find((action: any) => action.kind === 'ledger.create_entry')
      expect(ledgerAction.targetLabel).toContain('5月 / 成员 A')
      expect(ledgerAction.payload.amount).toBe(880)
      expect(ledgerAction.payload.occurredAt).toContain('2026-05-24')

      const draftAction = response.json.actionRequests.find((action: any) => action.kind === 'workspace.update_draft')
      expect(draftAction.payload.config.shareholders[0].name).toBe('股东 A')
      expect(draftAction.payload.config.shareholders[0].investmentAmount).toBe(1065000)
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.shareholders[0].investmentAmount).toBe(1065000)
      const entries = (await client.get(`/api/v1/ledger/entries?periodId=${ledgerAction.payload.ledgerPeriodId}`)).json
      expect(entries.some((entry: any) => entry.relatedEntityId === ledgerAction.payload.relatedEntityId && entry.amount === 880)).toBe(true)
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'ledger', 'draft'],
      requiredActionCapabilities: ['ledger', 'draft'],
      finalizerResponse: (body) => {
        finalizerRequests.push(body)
        return fakeAssistantTextResponse('当前仍未回本；高自动化已自动执行 2 个动作：成员 A 今天线上 10 张入账、股东 A 注资 100 万。')
      },
      observationContinuationResponse: false,
    })
  })

  it('continues from domain observations into sandbox computation before the final model answer', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '当前工作区整体ROI、现金、回本情况',
          scope: 'workspace_summary',
          metrics: ['roi', 'cash', 'payback'],
        })
      }
      if (planningCalls === 2) {
        expect(body.stream).toBe(false)
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(true)
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeToolResponse('sandbox_run_code', {
          purpose: '结合当前预测、第一位股东投入、5%通胀和5%贷款年利率计算个人预期回报',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'entities = xox_sandbox.data_query_workspace(scope="entity_summary", metrics=["shareholderNames", "shareholderInvestments"])',
            'shareholders = entities.get("shareholders", [])',
            'first = shareholders[0] if shareholders else None',
            'profit = summary.get("totalProfit", 0)',
            'investment = (first or {}).get("investmentAmount", 0) or 0',
            'loan_interest = investment * 0.05',
            'personal_roi = None if investment == 0 else (profit - loan_interest) / investment',
            'xox_sandbox.emit({',
            '  "summary": "已完成第一位股东个人回报测算",',
            '  "structured": {',
            '    "firstShareholder": first,',
            '    "shareholders": shareholders,',
            '    "totalProfit": profit,',
            '    "loanInterest": loan_interest,',
            '    "personalRoi": personal_roi',
            '  }',
            '})',
          ].join('\n'),
          dataRequest: { scope: 'workspace_summary' },
          expectedOutputs: ['json'],
        })
      }
      if (planningCalls === 3) {
        const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
        expect(toolMessages.some((message: any) => String(message.content).includes('sandbox_execution'))).toBe(true)
        expect(JSON.stringify(toolMessages)).toContain('firstShareholder')
        expect(JSON.stringify(toolMessages)).toContain('shareholders')
        return fakeAssistantTextResponse('按当前预测、5%通胀和5%贷款年利率估算，第一位股东的个人回报需要以沙箱计算结果为准；本轮最终回答由模型基于 sandbox observation 生成。')
      }
      throw new Error(`Unexpected planning call ${planningCalls}`)
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-observation-sandbox-loop', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-observation-sandbox-loop@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '给我预测一下，如果目前的通胀率是5%，我的投资回报率是多少？我是第一个股东，我投入的钱都是银行贷款出来的，银行利率是年利率5%',
      })

      expect(response.statusCode).toBe(200)
      expect(planningCalls).toBe(2)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps.map((step: any) => step.toolName).filter(Boolean)).toEqual([
        'data_query_workspace',
        'sandbox_run_code',
      ])
      expect(response.json.messages.at(-1).content).toContain('个人回报')
      expect(response.json.messages.at(-1).content).not.toContain('fake_deterministic')
      expect(response.json.runEvents.map((event: any) => event.type)).toContain('observation_assistant_continuation_requested')
      expect(response.json.runEvents.some((event: any) =>
        event.type === 'provider_stable_long_tool_mode' &&
        event.data?.toolName === 'sandbox_run_code' &&
        event.data?.stream === false,
      )).toBe(true)
      expect(response.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'pass' &&
        event.data?.evidenceCount >= 2,
      )).toBe(true)
      const eventTypes = response.json.runEvents.map((event: any) => event.type)
      expect(eventTypes).toContain('final_answer_candidate')
      const finalCandidateIndex = eventTypes.indexOf('final_answer_candidate')
      const passIndex = response.json.runEvents.findIndex((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'pass')
      expect(finalCandidateIndex).toBeGreaterThan(-1)
      expect(passIndex).toBeGreaterThan(finalCandidateIndex)
      expect(response.json.runEvents.slice(finalCandidateIndex + 1, passIndex).some((event: any) =>
        event.type === 'tool_loop_guardrail' &&
        event.data?.finding?.pattern === 'no_progress',
      )).toBe(false)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.goals.at(-1).status).toBe('completed')
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'sandbox'],
      goalFacts: { requiresSandboxComputation: true },
      observationContinuationResponse: false,
    })
  })

  it('replays repairable sandbox failures into the main loop before accepting the final answer', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '当前工作区整体ROI、现金、回本情况',
          scope: 'workspace_summary',
          metrics: ['roi', 'cash', 'payback'],
        })
      }
      if (planningCalls === 2) {
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeToolResponse('sandbox_run_code', {
          purpose: '先计算第一位股东贷款利息后的个人回报',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'print("starting")',
            'broken = ',
          ].join('\n'),
          dataRequest: { scope: 'workspace_summary' },
          expectedOutputs: ['json'],
        })
      }
      if (planningCalls === 3) {
        expectProviderTools(body, ['sandbox_run_code'])
        const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
        expect(JSON.stringify(toolMessages)).toContain('sandbox_execution')
        expect(JSON.stringify(toolMessages)).toContain('SyntaxError')
        return fakeToolResponse('sandbox_run_code', {
          purpose: '修正脚本并重新计算第一位股东贷款利息后的个人回报',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'entities = xox_sandbox.data_query_workspace(scope="entity_summary", metrics=["shareholderNames", "shareholderInvestments"])',
            'shareholders = entities.get("shareholders", [])',
            'first = shareholders[0] if shareholders else {}',
            'investment = first.get("investmentAmount", 0) or 0',
            'profit = summary.get("totalProfit", 0) or 0',
            'interest = investment * 0.05',
            'personal_roi = None if investment == 0 else (profit - interest) / investment',
            'xox_sandbox.emit({',
            '  "summary": "修复后完成第一位股东个人回报测算",',
            '  "structured": {',
            '    "firstShareholder": first,',
            '    "totalProfit": profit,',
            '    "loanInterest": interest,',
            '    "personalRoi": personal_roi',
            '  }',
            '})',
          ].join('\n'),
          dataRequest: { scope: 'workspace_summary' },
          expectedOutputs: ['json'],
        })
      }
      if (planningCalls === 4) {
        const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
        expect(JSON.stringify(toolMessages)).toContain('修复后完成第一位股东个人回报测算')
        return fakeAssistantTextResponse('已基于修复后的沙箱结果完成测算：第一位股东的贷款利息已计入个人回报，最终结论以第二次 sandbox observation 为准。')
      }
      throw new Error(`Unexpected planning call ${planningCalls}`)
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-sandbox-repairable-observation-loop', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-sandbox-repairable-observation-loop@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '给我预测一下，如果目前的通胀率是5%，我的投资回报率是多少？我是第一个股东，我投入的钱都是银行贷款出来的，银行利率是年利率5%',
      })

      expect(response.statusCode).toBe(200)
      expect(planningCalls).toBe(3)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      const sandboxSteps = state.json.planSteps.filter((step: any) => step.toolName === 'sandbox_run_code')
      expect(sandboxSteps.map((step: any) => step.status)).toEqual(['failed', 'executed'])
      expect(state.json.evaluations.some((evaluation: any) =>
        evaluation.status === 'continue' &&
        evaluation.unsatisfiedCriteria.some((finding: any) => finding.id === 'graph.repairable_tool_observations'),
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'tool_call_failed' &&
        event.data?.runtimeEvent?.payload?.outcome === 'failed_repairable',
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'tool_call_completed' &&
        event.data?.runtimeEvent?.payload?.outcome === 'completed_valid',
      )).toBe(true)
      expect(state.json.goals.at(-1).status).toBe('completed')
      expect(state.json.messages.at(-1).content).toContain('修复后完成第一位股东个人回报测算')
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'sandbox'],
      goalFacts: { requiresSandboxComputation: true },
      observationContinuationResponse: false,
    })
  })

  it('treats unavailable final-answer claim review as a non-blocking review signal', async () => {
    let planningCalls = 0
    let claimReviewCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      expectProviderTools(body, ['data_query_workspace'])
      return fakeToolResponse('data_query_workspace', {
        question: '当前工作区有几个成员？',
        scope: 'team_summary',
        metrics: ['memberCount', 'memberNames'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-optional-final-claim-review', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-optional-final-claim-review@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '我们现在有几个人？',
      })

      expect(response.statusCode).toBe(200)
      expect(planningCalls).toBe(1)
      expect(claimReviewCalls).toBe(0)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.goals.at(-1).status).toBe('completed')
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'final_answer_claim_extraction_unavailable',
      )).toBe(false)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'pass' &&
        event.data?.claimReviewStatus === 'skipped',
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) => event.type === 'run_failed')).toBe(false)
      expect(state.json.messages.at(-1).content).toContain('当前工作区共有')
      expect(state.json.messages.at(-1).content).not.toContain('final_answer_extract_claims')
      await closeHarness(harness)
    }, {
      capabilities: ['data'],
      finalAnswerClaims: () => {
        claimReviewCalls += 1
        return fakeAssistantTextResponse('我无法把最终回答转成结构化 claim。')
      },
    })
  })

  it('fails closed when sandbox retry returns assistant text without a tool observation', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '当前工作区整体ROI、现金、回本情况',
          scope: 'workspace_summary',
          metrics: ['roi', 'cash', 'payback'],
        })
      }
      if (planningCalls === 2) {
        expect(body.stream).toBe(false)
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeMalformedToolResponse('sandbox_run_code', '{"purpose":"结合工作区数据计算通胀和贷款后的个人 ROI","language":"python","code":"print(1)"')
      }
      if (planningCalls === 3) {
        expect(body.stream).toBe(false)
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeAssistantTextResponse('只用工作区 ROI 粗略估算，投资回报率大约为正。')
      }
      return fakeAssistantTextResponse('仍然只给普通回答。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-sandbox-missing-observation-fail-closed', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-sandbox-missing-observation-fail-closed@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '给我预测一下，如果目前的通胀率是15%，我的投资回报率是多少？我是第2个股东，我投入的钱都是银行贷款出来的，银行利率是年利率3%',
      })

      expect(response.statusCode).toBe(200)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'runtime_evidence_required' &&
        event.data?.toolNames?.includes('sandbox_run_code') &&
        event.data?.requiredGoalFacts?.requiresSandboxComputation === true,
      )).toBe(true)
      expect(state.json.planSteps.some((step: any) =>
        step.toolName === 'sandbox_run_code' &&
        step.status === 'failed' &&
        String(step.description).includes('未形成可执行 observation'),
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'needs_calculation' &&
        event.data?.findings?.some((finding: any) =>
          finding.code === 'response.sandbox_evidence_missing' ||
          finding.code === 'response.sandbox_evidence_invalid') &&
        event.data?.obligationLedger?.obligations?.some((obligation: any) =>
          obligation.kind === 'sandbox_calculation' &&
          (obligation.status === 'open' || obligation.status === 'invalid') &&
          obligation.toolNames?.includes('sandbox_run_code')),
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'run_failed' &&
        event.status === 'failed',
      )).toBe(true)
      expect(state.json.goals.at(-1).status).toBe('failed')
      expect(state.json.messages.at(-1).content).toContain('这轮没有完成所有目标')
      expect(state.json.messages.at(-1).content).not.toContain('sandbox_run_code')
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'sandbox'],
      observationContinuationResponse: false,
    })
  })

  it('keeps empty sandbox observations from completing the run even without router goal facts', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeToolResponse('sandbox_run_code', {
          purpose: '计算一个需要可复核沙箱证据的派生结果',
          language: 'python',
          code: 'pass',
          dataRequest: { scope: 'workspace_summary' },
          expectedOutputs: ['text'],
        })
      }
      return fakeAssistantTextResponse('结果是 2。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-invalid-sandbox-evidence', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-invalid-sandbox-evidence@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '请用沙箱做一次可复核计算，告诉我 1+1 的结果。',
      })

      expect(response.statusCode).toBe(200)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      const responseEvaluations = state.json.runEvents.filter((event: any) => event.type === 'response_evaluated')
      expect(responseEvaluations.some((event: any) =>
        event.data?.evaluationStatus === 'needs_calculation' &&
        event.data?.findings?.some((finding: any) => finding.code === 'response.sandbox_evidence_invalid') &&
        event.data?.evidence?.some((item: any) => item.authority === 'sandbox' && item.source === 'sandbox_run_code'),
      )).toBe(true)
      expect(state.json.goals.at(-1).status).toBe('failed')
      expect(state.json.messages.at(-1).content).toContain('这轮没有完成所有目标')
      await closeHarness(harness)
    }, {
      capabilities: ['sandbox'],
      observationContinuationResponse: false,
    })
  })

  it('requires model-visible ordered shareholder evidence before accepting shareholder-specific sandbox answers', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '读取有序股东事实',
          scope: 'entity_summary',
          metrics: ['shareholderNames', 'shareholderInvestments'],
        })
      }
      if (planningCalls === 2) {
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(true)
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeToolResponse('sandbox_run_code', {
          purpose: '计算第 2 位股东贷款后的个人 ROI',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'entities = xox_sandbox.data_query_workspace(scope="entity_summary", metrics=["shareholderNames", "shareholderInvestments"])',
            'shareholders = entities.get("shareholders", [])',
            'second = shareholders[1] if len(shareholders) > 1 else {}',
            'profit = summary.get("totalProfit", 0) or 0',
            'investment = second.get("investmentAmount", 0) or 0',
            'loan_interest = investment * 0.03',
            'roi = None if investment == 0 else (profit * (second.get("dividendRate", 0) or 0) - loan_interest) / investment',
            'xox_sandbox.emit({',
            '  "summary": "第 2 位股东贷款后的个人 ROI 已计算",',
            '  "structured": {"shareholder": second, "personalRoi": roi, "loanInterest": loan_interest}',
            '})',
          ].join('\n'),
          dataRequest: { scope: 'forecast_months' },
          expectedOutputs: ['json'],
        })
      }
      return fakeAssistantTextResponse('第 2 位股东是股东 B。基于沙箱计算结果，贷款后的个人 ROI 已完成测算。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-shareholder-evidence-required', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-shareholder-evidence-required@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '我是第 2 个股东，用沙箱计算贷款后的个人 ROI。',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.planSteps.map((step: any) => step.toolName).filter(Boolean)).toEqual([
        'data_query_workspace',
        'sandbox_run_code',
      ])
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.goals.at(-1).status).toBe('completed')
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'tool_plan_ready' &&
        event.data?.plannerSource === 'openai_compatible_tool_calls',
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'pass',
      )).toBe(true)
      expect(state.json.planSteps.some((step: any) =>
        step.toolName === 'data_query_workspace' &&
        step.toolArguments?.scope === 'entity_summary',
      )).toBe(true)
      await closeHarness(harness)
    }, {
      capabilities: ['sandbox'],
      finalAnswerClaims: [
        { kind: 'entity_specific', subject: { type: 'shareholder', label: '第 2 位股东' }, reason: 'final answer names an ordinal shareholder' },
        { kind: 'derived_calculation', subject: { type: 'calculation', label: 'personal ROI' }, reason: 'final answer reports a calculated ROI' },
      ],
      observationContinuationResponse: false,
    })
  })

  it('repairs shareholder fact obligations with model-visible entity reads', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['sandbox_run_code'])
        return fakeToolResponse('sandbox_run_code', {
          purpose: '计算第 2 位股东贷款后的个人 ROI',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'xox_sandbox.emit({"summary": "只有计算证据，尚未显式读取股东顺序", "structured": {"roi": summary.get("roi")}})',
          ].join('\n'),
          dataRequest: { scope: 'forecast_months' },
          expectedOutputs: ['json'],
        })
      }
      if (planningCalls === 2) {
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(true)
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '读取有序股东事实',
          scope: 'entity_summary',
          metrics: ['shareholderNames', 'shareholderInvestments'],
        })
      }
      if (planningCalls === 3) {
        const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
        expect(JSON.stringify(toolMessages)).toContain('shareholders')
        return fakeAssistantTextResponse('第 2 位股东是股东 B。结合沙箱计算结果，贷款后的个人 ROI 是 12%。')
      }
      throw new Error(`Unexpected planning call ${planningCalls}`)
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-shareholder-evidence-obligation-repair', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-shareholder-evidence-obligation-repair@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '我是第 2 个股东，用沙箱计算贷款后的个人 ROI。',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.planSteps.map((step: any) => step.toolName).filter(Boolean)).toEqual([
        'sandbox_run_code',
        'data_query_workspace',
      ])
      expect(response.json.messages.at(-1).content).toContain('第 2 位股东')
      expect(response.json.messages.at(-1).content).not.toContain('Runner evidence obligations')
      expect(response.json.messages.at(-1).content).not.toContain('runnerObligationPlan')
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'pass',
      )).toBe(true)
      expect(state.json.planSteps.some((step: any) =>
        step.toolName === 'data_query_workspace' &&
        step.toolArguments?.scope === 'entity_summary',
      )).toBe(true)
      expect(state.json.goals.at(-1).status).toBe('completed')
      await closeHarness(harness)
    }, {
      capabilities: ['sandbox'],
      finalAnswerClaims: [
        { kind: 'entity_specific', subject: { type: 'shareholder', label: '第 2 位股东' }, reason: 'final answer names an ordinal shareholder' },
        { kind: 'derived_calculation', subject: { type: 'calculation', label: 'personal ROI' }, reason: 'final answer reports a calculated ROI' },
      ],
      observationContinuationResponse: false,
    })
  })

  it('keeps shareholder fact obligations open after a sandbox repair closes only the calculation', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expectProviderTools(body, ['data_query_workspace'])
        return fakeToolResponse('data_query_workspace', {
          question: '当前工作区整体ROI、现金、回本情况',
          scope: 'workspace_summary',
          metrics: ['roi', 'cash', 'payback'],
        })
      }
      if (planningCalls === 2) {
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(true)
        return fakeAssistantTextResponse('只根据工作区总 ROI 粗略估算，第 2 位股东贷款后的投资回报率大约为正。')
      }
      if (planningCalls === 3) {
        const toolNames = (body.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name)
        expect(toolNames).toContain('data_query_workspace')
        expect(toolNames).toContain('sandbox_run_code')
        expect(toolNames).not.toContain('workspace_patch_config')
        expect(toolNames).not.toContain('ledger_create_member_income')
        expect(JSON.stringify(body)).toContain('runnerObligationPlan')
        return fakeToolResponse('sandbox_run_code', {
          purpose: '计算第 2 位股东贷款后的个人 ROI',
          language: 'python',
          code: [
            'import xox_sandbox',
            'summary = xox_sandbox.data_query_workspace(scope="workspace_summary", metrics=["roi", "cash", "payback"])',
            'entities = xox_sandbox.data_query_workspace(scope="entity_summary", metrics=["shareholderNames", "shareholderInvestments"])',
            'shareholders = entities.get("shareholders", [])',
            'second = shareholders[1] if len(shareholders) > 1 else {}',
            'profit = summary.get("totalProfit", 0) or 0',
            'investment = second.get("investmentAmount", 0) or 0',
            'interest = investment * 0.03',
            'roi = None if investment == 0 else (profit * (second.get("dividendRate", 0) or 0) - interest) / investment',
            'xox_sandbox.emit({',
            '  "summary": "贷款后的第 2 位股东 ROI 已计算",',
            '  "structured": {"shareholder": second, "personalRoi": roi, "loanInterest": interest}',
            '})',
          ].join('\n'),
          dataRequest: { scope: 'workspace_summary' },
          expectedOutputs: ['json'],
        })
      }
      if (planningCalls === 4) {
        const toolNames = (body.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name)
        expect(toolNames).toContain('data_query_workspace')
        expect(toolNames).not.toContain('workspace_patch_config')
        expect(toolNames).not.toContain('ledger_create_member_income')
        expect(JSON.stringify(body)).toContain('entity_summary')
        return fakeToolResponse('data_query_workspace', {
          question: '读取有序股东事实',
          scope: 'entity_summary',
          metrics: ['shareholderNames', 'shareholderInvestments'],
        })
      }
      if (planningCalls === 5) {
        const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
        expect(JSON.stringify(toolMessages)).toContain('sandbox_execution')
        expect(JSON.stringify(toolMessages)).toContain('shareholders')
        return fakeAssistantTextResponse('第 2 位股东是股东 B。结合沙箱计算结果，贷款后的个人 ROI 是 12%。')
      }
      throw new Error(`Unexpected planning call ${planningCalls}`)
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-obligation-ledger-keeps-partial-repair-open', {
        ...fakeProviderSettings(baseUrl),
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-obligation-ledger-keeps-partial-repair-open@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '给我预测一下，如果目前的通胀率是15%，我的投资回报率是多少？我是第2个股东，我投入的钱都是银行贷款出来的，银行利率是年利率3%',
      })

      expect(response.statusCode).toBe(200)
      expect(planningCalls).toBe(3)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'response_evaluated' &&
        event.data?.evaluationStatus === 'needs_calculation' &&
        event.data?.obligationLedger?.obligations?.some((obligation: any) =>
          obligation.kind === 'sandbox_calculation' && obligation.status === 'open') &&
        event.data?.obligationLedger?.obligations?.some((obligation: any) =>
          obligation.kind === 'domain_fact' && obligation.status === 'open'),
      )).toBe(true)
      expect(state.json.runEvents.some((event: any) =>
        event.type === 'runner_obligation_materialized' &&
        event.data?.toolNames?.includes('data_query_workspace'),
      )).toBe(true)
      expect(state.json.goals.at(-1).status).toBe('completed')
      expect(state.json.messages.at(-1).content).toContain('股东 B')
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'sandbox'],
      goalFacts: { requiresSandboxComputation: true, requiresOrderedEntityFacts: true },
      finalAnswerClaims: [
        { kind: 'entity_specific', subject: { type: 'shareholder', label: '第 2 位股东' }, reason: 'final answer names an ordinal shareholder' },
        { kind: 'derived_calculation', subject: { type: 'calculation', label: 'loan-adjusted ROI' }, reason: 'final answer reports a calculated ROI' },
      ],
      observationContinuationResponse: false,
    })
  }, 20_000)

  it('resumes a clarification turn and completes the missing cross-domain action without duplicating prior cards', async () => {
    let phase: 'initial' | 'resume' = 'initial'
    let initialPlanningCalls = 0
    let resumePlanningCalls = 0
    const finalizerRequests: any[] = []
    await withFakeOpenAICompatibleProvider((body) => {
      if (isCapabilityRouterRequest(body)) {
        return phase === 'resume'
          ? fakeCapabilitySelectionResponse(['ledger'], { requiredActionCapabilities: ['ledger'] })
          : fakeCapabilitySelectionResponse(['data', 'ledger', 'draft'], { requiredActionCapabilities: ['ledger', 'draft'] })
      }

      if (phase === 'resume') {
        resumePlanningCalls += 1
        return fakeToolResponse('ledger_create_member_income', {
          memberName: '成员1',
          onlineUnits: 10,
          occurredAt: '2026-05-24',
        })
      }

      initialPlanningCalls += 1
      if (initialPlanningCalls === 1) {
        return fakeToolResponses([
          {
            name: 'data_query_workspace',
            args: {
              question: '我们几个月才能回本？',
              scope: 'workspace_summary',
              metrics: ['payback', 'cash', 'roi'],
            },
          },
          {
            name: 'ask_user_clarification',
            args: {
              question: '当前团队里没有叫「成员A」的成员。你说的是哪位成员？',
              missingFields: ['memberName'],
              suggestions: ['成员 1', '成员 2', '成员 3'],
            },
          },
        ])
      }

      if (initialPlanningCalls === 2) {
        return fakeToolResponse('workspace_patch_config', {
          patches: [{ path: 'shareholders[0].investmentAmount', value: 1300000, label: '股东 1 投资额' }],
        })
      }

      return fakeAssistantTextResponse('回本周期暂未出现；股东注资已按高自动化执行，成员入账还需要你确认具体成员。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-clarification-resume-c7b3b3ec', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-clarification-resume-c7b3b3ec@example.com')

      const draftResponse = await client.get('/api/v1/workspace/draft')
      const config = draftResponse.json.config
      config.teamMembers = config.teamMembers.slice(0, 3).map((member: any, index: number) => ({
        ...member,
        id: `member_${index + 1}`,
        name: `成员 ${index + 1}`,
      }))
      config.shareholders = [
        { ...config.shareholders[0], id: 'shareholder_a', name: '股东 A', investmentAmount: 300000, dividendRate: 0.6 },
        { ...config.shareholders[0], id: 'shareholder_b', name: '股东 B', investmentAmount: 200000, dividendRate: 0.4 },
      ]
      const patched = await client.patch('/api/v1/workspace/draft', {
        revision: draftResponse.json.revision,
        workspaceName: draftResponse.json.workspaceName,
        config,
      })
      expect(patched.statusCode).toBe(200)

      const first = await client.post('/api/v1/agent/messages', {
        message: '我们几个月才能回本？帮我记一笔成员A的今天的线上10张，然后帮我第一个股东注资100w',
        automationLevel: 'high',
      })

      expect(first.statusCode).toBe(200)
      expect(first.json.actionRequests).toHaveLength(1)
      expect(first.json.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(first.json.actionRequests[0].status).toBe('executed')
      expect(first.json.actionRequests[0].payload.config.shareholders[0].investmentAmount).toBe(1300000)
      const firstState = await client.get(`/api/v1/agent/threads/${first.json.threadId}`)
      expect(firstState.json.evaluations.map((evaluation: any) => evaluation.status)).toContain('needs_clarification')
      expect(first.json.messages.at(-1).content).toContain('成员')

      phase = 'resume'
      const second = await client.post('/api/v1/agent/messages', {
        threadId: first.json.threadId,
        message: '是的。成员1',
        automationLevel: 'high',
      })

      expect(second.statusCode).toBe(200)
      expect(initialPlanningCalls).toBeGreaterThanOrEqual(2)
      expect(resumePlanningCalls).toBeGreaterThanOrEqual(1)
      expect(resumePlanningCalls).toBeLessThanOrEqual(2)
      expect(finalizerRequests.length).toBeGreaterThanOrEqual(1)
      expect(second.json.runEvents.some((event: any) => event.type === 'clarification_resume_context')).toBe(true)
      expect(second.json.actionRequests).toHaveLength(1)
      expect(second.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(second.json.actionRequests[0].status).toBe('executed')
      expect(second.json.actionRequests[0].targetLabel).toContain('成员 1')
      expect(second.json.actionRequests[0].payload.amount).toBe(880)
      expect(second.json.actionRequests[0].payload.occurredAt).toContain('2026-05-24')

      const state = await client.get(`/api/v1/agent/threads/${first.json.threadId}`)
      const executedKinds = state.json.actionRequests
        .filter((action: any) => action.status === 'executed')
        .map((action: any) => action.kind)
        .sort()
      expect(executedKinds).toEqual(['ledger.create_entry', 'workspace.update_draft'])
      expect(state.json.actionRequests.filter((action: any) => action.kind === 'workspace.update_draft')).toHaveLength(1)
      await closeHarness(harness)
    }, {
      autoSelectCapabilities: false,
      requiredActionCapabilities: ['ledger', 'draft'],
      finalizerResponse: (body) => {
        finalizerRequests.push(body)
        return finalizerRequests.length === 1
          ? fakeAssistantTextResponse('回本周期暂未出现；股东注资已按高自动化执行，成员入账还需要你确认具体成员。')
          : fakeAssistantTextResponse('已根据你的补充自动执行成员 1 今天线上 10 张入账；股东注资也已完成。')
      },
      observationContinuationResponse: false,
    })
  })

  it('does not create a confirmation card for no-op workspace patch arguments', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponse('workspace_patch_config', {
      patches: [
        { path: 'shareholders[0].investmentAmount', value: 65000, label: '股东 1 投资额' },
      ],
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-noop-workspace-patch', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-noop-workspace-patch@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '检查一下第一个股东投资额是不是当前值，不需要写入',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps.map((step: any) => step.title)).toContain('模型草稿未变化')
      expect(response.json.messages.at(-1).content).toContain('没有生成写入确认卡')
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.shareholders[0].investmentAmount).toBe(65000)
      await closeHarness(harness)
    }, {
      finalizerResponse: () => fakeAssistantTextResponse('当前股东投资额和工具参数一致，没有生成写入确认卡。'),
    })
  })

  it('keeps allowed steps when a multi-step message also contains a forbidden account action', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expectProviderTools(body, ['ledger_create_member_income'])
        return fakeToolResponse('ledger_create_member_income', {
          monthLabel: '3月',
          memberName: '成员 A',
          offlineUnits: 1,
          onlineUnits: 0,
        })
      },
      (body) => {
        expectProviderTools(body, ['account_forbidden'])
        return fakeToolResponse('account_forbidden')
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-mixed-account-step', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-mixed-account-step@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账；帮我注销账号',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.planSteps).toHaveLength(2)
      expect(planned.json.actionRequests).toHaveLength(1)
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.planSteps.map((step: any) => step.status)).toEqual(['ready', 'info'])
      expect(planned.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(planned.json.planSteps[1].description).toContain('账号登录、退出、注销')

      const restored = await client.get(`/api/v1/agent/threads/${planned.json.threadId}`)
      expect(restored.statusCode).toBe(200)
      expect(restored.json.planSteps).toHaveLength(2)
      expect(restored.json.actionRequests[0].status).toBe('pending')
      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('enforces Agent tool policy for edited payload ownership and derived ledger entries', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      }),
      () => fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 B',
        offlineUnits: 1,
        onlineUnits: 0,
      }),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-tool-policy', fakeProviderSettings(baseUrl))
      const firstClient = new Client(harness.app)
      const secondClient = new Client(harness.app)
      const firstUser = await registerUser(firstClient, 'agent-tool-policy-a@example.com')
      await registerUser(secondClient, 'agent-tool-policy-b@example.com')

      const planned = await firstClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张、线上 0 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      const ledgerAction = planned.json.actionRequests[0]
      const secondPeriod = (await secondClient.get('/api/v1/ledger/periods')).json.find((period: any) => period.monthLabel === '3月')
      const crossWorkspacePayload = {
        ...ledgerAction.payload,
        ledgerPeriodId: secondPeriod.id,
      }
      const editedCrossWorkspace = await firstClient.patch(`/api/v1/agent/action-requests/${ledgerAction.id}`, {
        payload: crossWorkspacePayload,
      })
      expect(editedCrossWorkspace.statusCode).toBe(200)
      const rejectedCrossWorkspace = await firstClient.post(`/api/v1/agent/action-requests/${ledgerAction.id}/confirm`)
      expect(rejectedCrossWorkspace.statusCode).toBe(403)

      const plannedForDerived = await firstClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 B 线下 1 张、线上 0 张入账',
      })
      expect(plannedForDerived.statusCode).toBe(200)
      const confirmedForDerived = await firstClient.post(`/api/v1/agent/action-requests/${plannedForDerived.json.actionRequests[0].id}/confirm`)
      expect(confirmedForDerived.statusCode).toBe(200)
      const periodId = plannedForDerived.json.navigationEvents[0].route.selectedPeriodId
      const entries = (await firstClient.get(`/api/v1/ledger/entries?periodId=${periodId}`)).json
      const derived = entries.find((entry: any) => entry.entryOrigin === 'derived')
      expect(derived).toBeTruthy()

      const workspace = await harness.db.selectFrom('workspaces').selectAll().where('owner_id', '=', firstUser.id).executeTakeFirstOrThrow()
      const pendingActionId = 'agent-policy-derived-update'
      await harness.db.insertInto('agent_action_requests').values({
        id: pendingActionId,
        thread_id: plannedForDerived.json.threadId,
        run_id: plannedForDerived.json.runId,
        workspace_id: workspace.id,
        user_id: firstUser.id,
        kind: 'ledger.update_entry',
        status: 'pending',
        title: '尝试直接编辑派生提成',
        summary: '这个动作应被 Tool Policy 拒绝。',
        target_label: '派生提成',
        risk_level: 'medium',
        details_json: JSON.stringify([]),
        navigation_json: JSON.stringify({
          type: 'navigation',
          route: { mainTab: 'bookkeeping', secondaryTab: 'entries', selectedPeriodId: periodId },
          focusRecordId: derived.id,
          reason: '定位派生分录。',
        }),
        payload_json: JSON.stringify({
          entryId: derived.id,
          amount: derived.amount,
          allocations: derived.allocations,
        }),
        created_at: new Date().toISOString(),
        executed_at: null,
        error_message: null,
      }).execute()

      const rejectedDerived = await firstClient.post(`/api/v1/agent/action-requests/${pendingActionId}/confirm`)
      expect(rejectedDerived.statusCode).toBe(409)
      await closeHarness(harness)
    })
  })

  it('uses OpenAI-compatible tool calls as the primary model planning protocol', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      const toolNames = new Set(body.tools.map((tool: any) => tool.function.name))
      expect(body.tool_choice).toBe('auto')
      expect(toolNames.has('agent_reply')).toBe(false)
      expect(toolNames.has('ledger_create_member_income')).toBe(true)
      expect(toolNames.has('workspace_publish_release')).toBe(false)
      expect(body.tools.length).toBeLessThanOrEqual(10)
      expect(body.messages[0].content).toContain('tool_calls')
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'ledger_create_member_income',
                arguments: JSON.stringify({
                  monthLabel: '3月',
                  memberName: '成员 A',
                  offlineUnits: 1,
                  onlineUnits: 1,
                }),
              },
            }],
          },
        }],
      }
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-tool-calls', { llmProvider: 'qwen', openaiCompatibleProvider: 'qwen', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-tool-calls@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张、线上 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(176)
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'tool_catalog_ready' &&
        event.data.projectionStrategy === 'progressive_tool_discovery' &&
        event.data.routerReason === 'local-progressive-discovery' &&
        event.data.toolNames.includes('ledger_create_member_income'),
      )).toBe(true)
      await closeHarness(harness)
    })
  })

  it('exposes the model-owned tool catalog without regex intent projection', async () => {
    const names = AGENT_TOOL_CATALOG.map((tool) => tool.function.name)
    expect(names).toEqual(AGENT_TOOL_REGISTRY.map((entry) => entry.name))
    expect(names).toContain('data_query_workspace')
    expect(names).toContain('ledger_create_entry')
    expect(names).toContain('workspace_rename')
    expect(names).toContain('memory_remember')
    expect(names).toContain('account_forbidden')
    expect(names).not.toContain('agent_reply')

    const projection = buildRuntimeToolCatalogProjection()
    expect(projection.strategy).toBe('full_registry')
    expect(projection.toolNames).toEqual(names)
    expect(projection.tools).toEqual(AGENT_TOOL_CATALOG)

    const ledgerProjection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['ledger'] })
    expect(ledgerProjection.strategy).toBe('progressive_tool_discovery')
    expect(ledgerProjection.selectedCapabilities).toEqual(['ledger'])
    expect(ledgerProjection.toolNames).toContain('ledger_create_member_income')
    expect(ledgerProjection.toolNames).toContain('data_query_workspace')
    expect(ledgerProjection.toolNames).toContain('account_forbidden')
    expect(ledgerProjection.toolNames).toContain('ask_user_clarification')
    expect(ledgerProjection.toolNames).not.toContain('ui_navigate')
    expect(ledgerProjection.toolNames).not.toContain('workspace_publish_release')
    expect(ledgerProjection.toolNames).not.toContain('workspace_patch_config')

    const navigationProjection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['navigation'] })
    expect(navigationProjection.toolNames).toContain('ui_navigate')
    expect(navigationProjection.toolNames).toContain('account_forbidden')
    expect(navigationProjection.toolNames).not.toContain('ledger_create_member_income')

    const dataProjection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['data'] })
    expect(dataProjection.toolNames).toContain('data_query_workspace')
    expect(dataProjection.toolNames).not.toContain('workspace_patch_config')

    const draftProjection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['draft'] })
    expect(draftProjection.toolNames).toContain('workspace_patch_config')
    expect(draftProjection.toolNames).toContain('data_query_workspace')
    expect(draftProjection.toolNames).not.toContain('workspace_publish_release')

    const memoryProjection = buildRuntimeToolCatalogProjection({ selectedCapabilities: ['memory'] })
    expect(memoryProjection.toolNames).toContain('memory_remember')
    expect(memoryProjection.toolNames).toContain('account_forbidden')
    expect(memoryProjection.toolNames).toContain('ask_user_clarification')
    expect(memoryProjection.toolNames).not.toContain('ledger_create_entry')

    const restrictedProjection = buildRuntimeToolCatalogProjection({
      selectedCapabilities: [],
      routerReason: 'router-empty-restricted-surface',
    })
    expect(restrictedProjection.strategy).toBe('progressive_tool_discovery')
    expect(restrictedProjection.selectedCapabilities).toEqual([])
    expect(restrictedProjection.toolNames).toEqual(expect.arrayContaining([
      'account_forbidden',
      'ask_user_clarification',
      'data_query_workspace',
      'sandbox_run_code',
    ]))
    expect(restrictedProjection.kernelToolNames).toEqual(expect.arrayContaining([
      'account_forbidden',
      'ask_user_clarification',
      'data_query_workspace',
      'sandbox_run_code',
    ]))
    expect(restrictedProjection.toolNames).not.toContain('workspace_patch_config')
    expect(restrictedProjection.toolNames).not.toContain('ledger_create_member_income')
    expect(restrictedProjection.emptySurfaceStatus).toBe('has_callable_tools')
  })

  it('projects task-relevant tools through local progressive discovery', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      const toolNames = new Set(body.tools.map((tool: any) => tool.function.name))
      expect(body.tool_choice).toBe('auto')
      expect(toolNames.has('ledger_create_member_income')).toBe(true)
      expect(toolNames.has('workspace_publish_release')).toBe(false)
      expect(toolNames.has('workspace_patch_config')).toBe(false)
      expect(toolNames.has('account_forbidden')).toBe(true)
      expect(toolNames.has('ask_user_clarification')).toBe(true)
      expect(toolNames.has('ui_navigate')).toBe(false)
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-tool-router-projection', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-tool-router-projection@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })

      expect(planned.statusCode).toBe(200)
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      const event = planned.json.runEvents.find((item: any) => item.type === 'tool_catalog_ready')
      expect(event.data.projectionStrategy).toBe('progressive_tool_discovery')
      expect(event.data.selectedCapabilities).toEqual([])
      expect(event.data.routerReason).toBe('local-progressive-discovery')
      expect(event.data.toolNames).toContain('ledger_create_member_income')
      expect(event.data.toolNames).not.toContain('workspace_publish_release')
      await closeHarness(harness)
    }, { autoSelectCapabilities: false })
  })

  it('materializes a registered deferred tool and replans instead of executing outside the visible surface', async () => {
    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      const toolNames = body.tools.map((tool: any) => tool.function.name)
      if (planningCalls === 1) {
        expect(toolNames).toContain('data_query_workspace')
        expect(toolNames).toContain('sandbox_run_code')
        expect(toolNames).not.toContain('workspace_publish_release')
        return fakeToolResponse('workspace_publish_release', { createShare: false })
      }

      expect(body.stream).toBe(false)
      expect(toolNames).toContain('workspace_publish_release')
      return fakeToolResponse('workspace_publish_release', { createShare: false })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-deferred-tool-materialize', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-deferred-tool-materialize@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '查看当前工作区数据',
      })

      expect(planned.statusCode).toBe(200)
      expect(planningCalls).toBe(2)
      expect(planned.json.actionRequests[0].kind).toBe('workspace.publish_release')
      expect(planned.json.runEvents.some((item: any) => item.type === 'tool_catalog_materializing')).toBe(true)
      const catalogEvent = planned.json.runEvents.find((item: any) => item.type === 'tool_catalog_ready')
      expect(catalogEvent.data.visibleToolNames).not.toContain('workspace_publish_release')
      expect(catalogEvent.data.materializableToolNames).toContain('workspace_publish_release')
      await closeHarness(harness)
    }, { autoSelectCapabilities: false })
  })

  it('keeps provider tool registry metadata in sync with the catalog', async () => {
    const catalogNames = AGENT_TOOL_CATALOG.map((tool) => tool.function.name)
    const registryNames = AGENT_TOOL_REGISTRY.map((entry) => entry.name)
    expect(registryNames).toEqual(catalogNames)

    const byName = new Map(AGENT_TOOL_REGISTRY.map((entry) => [entry.name, entry]))
    expect(byName.get('ledger_create_entry')).toMatchObject({
      capability: 'ledger',
      riskLevel: 'medium',
      confirmationMode: 'always',
      navigationTarget: 'bookkeeping',
    })
    expect(byName.get('data_query_workspace')).toMatchObject({
      capability: 'data',
      riskLevel: 'read',
      confirmationMode: 'never',
    })
    expect(byName.get('workspace_update_online_factor')).toMatchObject({
      capability: 'draft',
      confirmationMode: 'conditional',
      navigationTarget: 'inputs',
    })
    expect(byName.get('account_forbidden')).toMatchObject({
      capability: 'account',
      riskLevel: 'read',
      confirmationMode: 'never',
    })

    for (const entry of AGENT_TOOL_REGISTRY) {
      if (entry.confirmationMode === 'never') continue
      expect(entry.riskLevel, entry.name).not.toBe('read')
    }
  })

  it('streams OpenAI-compatible tool-call chunks into durable run events', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.stream).toBe(true)
      expect(body.tool_choice).toBe('auto')
      return {
        __stream: [
          { choices: [{ delta: { role: 'assistant' } }] },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_stream_1',
                  type: 'function',
                  function: {
                    name: 'ledger_create_member_income',
                    arguments: '{"monthLabel":"3月","memberName":"成员 A",',
                  },
                }],
              },
            }],
          },
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  function: {
                    arguments: '"offlineUnits":1,"onlineUnits":1}',
                  },
                }],
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ],
      }
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-streaming-tool-calls', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-streaming-tool-calls@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张、线上 1 张入账',
      })

      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(176)
      expect(planned.json.runEvents.some((event: any) => event.type === 'provider_stream_started' && event.data?.provider === 'test-compatible')).toBe(true)
      const streamDeltas = planned.json.runEvents.filter((event: any) => event.type === 'provider_stream_delta')
      expect(streamDeltas.some((event: any) => event.data?.kind === 'tool_call_delta' && event.data?.toolName === 'ledger_create_member_income')).toBe(true)
      expect(streamDeltas.some((event: any) => String(event.data?.argumentsPreview ?? '').includes('onlineUnits'))).toBe(true)
      expect(planned.json.runEvents.some((event: any) => event.type === 'provider_stream_completed' && event.data?.toolCallCount === 1)).toBe(true)
      await closeHarness(harness)
    })
  })

  it('retries malformed streamed tool-call arguments as a non-stream provider call', async () => {
    const planningStreams: Array<unknown> = []
    await withFakeOpenAICompatibleProvider((body) => {
      planningStreams.push(body.stream)
      if (planningStreams.length === 1) {
        return {
          __stream: [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_malformed',
                    type: 'function',
                    function: {
                      name: 'ledger_create_member_income',
                      arguments: '{"monthLabel":"3月"',
                    },
                  }],
                },
              }],
            },
          ],
        }
      }
      expect(body.stream).toBe(false)
      expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['ledger_create_member_income'])
      expect(body.tool_choice).toBe('auto')
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-streaming-tool-call-retry', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-streaming-tool-call-retry@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })

      expect(planned.statusCode).toBe(200)
      expect(planningStreams).toEqual([true, false])
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(88)
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'provider_retrying' &&
        event.data?.errorKind === 'provider_response_error' &&
        event.data?.retryStream === false &&
        event.data?.retryTool === 'ledger_create_member_income',
      )).toBe(true)
      await closeHarness(harness)
    })
  })

  it('uses an extended provider budget for complex structured planning turns', async () => {
    const planningTokenBudgets: number[] = []
    const budgetPlan = {
      workspaceName: '复杂经营模型预算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68 },
      shareholders: [{ name: '股东 A', investmentAmount: 100000, dividendRate: 1 }],
      memberSegments: [{ label: '成员', namePrefix: '成员', count: 50, monthlyBasePay: 1000, commissionRate: 0.1, offlineUnitsPerEvent: 5, onlineUnitsPerEvent: 2 }],
      employees: [{ role: '运营', count: 1, monthlyBasePay: 10000 }],
      monthlyFixedCosts: [{ name: '房租', amount: 10000 }],
      perEventCosts: [{ name: '场地', amount: 1000 }],
      perUnitCosts: [{ name: '物料', amount: 6 }],
      months: Array.from({ length: 12 }, (_, index) => ({
        monthIndex: index + 1,
        events: index === 0 ? 0 : 4,
        salesMultiplier: index === 0 ? 0 : 1,
        onlineSalesFactor: 0.35,
      })),
    }
    await withFakeOpenAICompatibleProvider((body) => {
      planningTokenBudgets.push(body.max_tokens)
      expect(body.stream).toBe(false)
      return fakeToolResponse('workspace_configure_operating_model', { plan: budgetPlan })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-complex-provider-budget', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentProviderRequestTimeoutMs: 10_000,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-complex-provider-budget@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: [
          '请规划一个复杂经营模型。',
          '1. 50 个成员。',
          '2. 多个股东。',
          '3. 多类员工。',
          '4. 固定成本。',
          '5. 每场成本。',
          '6. 每张成本。',
          '7. 12 个月预测。',
          '8. 需要计算总收入、总成本、总利润。',
        ].join('\n'),
      })

      expect(planned.statusCode).toBe(200)
      expect(planningTokenBudgets).toEqual([48000])
      const stableMode = planned.json.runEvents.find((event: any) => event.type === 'provider_stable_long_tool_mode')
      expect(stableMode?.data).toMatchObject({
        toolName: 'workspace_configure_operating_model',
        stream: false,
        maxTokens: 48000,
        requestTimeoutMs: 360_000,
      })
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'tool_catalog_ready' &&
        event.data?.projectionStrategy === 'progressive_tool_discovery' &&
        event.data?.toolCount <= 10 &&
        event.data?.toolNames.includes('workspace_configure_operating_model'),
      )).toBe(true)
      await closeHarness(harness)
    })
  })

  it('retries streamed tool-call timeouts as non-stream selected-tool planning', async () => {
    const planningStreams: Array<unknown> = []
    await withFakeOpenAICompatibleProvider((body) => {
      planningStreams.push(body.stream)
      if (planningStreams.length === 1) {
        return {
          __stream: [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_timeout',
                    type: 'function',
                    function: {
                      name: 'ledger_create_member_income',
                      arguments: '{"monthLabel":"3月"',
                    },
                  }],
                },
              }],
            },
          ],
          delayMs: 150,
        }
      }
      expect(body.stream).toBe(false)
      expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['ledger_create_member_income'])
      expect(body.tool_choice).toBe('auto')
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-streaming-tool-call-timeout-retry', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentProviderRequestTimeoutMs: 50,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-streaming-tool-call-timeout-retry@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })

      expect(planned.statusCode).toBe(200)
      expect(planningStreams).toEqual([true, false])
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(88)
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'provider_retrying' &&
        event.data?.retryStream === false &&
        event.data?.retryTool === 'ledger_create_member_income',
      )).toBe(true)
      await closeHarness(harness)
    }, { capabilities: ['ledger'] })
  })

  it('omits tool_choice when an OpenAI-compatible provider rejects that parameter', async () => {
    const planningRequests: Array<{ stream: unknown; toolChoice: unknown; toolNames: string[] }> = []
    await withFakeOpenAICompatibleProvider((body) => {
      planningRequests.push({
        stream: body.stream,
        toolChoice: body.tool_choice,
        toolNames: body.tools.map((tool: any) => tool.function.name),
      })
      if (planningRequests.length === 1) {
        return {
          __stream: [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_malformed',
                    type: 'function',
                    function: {
                      name: 'workspace_configure_operating_model',
                      arguments: '{"plan":{"workspaceName":"星河"',
                    },
                  }],
                },
              }],
            },
          ],
        }
      }
      if (planningRequests.length === 2) {
        expect(body.stream).toBe(false)
        expect(body.tool_choice).toBe('auto')
        expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['workspace_configure_operating_model'])
        return {
          __statusCode: 400,
          body: {
            error: {
              message: 'deepseek-reasoner does not support this tool_choice',
              type: 'invalid_request_error',
            },
          },
        }
      }
      expect(body.stream).toBe(false)
      expect(body.tool_choice).toBeUndefined()
      expect(body.tools.map((tool: any) => tool.function.name)).toEqual(['workspace_configure_operating_model'])
      return fakeToolResponse('workspace_configure_operating_model', {
        plan: {
          workspaceName: '星河 50 期启动测算',
          planning: { startMonth: 3, horizonMonths: 12 },
          operating: { offlineUnitPrice: 88, onlineUnitPrice: 68, polaroidLossRate: 0.06 },
          shareholders: [
            { name: '股东 A', investmentAmount: 300000, dividendRate: 0.35 },
            { name: '股东 B', investmentAmount: 200000, dividendRate: 0.25 },
          ],
          memberSegments: [
            { label: '核心成员', namePrefix: '成员', count: 2, monthlyBasePay: 2500, commissionRate: 0.12, perEventTravelCost: 35, offlineUnitsPerEvent: 18, onlineUnitsPerEvent: 6 },
          ],
          employees: [{ role: '运营', count: 1, monthlyBasePay: 18000 }],
          monthlyFixedCosts: [{ name: '排练室和办公场地', amount: 45000 }],
          perEventCosts: [{ name: '场地执行成本', amount: 6000 }],
          perUnitCosts: [{ name: '物料消耗', amount: 6 }],
          months: Array.from({ length: 12 }, (_, index) => ({
            monthIndex: index + 1,
            events: index === 0 ? 0 : 4,
            salesMultiplier: index === 0 ? 0 : 1,
            onlineSalesFactor: 0.35,
          })),
        },
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-tool-choice-unsupported-retry', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'deepseek',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-tool-choice-unsupported-retry@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '按 12 个月经营简报生成模型。',
      })

      expect(planned.statusCode).toBe(200)
      expect(planningRequests.map((request) => request.stream)).toEqual([true, false, false])
      expect(planningRequests.at(-1)?.toolChoice).toBeUndefined()
      expect(planned.json.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(planned.json.actionRequests[0].payload.workspaceName).toBe('星河 50 期启动测算')
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'provider_retrying' &&
        event.data?.retryTool === 'workspace_configure_operating_model',
      )).toBe(true)
      await closeHarness(harness)
    }, { capabilities: ['draft'] })
  })

  it('answers basic conversation through direct provider assistant text', async () => {
    let callCount = 0
    await withFakeOpenAICompatibleProvider((body) => {
      callCount += 1
      expect((body.tools ?? []).some((tool: any) => tool.function.name === 'agent_reply')).toBe(false)
      expect(body.messages[0].content).not.toContain('agent_reply')
      return fakeAssistantTextResponse('我是 xox-model Agent OS，可以通过对话驱动测算、调模型、记账、预实分析、版本、分享和锁账；写入前会先给确认卡。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-basic-assistant-text', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-basic-assistant-text@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '告诉我你是谁',
      })
      expect(planned.statusCode).toBe(200)
      expect(callCount).toBe(1)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(0)
      expect(planned.json.planSteps).toHaveLength(0)
      expect(planned.json.messages.at(-1).content).toContain('xox-model Agent OS')
      const visibleTimeline = planned.json.timelineItems.filter((item: any) => item.visibility === 'user')
      expect(visibleTimeline.map((item: any) => item.kind)).toEqual(['user_message', 'assistant_message'])
      expect(JSON.stringify(visibleTimeline)).not.toContain('正在规划下一步')
      expect(JSON.stringify(visibleTimeline)).not.toContain('业务步骤已生成')
      await closeHarness(harness)
    }, { turnLane: 'direct_answer' })
  })

  it('does not fall back to regex rules when a write-intent provider reply has no tool call', async () => {
    let callCount = 0
    await withFakeOpenAICompatibleProvider(() => {
      callCount += 1
      return fakeAssistantTextResponse('我可以帮你记账，但这不是 tool call。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-assistant-text-no-rules', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-assistant-text-no-rules@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(callCount).toBe(2)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(0)
      expect(planned.json.planSteps).toHaveLength(0)
      expect(planned.json.messages.at(-1).content).toContain('缺少必要的工具调用或确认卡')
      expect(planned.json.runEvents.some((event: any) => event.type === 'tool_loop_guardrail' && event.status === 'failed')).toBe(true)
      const entries = await client.get(`/api/v1/ledger/entries?periodId=${(await client.get('/api/v1/ledger/periods')).json[0].id}`)
      expect(entries.json).toHaveLength(0)
      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('surfaces provider authentication failures instead of reporting them as missing tool calls', async () => {
    await withFakeOpenAICompatibleProvider(() => ({
      __statusCode: 401,
      body: { error: { message: 'invalid api key' } },
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-provider-auth-failure', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'wrong-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-provider-auth-failure@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(0)
      expect(planned.json.planSteps[0].status).toBe('failed')
      expect(planned.json.messages.map((message: any) => message.role)).toEqual(['user'])
      expect(planned.json.planSteps[0].description).toContain('认证失败')
      expect(planned.json.planSteps[0].description).toContain('HTTP 401')
      await closeHarness(harness)
    })
  })

  it('does not fall back to regex rules when a model provider is selected without a key', async () => {
    const harness = await buildHarness('agent-provider-without-key', {
      llmProvider: 'deepseek',
      openaiCompatibleApiKey: null,
    })
    const client = new Client(harness.app)
    await registerUser(client, 'agent-provider-without-key@example.com')

    const planned = await client.post('/api/v1/agent/messages', {
      message: '把 3 月成员 A 线下 1 张入账',
    })
    expect(planned.statusCode).toBe(200)
    expect(planned.json.planner).toBe('openai_compatible_tool_calls')
    expect(planned.json.actionRequests).toHaveLength(0)
    expect(planned.json.planSteps[0].status).toBe('failed')
    expect(planned.json.messages.map((message: any) => message.role)).toEqual(['user'])
    expect(planned.json.planSteps[0].description).toContain('API key')
    await closeHarness(harness)
  })

  it('uses tenant-scoped user provider settings without returning API keys', async () => {
    let callCount = 0
    let lastAuthorization = ''
    await withFakeOpenAICompatibleProvider((body, request) => {
      callCount += 1
      lastAuthorization = String(request.headers.authorization ?? '')
      expect(body.model).toBe('fake-user-model')
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-user-provider-setting', {
        llmProvider: 'deepseek',
        openaiCompatibleProvider: 'env-compatible',
        openaiCompatibleBaseUrl: 'https://example.invalid',
        openaiCompatibleApiKey: null,
      })
      const firstClient = new Client(harness.app)
      const secondClient = new Client(harness.app)
      await registerUser(firstClient, 'agent-user-provider-setting-a@example.com')
      await registerUser(secondClient, 'agent-user-provider-setting-b@example.com')

      const saved = await firstClient.put('/api/v1/agent/provider-settings', {
        provider: 'qwen',
        baseUrl,
        model: 'fake-user-model',
        apiKey: 'test-user-provider-key',
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json.setting.provider).toBe('qwen')
      expect(saved.json.setting.hasApiKey).toBe(true)
      expect(JSON.stringify(saved.json)).not.toContain('test-user-provider-key')

      const fetched = await firstClient.get('/api/v1/agent/provider-settings')
      expect(fetched.json.setting.model).toBe('fake-user-model')
      expect(JSON.stringify(fetched.json)).not.toContain('test-user-provider-key')

      const updatedWithoutKey = await firstClient.put('/api/v1/agent/provider-settings', {
        provider: 'qwen',
        baseUrl,
        model: 'fake-user-model',
      })
      expect(updatedWithoutKey.statusCode).toBe(200)
      expect(updatedWithoutKey.json.setting.hasApiKey).toBe(true)
      expect(JSON.stringify(updatedWithoutKey.json)).not.toContain('test-user-provider-key')

      const secondUserSetting = await secondClient.get('/api/v1/agent/provider-settings')
      expect(secondUserSetting.statusCode).toBe(200)
      expect(secondUserSetting.json.setting).toBeNull()
      expect((await secondClient.delete('/api/v1/agent/provider-settings')).statusCode).toBe(200)
      expect((await firstClient.get('/api/v1/agent/provider-settings')).json.setting).not.toBeNull()

      const planned = await firstClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(callCount).toBe(1)
      expect(lastAuthorization).toBe('Bearer test-user-provider-key')
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.runEvents.some((event: any) => event.type === 'model_planning' && event.data?.provider === 'qwen')).toBe(true)
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')

      const secondPlanned = await secondClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(secondPlanned.statusCode).toBe(200)
      expect(callCount).toBe(1)
      expect(secondPlanned.json.planner).toBe('openai_compatible_tool_calls')
      expect(secondPlanned.json.actionRequests).toHaveLength(0)
      expect(secondPlanned.json.planSteps[0].status).toBe('failed')

      const deleted = await firstClient.delete('/api/v1/agent/provider-settings')
      expect(deleted.statusCode).toBe(200)
      expect((await firstClient.get('/api/v1/agent/provider-settings')).json.setting).toBeNull()
      const afterDelete = await firstClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(afterDelete.statusCode).toBe(200)
      expect(callCount).toBe(1)
      expect(afterDelete.json.actionRequests).toHaveLength(0)
      expect(afterDelete.json.planSteps[0].status).toBe('failed')
      await closeHarness(harness)
    })
  })

  it('probes tenant provider settings with redacted auth and provider-shaped tool calls', async () => {
    const seenRequests: any[] = []
    let lastAuthorization = ''
    await withFakeOpenAICompatibleProvider((body, request) => {
      seenRequests.push(body)
      lastAuthorization = String(request.headers.authorization ?? '')
      expect(body.model).toBe('fake-probe-model')
      expect(body.stream).toBe(false)
      expect(body.tool_choice).toBe('auto')
      expect(body.enable_thinking).toBe(false)
      expect(body.tools.map((item: any) => item.function.name)).toEqual(['xox_provider_probe'])
      return fakeToolResponse('xox_provider_probe', { ok: true })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-provider-probe', {
        llmProvider: 'deepseek',
        openaiCompatibleApiKey: null,
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-provider-probe@example.com')

      const explicitProbe = await client.post('/api/v1/agent/provider-settings/probe', {
        provider: 'qwen',
        baseUrl,
        model: 'fake-probe-model',
        apiKey: 'test-probe-key',
      })
      expect(explicitProbe.statusCode).toBe(200)
      expect(explicitProbe.json.probe.status).toBe('passed')
      expect(explicitProbe.json.probe.checks.find((check: any) => check.name === 'tools').status).toBe('passed')
      expect(JSON.stringify(explicitProbe.json)).not.toContain('test-probe-key')
      expect(lastAuthorization).toBe('Bearer test-probe-key')

      const saved = await client.put('/api/v1/agent/provider-settings', {
        provider: 'qwen',
        baseUrl,
        model: 'fake-probe-model',
        apiKey: 'saved-probe-key',
      })
      expect(saved.statusCode).toBe(200)

      const savedKeyProbe = await client.post('/api/v1/agent/provider-settings/probe', {
        provider: 'qwen',
        baseUrl,
        model: 'fake-probe-model',
      })
      expect(savedKeyProbe.statusCode).toBe(200)
      expect(savedKeyProbe.json.probe.status).toBe('passed')
      expect(JSON.stringify(savedKeyProbe.json)).not.toContain('saved-probe-key')
      expect(lastAuthorization).toBe('Bearer saved-probe-key')
      expect(seenRequests).toHaveLength(2)

      await closeHarness(harness)
    })
  })

  it('encrypts tenant provider API keys at rest while preserving runtime tool calls', async () => {
    let lastAuthorization = ''
    await withFakeOpenAICompatibleProvider((body, request) => {
      lastAuthorization = String(request.headers.authorization ?? '')
      expect(body.model).toBe('encrypted-user-model')
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-encrypted-provider-setting', {
        llmProvider: 'deepseek',
        openaiCompatibleApiKey: null,
        agentProviderKeyEncryptionSecret: 'test-provider-key-encryption-secret',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-encrypted-provider-setting@example.com')

      const saved = await client.put('/api/v1/agent/provider-settings', {
        provider: 'doubao',
        baseUrl,
        model: 'encrypted-user-model',
        apiKey: 'test-encrypted-provider-key',
      })
      expect(saved.statusCode).toBe(200)
      expect(JSON.stringify(saved.json)).not.toContain('test-encrypted-provider-key')

      const stored = await harness.db
        .selectFrom('agent_provider_settings')
        .selectAll()
        .executeTakeFirstOrThrow()
      expect(stored.api_key).not.toBe('test-encrypted-provider-key')
      expect(stored.api_key.startsWith('enc:v1:')).toBe(true)

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(lastAuthorization).toBe('Bearer test-encrypted-provider-key')
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      await closeHarness(harness)
    })
  })

  it('keeps legacy plaintext tenant provider keys readable after encryption is enabled', async () => {
    let lastAuthorization = ''
    await withFakeOpenAICompatibleProvider((_body, request) => {
      lastAuthorization = String(request.headers.authorization ?? '')
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-legacy-provider-setting', {
        llmProvider: 'deepseek',
        openaiCompatibleApiKey: null,
        agentProviderKeyEncryptionSecret: 'test-provider-key-encryption-secret',
      })
      const client = new Client(harness.app)
      const registered = await registerUser(client, 'agent-legacy-provider-setting@example.com')
      const workspace = await harness.db.selectFrom('workspaces').selectAll().where('owner_id', '=', registered.id).executeTakeFirstOrThrow()
      const now = new Date().toISOString()
      await harness.db.insertInto('agent_provider_settings').values({
        id: 'legacy-provider-setting',
        workspace_id: workspace.id,
        user_id: registered.id,
        provider: 'qwen',
        base_url: baseUrl,
        model: 'legacy-user-model',
        api_key: 'legacy-plaintext-provider-key',
        created_at: now,
        updated_at: now,
      }).execute()

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(lastAuthorization).toBe('Bearer legacy-plaintext-provider-key')
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')

      const updated = await client.put('/api/v1/agent/provider-settings', {
        provider: 'qwen',
        baseUrl,
        model: 'legacy-user-model-v2',
      })
      expect(updated.statusCode).toBe(200)
      const migrated = await harness.db
        .selectFrom('agent_provider_settings')
        .selectAll()
        .where('id', '=', 'legacy-provider-setting')
        .executeTakeFirstOrThrow()
      expect(migrated.api_key).not.toBe('legacy-plaintext-provider-key')
      expect(migrated.api_key.startsWith('enc:v1:')).toBe(true)
      await closeHarness(harness)
    })
  })

  it('answers read-only data questions only through a model-selected data tool call', async () => {
    const requests: any[] = []
    const finalizerRequests: any[] = []
    await withFakeOpenAICompatibleProvider((body) => {
      requests.push(body)
      expect(body.tools.some((tool: any) => tool.function.name === 'data_query_workspace')).toBe(true)
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost', 'plannedProfit'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-data-query', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'deepseek',
        openaiCompatibleModel: 'deepseek-v4-pro',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-data-query@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '3 月计划收入和计划成本是多少？',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.planner).toBe('openai_compatible_tool_calls')
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps[0].status).toBe('executed')
      expect(response.json.navigationEvents[0].route.mainTab).toBe('dashboard')
      expect(response.json.messages.at(-1).content).toContain('3月计划收入')
      expect(response.json.messages.at(-1).content).toContain('计划成本')
      expect(response.json.messages.at(-1).content).not.toContain('本次只读取当前工作区数据')
      expect(response.json.runEvents.some((event: any) => event.type === 'observation_continuation_requested')).toBe(true)
      expect(response.json.runEvents.some((event: any) => event.type === 'model_continuation')).toBe(false)
      expect(requests).toHaveLength(1)
      expect(finalizerRequests).toHaveLength(0)
      const visibleNodes = flattenTranscriptNodes(response.json.transcriptNodes).filter((node: any) => node.visibility === 'user')
      const assistantNode = visibleNodes.find((node: any) => node.kind === 'assistant_message')
      expect(assistantNode?.content ?? assistantNode?.summary).toContain('3月计划收入')
      expect(response.json.planSteps[0].description).toContain('plannedRevenue')
      expect(response.json.planSteps[0].description).not.toContain('3月计划收入 ¥')
      await closeHarness(harness)
    }, {
      finalizerResponse: (body) => {
        finalizerRequests.push(body)
        return fakeObservationFinalizerResponse(body)
      },
    })
  })

  it('answers ambient date questions through direct_answer without goal/tool context', async () => {
    const directRequests: any[] = []
    await withFakeOpenAICompatibleProvider((body) => {
      directRequests.push(body)
      expect(body.tools ?? []).toEqual([])
      const requestText = JSON.stringify(body)
      expect(requestText).toContain('agent_ambient_context')
      expect(body.messages.some((message: any) =>
        typeof message?.content === 'string' &&
        message.content.includes('"authority":"ambient"') &&
        message.content.includes('"source":"agent_ambient_context"'),
      )).toBe(true)
      expect(requestText).not.toContain('teamMembers')
      expect(requestText).not.toContain('writableConfig')
      expect(requestText).not.toContain('tenantScopedMemory')
      return fakeAssistantTextResponse('今天是 2026 年 6 月 1 日。')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-direct-date', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'deepseek',
        openaiCompatibleModel: 'deepseek-v4-pro',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-direct-date@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '今天是几月几号？',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.planner).toBe('openai_compatible_tool_calls')
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps).toHaveLength(0)
      expect(response.json.messages.at(-1).content).toContain('今天是 2026 年 6 月 1 日')
      expect(directRequests).toHaveLength(1)

      const eventTypes = response.json.runEvents.map((event: any) => event.type)
      expect(eventTypes).toContain('turn_intake_resolved')
      expect(eventTypes).toContain('assistant_final_message')
      expect(eventTypes).not.toContain('goal_contract_created')
      expect(eventTypes).not.toContain('model_planning')
      expect(eventTypes).not.toContain('tool_catalog_ready')
      expect(eventTypes).not.toContain('goal_evaluated')
      expect(response.json.runEvents.every((event: any) => ['assistant', 'tool', 'lifecycle'].includes(event.channel))).toBe(true)
      expect(response.json.runEvents.find((event: any) => event.type === 'assistant_final_message')?.channel).toBe('assistant')

      const goals = await harness.db.selectFrom('agent_goals').selectAll().where('run_id', '=', response.json.runId).execute()
      const evaluations = await harness.db.selectFrom('agent_evaluations').selectAll().where('run_id', '=', response.json.runId).execute()
      expect(goals).toHaveLength(0)
      expect(evaluations).toHaveLength(0)

      const visibleKinds = flattenTranscriptNodes(response.json.transcriptNodes)
        .filter((node: any) => node.visibility === 'user')
        .map((node: any) => node.kind)
      expect(visibleKinds).toEqual(['user_message', 'assistant_message'])
      await closeHarness(harness)
    }, { turnLane: 'direct_answer' })
  })

  it('answers English ambient date questions through the same direct_answer lane', async () => {
    const directRequests: any[] = []
    await withFakeOpenAICompatibleProvider((body) => {
      directRequests.push(body)
      expect(body.tools ?? []).toEqual([])
      const requestText = JSON.stringify(body)
      expect(requestText).toContain('agent_ambient_context')
      expect(requestText).not.toContain('teamMembers')
      expect(requestText).not.toContain('writableConfig')
      expect(requestText).not.toContain('tenantScopedMemory')
      return fakeAssistantTextResponse('Today is June 1, 2026.')
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-direct-date-english', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'deepseek',
        openaiCompatibleModel: 'deepseek-v4-pro',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-direct-date-english@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: 'What date is it today?',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps).toHaveLength(0)
      expect(response.json.messages.at(-1).content).toContain('June 1, 2026')
      expect(directRequests).toHaveLength(1)
      expect(response.json.runEvents.map((event: any) => event.type)).not.toContain('model_planning')
      await closeHarness(harness)
    }, { turnLane: 'direct_answer' })
  })

  it('does not accept assistant text that claims a write confirmation without a tool call', async () => {
    let planningRequests = 0
    await withFakeOpenAICompatibleProvider((body) => {
      const toolNames = Array.isArray(body?.tools)
        ? body.tools.map((tool: any) => tool?.function?.name ?? tool?.name)
        : []
      expect(toolNames.some((name: string) => name.startsWith('ledger_'))).toBe(true)
      planningRequests += 1
      if (planningRequests === 1) {
        return fakeAssistantTextResponse('已为你生成记账确认卡，请确认。')
      }
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-fake-confirmation-text', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'deepseek',
        openaiCompatibleModel: 'deepseek-v4-pro',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-fake-confirmation-text@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账，只生成确认卡',
      })
      expect(response.statusCode).toBe(200)
      expect(planningRequests).toBeGreaterThanOrEqual(2)
      expect(response.json.actionRequests).toHaveLength(1)
      expect(response.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(response.json.runEvents.some((event: any) =>
        event.type === 'goal_evaluated' &&
        event.data?.evaluationStatus === 'continue',
      )).toBe(true)
      expect(String(response.json.messages.at(-1)?.content ?? '')).not.toContain('已为你生成记账确认卡')
      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('answers read-only tool observations through the main loop instead of a finalizer-only path', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.tools.some((tool: any) => tool.function.name === 'data_query_workspace')).toBe(true)
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-observation-continuation-failure', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-observation-continuation-failure@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '3 月计划收入和计划成本是多少？',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(response.json.planSteps.map((step: any) => step.status)).toEqual(['executed'])
      expect(response.json.messages.at(-1).content).toContain('3月计划收入')
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.evaluations.at(-1).status).toBe('pass')
      expect(response.json.runEvents.some((event: any) => event.type === 'observation_continuation_requested')).toBe(true)
      expect(response.json.runEvents.some((event: any) => event.type === 'model_continuation_failed')).toBe(false)
      await closeHarness(harness)
    })
  })

  it('normalizes month-scoped data tool arguments to a period summary', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.tools.some((tool: any) => tool.function.name === 'data_query_workspace')).toBe(true)
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'workspace_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-data-query-normalized-period', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-data-query-normalized-period@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '3 月计划收入和计划成本是多少？',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.navigationEvents[0].route.mainTab).toBe('dashboard')
      expect(response.json.messages.at(-1).content).toContain('3月计划收入')
      expect(response.json.messages.at(-1).content).toContain('计划成本')
      expect(response.json.messages.at(-1).content).not.toContain('基准场景总收入')
      await closeHarness(harness)
    })
  })

  it('answers team member count through a model-selected data tool call', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      const dataTool = body.tools.find((tool: any) => tool.function.name === 'data_query_workspace')
      expect(dataTool).toBeTruthy()
      expect(dataTool.function.parameters.properties.scope.enum).toContain('team_summary')
      expect(dataTool.function.parameters.properties.metrics.items.enum).toContain('teamMemberCount')
      return fakeToolResponse('data_query_workspace', {
        question: '我们有几个成员',
        scope: 'team_summary',
        metrics: ['teamMemberCount', 'teamMemberNames'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-team-member-count', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-team-member-count@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '我们有几个成员？',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.planner).toBe('openai_compatible_tool_calls')
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps[0].status).toBe('executed')
      expect(response.json.navigationEvents[0].route.secondaryTab).toBe('members')
      expect(response.json.messages.at(-1).content).toContain('共有 7 个成员')
      expect(response.json.messages.at(-1).content).toContain('成员 A')
      await closeHarness(harness)
    })
  })

  it('exposes current business entities through a read-only entity summary tool call', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      const dataTool = body.tools.find((tool: any) => tool.function.name === 'data_query_workspace')
      expect(dataTool).toBeTruthy()
      expect(dataTool.function.parameters.properties.scope.enum).toContain('entity_summary')
      expect(dataTool.function.parameters.properties.metrics.items.enum).toContain('shareholderInvestments')
      return fakeToolResponse('data_query_workspace', {
        question: '先看看当前成员和股东',
        scope: 'entity_summary',
        metrics: ['teamMemberNames', 'shareholderNames', 'shareholderInvestments'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-entity-summary-read', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-entity-summary-read@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '先看看当前成员和股东都有谁',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps[0].toolName).toBe('data_query_workspace')
      expect(response.json.planSteps[0].description).toContain('"scope": "entity_summary"')
      expect(response.json.planSteps[0].description).toContain('"shareholders"')
      expect(response.json.navigationEvents[0].route).toMatchObject({ mainTab: 'inputs', secondaryTab: 'capital' })
      expect(response.json.messages.at(-1).content).toContain('股东')
      await closeHarness(harness)
    })
  })

  it('feeds read observations back into repair planning so the model can inspect then write', async () => {
    let planningCalls = 0
    let secondPlanningBody: any = null
    const finalizerRequests: any[] = []

    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        expect(body.messages.some((message: any) => message.role === 'tool')).toBe(false)
        return fakeToolResponse('data_query_workspace', {
          question: '检查当前股东和投资额',
          scope: 'entity_summary',
          metrics: ['shareholderNames', 'shareholderInvestments'],
        })
      }

      secondPlanningBody = body
      const toolMessages = body.messages.filter((message: any) => message.role === 'tool')
      expect(toolMessages.some((message: any) => String(message.content).includes('"scope":"entity_summary"'))).toBe(true)
      expect(JSON.stringify(toolMessages)).toContain('shareholders')
      return fakeToolResponse('workspace_patch_config', {
        patches: [
          { path: 'shareholders[0].investmentAmount', value: 1065000, label: '股东 1 投资额' },
        ],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-observation-driven-planning-loop', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-observation-driven-planning-loop@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '帮我第一个股东注资100w',
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      expect(planningCalls).toBeGreaterThanOrEqual(2)
      expect(secondPlanningBody).toBeTruthy()
      expect(finalizerRequests).toHaveLength(1)
      expect(response.json.actionRequests).toHaveLength(1)
      expect(response.json.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(response.json.actionRequests[0].status).toBe('executed')
      expect(response.json.actionRequests[0].payload.config.shareholders[0].investmentAmount).toBe(1065000)
      expect(response.json.planSteps.map((step: any) => step.toolName)).toContain('data_query_workspace')
      expect(response.json.planSteps.some((step: any) => step.actionRequestId === response.json.actionRequests[0].id)).toBe(true)
      expect(response.json.runEvents.filter((event: any) => event.type === 'memory_recall_started')).toHaveLength(1)
      expect(response.json.runEvents.some((event: any) => event.type === 'action_auto_executed')).toBe(true)
      expect(response.json.messages.at(-1).content).toContain('已自动执行')
      await closeHarness(harness)
    }, {
      capabilities: ['data', 'draft'],
      requiredActionCapabilities: ['draft'],
      finalizerResponse: (body) => {
        finalizerRequests.push(body)
        return fakeAssistantTextResponse('已检查当前股东并按高自动化已自动执行：把第一个股东投资额追加 100 万。')
      },
      observationContinuationResponse: false,
    })
  })

  it('fails closed when the repair loop is exhausted without satisfying the goal', async () => {
    await withFakeOpenAICompatibleProvider(() => {
      return fakeToolResponse('data_query_workspace', {
        question: '我们几个月才能回本',
        scope: 'workspace_summary',
        metrics: ['payback'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-repair-loop-exhaustion', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-repair-loop-exhaustion@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '我们几个月才能回本？然后帮我第一个股东注资100w',
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.json.runEvents.filter((event: any) => event.type === 'goal_iteration_started')).toHaveLength(5)
      expect(state.json.runs[0].status).toBe('failed')
      expect(state.json.goals[0].status).toBe('failed')
      expect(state.json.runEvents.some((event: any) => event.type === 'goal_iteration_exhausted')).toBe(true)
      expect(state.json.runEvents.some((event: any) => event.type === 'run_failed')).toBe(true)
      expect(state.json.runEvents.some((event: any) => event.type === 'run_completed')).toBe(false)
      expect(response.json.messages.at(-1).content).toContain('这轮没有完成所有目标')
      await closeHarness(harness)
    }, { capabilities: ['data', 'draft'], requiredActionCapabilities: ['draft'] })
  })

  it('asks for clarification through a model-selected tool when required business details are missing', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.tools.some((tool: any) => tool.function.name === 'ask_user_clarification')).toBe(true)
      return fakeToolResponse('ask_user_clarification', {
        question: '请补充要记账的月份、成员以及线下/线上张数。',
        missingFields: ['monthLabel', 'memberName', 'offlineUnits', 'onlineUnits'],
        suggestions: ['例如：3 月成员 A 线下 1 张、线上 0 张'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-clarification-tool', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-clarification-tool@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '帮我记一笔收入',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json.planner).toBe('openai_compatible_tool_calls')
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps[0].title).toBe('需要补充信息')
      expect(response.json.planSteps[0].status).toBe('info')
      expect(response.json.messages.at(-1).content).toContain('请补充要记账的月份')
      expect(response.json.messages.at(-1).content).toContain('monthLabel')
      await closeHarness(harness)
    })
  })

  it('starts background agent runs immediately and recovers completed model results from thread state', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async (body) => {
      expect(body.tools.some((tool: any) => tool.function.name === 'data_query_workspace')).toBe(true)
      await providerGate
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-background-run', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-background-run@example.com')

      const started = await client.post('/api/v1/agent/messages', {
        message: '3 月计划收入和计划成本是多少？',
        background: true,
      })
      expect(started.statusCode).toBe(200)
      expect(started.json.status).toBe('running')
      expect(started.json.planner).toBeNull()
      expect(started.json.messages.map((message: any) => message.role)).toEqual(['user'])
      expect(started.json.actionRequests).toHaveLength(0)
      expect(started.json.runEvents.map((event: any) => event.type)).toEqual(['run_queued'])

      const runningState = await client.get(`/api/v1/agent/threads/${started.json.threadId}`)
      expect(runningState.statusCode).toBe(200)
      expect(runningState.json.runs[0].status).toBe('running')
      expect(runningState.json.messages.map((message: any) => message.role)).toEqual(['user'])
      expect(runningState.json.runEvents.some((event: any) => event.type === 'run_queued')).toBe(true)

      releaseProvider()
      let completedState = runningState.json
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(25)
        const nextState = await client.get(`/api/v1/agent/threads/${started.json.threadId}`)
        completedState = nextState.json
        if (completedState.runs[0].status === 'completed') break
      }

      expect(completedState.runs[0].status).toBe('completed')
      expect(completedState.runs[0].planner).toBe('openai_compatible_tool_calls')
      expect(completedState.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(completedState.messages.at(-1).content).toContain('3月计划收入')
      expect(completedState.planSteps[0].status).toBe('executed')
      expect(completedState.navigationEvents[0].route.mainTab).toBe('dashboard')
      expect(completedState.actionRequests).toHaveLength(0)
      expect(completedState.runEvents.map((event: any) => event.type)).toEqual(
        expect.arrayContaining(['run_queued', 'worker_claimed', 'model_planning', 'tool_plan_ready', 'run_completed']),
      )

      const threads = await client.get('/api/v1/agent/threads')
      expect(threads.json.threads[0].latestRunStatus).toBe('completed')
      expect(threads.json.threads[0].planner).toBe('openai_compatible_tool_calls')
      await closeHarness(harness)
    })
  })

  it('cancels running agent runs and prevents late model results from leaving pending actions', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async () => {
      await providerGate
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-cancel-running-run', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-cancel-running-run@example.com')

      const started = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
        background: true,
      })
      expect(started.statusCode).toBe(200)
      expect(started.json.status).toBe('running')

      const cancelled = await client.post(`/api/v1/agent/runs/${started.json.runId}/cancel`)
      expect(cancelled.statusCode).toBe(200)
      expect(cancelled.json.runs[0].status).toBe('cancelled')
      expect(cancelled.json.messages.at(-1).content).toContain('已取消当前 Agent 运行')
      expect(cancelled.json.actionRequests.filter((action: any) => action.status === 'pending')).toHaveLength(0)
      expect(cancelled.json.runEvents.some((event: any) => event.type === 'run_cancelled')).toBe(true)

      releaseProvider()
      let finalState = cancelled.json
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(25)
        const nextState = await client.get(`/api/v1/agent/threads/${started.json.threadId}`)
        finalState = nextState.json
        if (finalState.runs[0].status !== 'running') break
      }

      expect(finalState.runs[0].status).toBe('cancelled')
      expect(finalState.actionRequests.filter((action: any) => action.status === 'pending')).toHaveLength(0)
      expect(finalState.actionRequests.every((action: any) => action.status !== 'executed')).toBe(true)
      const threads = await client.get('/api/v1/agent/threads')
      expect(threads.json.threads[0].latestRunStatus).toBe('cancelled')
      expect(threads.json.threads[0].pendingActionCount).toBe(0)
      await closeHarness(harness)
    })
  })

  it('does not recover running agent runs leased by another active worker', async () => {
    let providerCalls = 0
    await withFakeOpenAICompatibleProvider(() => {
      providerCalls += 1
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-recover-active-lease', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentWorkerId: 'current-worker',
      })
      const client = new Client(harness.app)
      const user = await registerUser(client, 'agent-recover-active-lease@example.com')
      const futureLease = new Date(Date.now() + 60_000).toISOString()
      const run = await insertRunningAgentRun(harness.db, user.id, {
        suffix: 'active-lease',
        message: '3 月计划收入是多少？',
        workerId: 'other-worker',
        leaseExpiresAt: futureLease,
        heartbeatAt: new Date().toISOString(),
      })

      await recoverRunningAgentRuns(harness.db, harness.settings)
      await sleep(50)

      expect(providerCalls).toBe(0)
      const state = await client.get(`/api/v1/agent/threads/${run.threadId}`)
      expect(state.statusCode).toBe(200)
      expect(state.json.runs[0].status).toBe('running')
      expect(state.json.messages.map((message: any) => message.role)).toEqual(['user'])
      expect(state.json.planSteps).toHaveLength(0)
      const row = await harness.db.selectFrom('agent_runs').select(['worker_id', 'lease_expires_at']).where('id', '=', run.runId).executeTakeFirstOrThrow()
      expect(row.worker_id).toBe('other-worker')
      expect(row.lease_expires_at).toBe(futureLease)
      await closeHarness(harness)
    })
  })

  it('claims expired leased running agent runs before recovery', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async () => {
      await providerGate
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-recover-expired-lease', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentWorkerId: 'recover-worker',
      })
      const client = new Client(harness.app)
      const user = await registerUser(client, 'agent-recover-expired-lease@example.com')
      const run = await insertRunningAgentRun(harness.db, user.id, {
        suffix: 'expired-lease',
        message: '3 月计划收入和计划成本是多少？',
        workerId: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      })

      await recoverRunningAgentRuns(harness.db, harness.settings)
      const claimed = await harness.db.selectFrom('agent_runs').select(['worker_id', 'lease_expires_at']).where('id', '=', run.runId).executeTakeFirstOrThrow()
      expect(claimed.worker_id).toBe('recover-worker')
      expect(new Date(claimed.lease_expires_at ?? 0).getTime()).toBeGreaterThan(Date.now())

      releaseProvider()
      let completedState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(25)
        const nextState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
        completedState = nextState
        if (completedState.json.runs[0].status === 'completed') break
      }

      expect(completedState.json.runs[0].status).toBe('completed')
      expect(completedState.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(completedState.json.actionRequests).toHaveLength(0)
      await closeHarness(harness)
    })
  })

  it('ignores late provider results after a background worker loses its run lease', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async () => {
      await providerGate
      return fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-background-lost-lease', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentWorkerId: 'worker-a',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-background-lost-lease@example.com')

      const started = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
        background: true,
      })
      expect(started.statusCode).toBe(200)
      expect(started.json.status).toBe('running')

      const stolenLeaseExpiresAt = new Date(Date.now() + 60_000).toISOString()
      await harness.db
        .updateTable('agent_runs')
        .set({
          worker_id: 'worker-b',
          lease_expires_at: stolenLeaseExpiresAt,
          heartbeat_at: new Date().toISOString(),
        })
        .where('id', '=', started.json.runId)
        .execute()

      releaseProvider()
      await sleep(100)

      const finalState = await client.get(`/api/v1/agent/threads/${started.json.threadId}`)
      expect(finalState.statusCode).toBe(200)
      expect(finalState.json.runs[0].status).toBe('running')
      expect(finalState.json.messages.map((message: any) => message.role)).toEqual(['user'])
      expect(finalState.json.planSteps).toHaveLength(0)
      expect(finalState.json.actionRequests).toHaveLength(0)
      const run = await harness.db.selectFrom('agent_runs').select(['worker_id', 'lease_expires_at']).where('id', '=', started.json.runId).executeTakeFirstOrThrow()
      expect(run.worker_id).toBe('worker-b')
      expect(run.lease_expires_at).toBe(stolenLeaseExpiresAt)
      await closeHarness(harness)
    })
  })

  it('sweeps queued running agent runs without an explicit recovery call', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async () => {
      await providerGate
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-queue-worker-sweep', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
        agentWorkerId: 'queue-worker',
        agentRunWorkerPollMs: 50,
      })
      const client = new Client(harness.app)
      const user = await registerUser(client, 'agent-queue-worker-sweep@example.com')
      const run = await insertRunningAgentRun(harness.db, user.id, {
        suffix: 'queue-sweep',
        message: '3 月计划收入是多少？',
      })

      let claimed = await harness.db.selectFrom('agent_runs').select(['worker_id']).where('id', '=', run.runId).executeTakeFirstOrThrow()
      for (let attempt = 0; attempt < 20 && claimed.worker_id !== 'queue-worker'; attempt += 1) {
        await sleep(25)
        claimed = await harness.db.selectFrom('agent_runs').select(['worker_id']).where('id', '=', run.runId).executeTakeFirstOrThrow()
      }
      expect(claimed.worker_id).toBe('queue-worker')

      releaseProvider()
      let completedState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(25)
        const nextState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
        completedState = nextState
        if (completedState.json.runs[0].status === 'completed') break
      }

      expect(completedState.json.runs[0].status).toBe('completed')
      expect(completedState.json.runs[0].planner).toBe('openai_compatible_tool_calls')
      expect(completedState.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(completedState.json.actionRequests).toHaveLength(0)
      await closeHarness(harness)
    })
  })

  it('recovers safe running agent runs after an API process restart', async () => {
    let releaseProvider!: () => void
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })

    await withFakeOpenAICompatibleProvider(async () => {
      await providerGate
      return fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost'],
      })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-recover-running-run', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      const user = await registerUser(client, 'agent-recover-running-run@example.com')
      const run = await insertRunningAgentRun(harness.db, user.id, {
        suffix: 'recover-running',
        message: '3 月计划收入和计划成本是多少？',
      })

      await recoverRunningAgentRuns(harness.db, harness.settings)
      const runningState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
      expect(runningState.statusCode).toBe(200)
      expect(runningState.json.runs[0].status).toBe('running')
      expect(runningState.json.messages.map((message: any) => message.role)).toEqual(['user'])

      releaseProvider()
      let completedState = runningState.json
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(25)
        const nextState = await client.get(`/api/v1/agent/threads/${run.threadId}`)
        completedState = nextState.json
        if (completedState.runs[0].status === 'completed') break
      }

      expect(completedState.runs[0].status).toBe('completed')
      expect(completedState.runs[0].planner).toBe('openai_compatible_tool_calls')
      expect(completedState.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(completedState.messages.at(-1).content).toContain('3月计划收入')
      expect(completedState.planSteps[0].status).toBe('executed')
      expect(completedState.actionRequests).toHaveLength(0)
      await closeHarness(harness)
    })
  })

  it('fails closed when recovering an interrupted running agent run with partial output', async () => {
    const harness = await buildHarness('agent-recover-partial-run')
    const client = new Client(harness.app)
    const user = await registerUser(client, 'agent-recover-partial-run@example.com')
    const run = await insertRunningAgentRun(harness.db, user.id, {
      suffix: 'recover-partial',
      message: '把 4 月线上系数改成 0.3 并保存',
      partialOutput: true,
    })

    await recoverRunningAgentRuns(harness.db, harness.settings)
    const state = await client.get(`/api/v1/agent/threads/${run.threadId}`)
    expect(state.statusCode).toBe(200)
    expect(state.json.runs[0].status).toBe('failed')
    expect(state.json.actionRequests[0].status).toBe('cancelled')
    expect(state.json.actionRequests[0].errorMessage).toContain('部分运行产物')
    expect(state.json.planSteps[0].status).toBe('failed')
    expect(state.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
    expect(state.json.messages.at(-1).content).toContain('请重新发送这条指令')
    const threads = await client.get('/api/v1/agent/threads')
    expect(threads.json.threads[0].latestRunStatus).toBe('failed')
    expect(threads.json.threads[0].pendingActionCount).toBe(0)
    await closeHarness(harness)
  })

  it('uses OpenAI Agents SDK adapter for OpenAI provider planning', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expect(body.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('需要操作系统能力时，通过 tool_calls 表达意图'))).toBe(true)
        expectProviderTools(body, ['workspace_update_online_factor', 'ledger_create_member_income'])
        return fakeOpenAIChatToolResponse('workspace_update_online_factor', {
          monthLabel: '4月',
          onlineSalesFactor: 0.3,
          mode: 'forecast',
        })
      },
      (body) => {
        expect(body.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('需要操作系统能力时，通过 tool_calls 表达意图'))).toBe(true)
        expectProviderTools(body, ['ledger_create_member_income'])
        return fakeOpenAIChatToolResponse('ledger_create_member_income', {
          monthLabel: '3月',
          memberName: '成员 A',
          offlineUnits: 1,
          onlineUnits: 0,
        })
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-openai-sdk', {
        llmProvider: 'openai',
        openaiBaseUrl: baseUrl,
        openaiModel: 'fake-openai',
        openaiApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-openai-sdk@example.com')

      const forecast = await client.post('/api/v1/agent/messages', {
        message: '如果 4 月线上系数变成 0.3，利润会怎样',
      })
      expect(forecast.statusCode).toBe(200)
      expect(forecast.json.planner).toBe('openai_agents')
      expect(forecast.json.actionRequests).toHaveLength(0)
      expect(forecast.json.navigationEvents[0].route.mainTab).toBe('inputs')
      expect(forecast.json.runEvents.some((event: any) =>
        event.type === 'provider_stream_started' &&
        event.data?.source === 'openai_agents' &&
        event.data?.provider === 'openai',
      )).toBe(true)
      expect(forecast.json.runEvents.some((event: any) =>
        event.type === 'provider_stream_delta' &&
        event.data?.kind === 'tool_call_delta' &&
        event.data?.toolName === 'workspace_update_online_factor',
      )).toBe(true)
      expect(forecast.json.runEvents.some((event: any) =>
        event.type === 'provider_stream_completed' &&
        event.data?.source === 'openai_agents' &&
        event.data?.toolCallCount === 1,
      )).toBe(true)

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_agents')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(88)
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'provider_stream_delta' &&
        event.data?.kind === 'tool_call_delta' &&
        event.data?.toolName === 'ledger_create_member_income',
      )).toBe(true)
      await closeHarness(harness)
    })
  })

  it('persists agent thread history and restores messages, runs, plan steps, and pending actions', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponse('ledger_create_member_income', {
      monthLabel: '3月',
      memberName: '成员 A',
      offlineUnits: 1,
      onlineUnits: 0,
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-thread-history', fakeProviderSettings(baseUrl))
      const firstClient = new Client(harness.app)
      const secondClient = new Client(harness.app)
      await registerUser(firstClient, 'agent-thread-history-a@example.com')
      await registerUser(secondClient, 'agent-thread-history-b@example.com')

      const planned = await firstClient.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(1)

      const threads = await firstClient.get('/api/v1/agent/threads')
      expect(threads.statusCode).toBe(200)
      expect(threads.json.threads).toHaveLength(1)
      expect(threads.json.threads[0].id).toBe(planned.json.threadId)
      expect(threads.json.threads[0].title).toContain('把 3 月成员 A')
      expect(threads.json.threads[0].latestRunStatus).toBe('completed')
      expect(threads.json.threads[0].planner).toBe('openai_compatible_tool_calls')
      expect(threads.json.threads[0].pendingActionCount).toBe(1)

      const restored = await firstClient.get(`/api/v1/agent/threads/${planned.json.threadId}`)
      expect(restored.statusCode).toBe(200)
      expect(restored.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
      expect(restored.json.runs[0].status).toBe('completed')
      expect(restored.json.runs[0].planner).toBe('openai_compatible_tool_calls')
      expect(restored.json.planSteps).toHaveLength(1)
      expect(restored.json.planSteps[0].actionRequestId).toBe(planned.json.actionRequests[0].id)
      expect(restored.json.actionRequests[0].status).toBe('pending')
      expect(restored.json.navigationEvents[0].route.mainTab).toBe('bookkeeping')
      expect(restored.json.runEvents.map((event: any) => event.type)).toEqual(
        expect.arrayContaining(['run_queued', 'model_planning', 'tool_plan_ready', 'confirmation_ready', 'run_completed']),
      )

      const secondThreads = await secondClient.get('/api/v1/agent/threads')
      expect(secondThreads.statusCode).toBe(200)
      expect(secondThreads.json.threads).toHaveLength(0)
      const crossUserRestore = await secondClient.get(`/api/v1/agent/threads/${planned.json.threadId}`)
      expect(crossUserRestore.statusCode).toBe(403)

      const confirmed = await firstClient.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
      expect(confirmed.statusCode).toBe(200)
      const restoredAfterConfirm = await firstClient.get(`/api/v1/agent/threads/${planned.json.threadId}`)
      expect(restoredAfterConfirm.statusCode).toBe(200)
      expect(restoredAfterConfirm.json.actionRequests[0].status).toBe('executed')
      expect(restoredAfterConfirm.json.planSteps[0].status).toBe('executed')
      expect(restoredAfterConfirm.json.runEvents.some((event: any) => event.type === 'action_executed')).toBe(true)
      expect(restoredAfterConfirm.json.messages.at(-1).content).toContain('已执行')
      const threadsAfterConfirm = await firstClient.get('/api/v1/agent/threads')
      expect(threadsAfterConfirm.json.threads[0].pendingActionCount).toBe(0)
      await closeHarness(harness)
    })
  })

  it('streams server-owned thread state through SSE and keeps events tenant scoped', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('ui_navigate', { mainTab: 'dashboard', secondaryTab: 'overview' }),
      () => fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      }),
    ]), async (providerBaseUrl) => {
      const harness = await buildHarness('agent-thread-events', fakeProviderSettings(providerBaseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-thread-events@example.com')
      const initial = await client.post('/api/v1/agent/messages', {
        message: '打开看测算',
      })
      expect(initial.statusCode).toBe(200)

      const sseBaseUrl = await listenOnFetchSafePort(harness.app)

      try {
        const events = await collectSseEvents(
          `${sseBaseUrl}/api/v1/agent/threads/${initial.json.threadId}/events`,
          client.cookieHeader(),
          12,
          async () => {
            const next = await client.post('/api/v1/agent/messages', {
              threadId: initial.json.threadId,
              message: '把 3 月成员 A 线下 1 张入账',
            })
            expect(next.statusCode).toBe(200)
          },
        )

        expect(events.length).toBeGreaterThanOrEqual(2)
        const initialEvent = events[0]!
        const updateEvent = events.find((event) => event.data.state.actionRequests.some((action: any) => action.kind === 'ledger.create_entry')) ?? events.at(-1)!
        expect(initialEvent.event).toBe('thread_state')
        expect(initialEvent.data.threadId).toBe(initial.json.threadId)
        expect(initialEvent.data.state.thread.id).toBe(initial.json.threadId)
        expect(updateEvent.event).toBe('thread_state')
        expect(updateEvent.data.threadId).toBe(initial.json.threadId)
        expect(updateEvent.data.state.actionRequests.some((action: any) => action.kind === 'ledger.create_entry')).toBe(true)
        expect(updateEvent.data.state.runEvents.some((event: any) => event.type === 'tool_plan_ready')).toBe(true)

        const outsider = new Client(harness.app)
        await registerUser(outsider, 'agent-thread-events-outsider@example.com')
        const forbidden = await fetch(`${sseBaseUrl}/api/v1/agent/threads/${initial.json.threadId}/events`, {
          headers: { cookie: outsider.cookieHeader() },
        })
        expect(forbidden.status).toBe(403)
      } finally {
        await closeHarness(harness)
      }
    })
  })

  it('keeps agent memory scoped by user and workspace and compacts long thread context', async () => {
    const secretValue = ['sk', 'memorysecretvalue123456'].join('-')
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('memory_remember', {
          value: '默认记账成员是 成员 A',
          kind: 'preference',
          key: 'user.preference.defaultLedgerMember',
          confidence: 0.95,
      }),
      fakeAssistantTextResponse('已处理。'),
      fakeAssistantTextResponse('已处理。'),
      () => fakeToolResponse('memory_remember', {
        value: `DeepSeek API key 是 ${secretValue}`,
        kind: 'preference',
      }),
      ...Array.from({ length: 5 }, () => fakeAssistantTextResponse('已处理。')),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-memory', { llmProvider: 'openai-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const firstClient = new Client(harness.app)
      const secondClient = new Client(harness.app)
      const firstUser = await registerUser(firstClient, 'agent-memory-a@example.com')
      await registerUser(secondClient, 'agent-memory-b@example.com')

      const remembered = await firstClient.post('/api/v1/agent/messages', {
        message: '记住：默认记账成员是 成员 A',
      })
      expect(remembered.statusCode).toBe(200)
      expect(remembered.json.planner).toBe('openai_compatible_tool_calls')
      expect(remembered.json.planSteps.some((step: any) => step.title === '已保存记忆')).toBe(true)
      expect(remembered.json.runEvents.some((event: any) => event.type === 'memory_recall_completed')).toBe(true)
      const threadId = remembered.json.threadId
      const firstMemories = await firstClient.get('/api/v1/agent/memories')
      expect(firstMemories.json.memories).toHaveLength(1)
      expect(firstMemories.json.memories[0].value).toContain('成员 A')
      expect(firstMemories.json.memories[0].status).toBe('promoted')
      expect(firstMemories.json.memories[0].lane).toBe('semantic')
      expect(firstMemories.json.memories[0].injectable).toBe(true)
      const searchedMemories = await firstClient.get('/api/v1/agent/memories?query=%E9%BB%98%E8%AE%A4%E6%88%90%E5%91%98')
      expect(searchedMemories.json.memories).toHaveLength(1)
      expect((await secondClient.get('/api/v1/agent/memories')).json.memories).toHaveLength(0)
      expect((await secondClient.delete(`/api/v1/agent/memories/${firstMemories.json.memories[0].id}`)).statusCode).toBe(403)
      const capturedEvents = await harness.db
        .selectFrom('agent_memory_events')
        .selectAll()
        .where('memory_id', '=', firstMemories.json.memories[0].id)
        .where('event_type', '=', 'captured')
        .execute()
      expect(capturedEvents).toHaveLength(1)

      const workspace = await harness.db.selectFrom('workspaces').selectAll().where('owner_id', '=', firstUser.id).executeTakeFirstOrThrow()
      const firstUserRow = await harness.db.selectFrom('users').selectAll().where('id', '=', firstUser.id).executeTakeFirstOrThrow()
      const candidateMemory = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user: firstUserRow,
        threadId,
        runId: remembered.json.runId,
        kind: 'fact',
        scopeType: 'workspace',
        memoryType: 'semantic',
        status: 'candidate',
        key: 'workspace.fact.defaultApprover',
        value: '默认审批人是 李雷',
        confidence: 0.8,
        evidence: { test: 'promotion' },
      })
      expect(candidateMemory.memory?.status).toBe('candidate')
      expect(candidateMemory.memory?.injectable).toBe(0)
      const firstRecall = await firstClient.post('/api/v1/agent/messages', { threadId, message: '默认审批人是谁？' })
      expect(firstRecall.statusCode).toBe(200)
      const secondRecall = await firstClient.post('/api/v1/agent/messages', { threadId, message: '默认审批人是谁？' })
      expect(secondRecall.statusCode).toBe(200)
      expect(secondRecall.json.runEvents.some((event: any) => event.type === 'memory_promoted')).toBe(false)
      const searchedCandidate = await firstClient.get('/api/v1/agent/memories?query=%E9%BB%98%E8%AE%A4%E5%AE%A1%E6%89%B9%E4%BA%BA')
      expect(searchedCandidate.json.memories.some((memory: any) => memory.id === candidateMemory.memory!.id && memory.status === 'candidate')).toBe(true)
      const promotedResponse = await firstClient.post(`/api/v1/agent/memories/${candidateMemory.memory!.id}/promote`)
      expect(promotedResponse.statusCode).toBe(200)
      const promotedMemory = await harness.db.selectFrom('agent_memories').selectAll().where('id', '=', candidateMemory.memory!.id).executeTakeFirstOrThrow()
      expect(promotedMemory.status).toBe('promoted')
      expect(promotedMemory.memory_type).toBe('semantic')
      expect(promotedMemory.injectable).toBe(1)

      const secretRemember = await firstClient.post('/api/v1/agent/messages', {
        threadId,
        message: `记住：DeepSeek API key 是 ${secretValue}`,
      })
      expect(secretRemember.statusCode).toBe(200)
      expect(secretRemember.json.planSteps.some((step: any) => step.title === '未保存记忆')).toBe(true)
      const memoriesAfterSecret = await firstClient.get('/api/v1/agent/memories')
      expect(memoriesAfterSecret.json.memories.some((memory: any) => memory.value.includes('成员 A'))).toBe(true)
      expect(JSON.stringify(memoriesAfterSecret.json.memories)).not.toContain(secretValue)

      for (let index = 0; index < 5; index += 1) {
        const response = await firstClient.post('/api/v1/agent/messages', { threadId, message: `看测算 ${index}` })
        expect(response.statusCode).toBe(200)
      }
      const snapshots = await harness.db
        .selectFrom('agent_context_snapshots')
        .selectAll()
        .where('thread_id', '=', threadId)
        .where('user_id', '=', firstUser.id)
        .execute()
      expect(snapshots.length).toBeGreaterThan(0)
      expect(snapshots[0]?.summary).toContain('user:')
      expect(snapshots[0]?.summary).not.toContain(secretValue)
      expect(snapshots[0]?.summary).toContain('[redacted-api-key]')
      const memoryCenterAfterFlush = await firstClient.get('/api/v1/agent/memories')
      expect(memoryCenterAfterFlush.statusCode).toBe(200)
      expect(memoryCenterAfterFlush.json.dailyNotes.length).toBeGreaterThan(0)
      expect(memoryCenterAfterFlush.json.dailyNotes[0].content).toContain('user:')
      expect(memoryCenterAfterFlush.json.dailyNotes[0].content).not.toContain(secretValue)

      expect((await firstClient.delete(`/api/v1/agent/memories/${firstMemories.json.memories[0].id}`)).statusCode).toBe(200)
      const afterDelete = await firstClient.get('/api/v1/agent/memories')
      const archivedMemory = afterDelete.json.memories.find((memory: any) => memory.id === firstMemories.json.memories[0].id)
      expect(archivedMemory?.status).toBe('archived')
      expect(archivedMemory?.injectable).toBe(false)
      await closeHarness(harness)
    })
  }, 10_000)

  it('applies Memory Kernel v2 lane, capture, recall, and cleanup gates', async () => {
    const diagnosticDecision = decideMemoryCandidate({
      kind: 'diagnostic',
      scopeType: 'procedural',
      memoryType: 'episodic',
      key: 'agent.evaluator.finding.test',
      value: '目标要求 1 个股东，当前草稿为 5 个。',
      confidence: 0.7,
    })
    expect(diagnosticDecision.lane).toBe('diagnostic')
    expect(diagnosticDecision.injectable).toBe(false)
    expect(diagnosticDecision.decision).toBe('diagnostic_only')

    const actionCandidates = memoryCandidatesFromExecutedActions({
      runId: 'run-memory-v2',
      actionRows: [{
        id: 'action-operating-model',
        status: 'executed',
        kind: 'workspace.update_draft',
        title: '确认修改模型草稿',
        target_label: '星河 50 期启动测算',
        payload_json: JSON.stringify({
          source: 'workspace_configure_operating_model',
          workspaceName: '星河 50 期启动测算',
          config: {
            teamMembers: Array.from({ length: 50 }, (_, index) => ({ id: `m-${index}`, name: `成员 ${index + 1}` })),
            months: Array.from({ length: 12 }, (_, index) => ({ id: `month-${index}`, label: `${index + 1}月` })),
            shareholders: Array.from({ length: 5 }, (_, index) => ({ id: `s-${index}`, name: `股东 ${index + 1}` })),
          },
        }),
      } as any],
    })
    const draftEpisode = actionCandidates.find((candidate) => candidate.key === 'workspace.episode.action-operating-model')
    expect(draftEpisode?.lane).toBe('episodic')
    expect(draftEpisode?.status).toBe('archived')
    expect(draftEpisode?.injectable).toBe(false)
    const reusableWorkflow = actionCandidates.find((candidate) => candidate.key === 'agent.workflow.operating_model_configured_by_high_level_tool')
    expect(reusableWorkflow?.lane).toBe('procedural')
    expect(reusableWorkflow?.status).toBe('promoted')
    expect(reusableWorkflow?.injectable).toBe(true)

    const evaluatorCandidate = memoryCandidateFromEvaluatorFinding({
      runId: 'run-memory-v2',
      evaluation: {
        id: 'evaluation-memory-v2',
        status: 'fail',
        unsatisfied_json: JSON.stringify([{ message: '运行图存在失败动作。' }]),
        iteration_no: 1,
      } as any,
    })
    expect(evaluatorCandidate?.lane).toBe('diagnostic')
    expect(evaluatorCandidate?.injectable).toBe(false)
    expect(memoryCandidateFromCompletedGoal({ goal: {} as any })).toBeNull()

    const harness = await buildHarness('memory-kernel-v2')
    try {
      const client = new Client(harness.app)
      const registered = await registerUser(client, 'memory-kernel-v2@example.com')
      const workspace = await harness.db.selectFrom('workspaces').selectAll().where('owner_id', '=', registered.id).executeTakeFirstOrThrow()
      const user = await harness.db.selectFrom('users').selectAll().where('id', '=', registered.id).executeTakeFirstOrThrow()
      const now = new Date().toISOString()
      const threadId = 'thread-memory-v2'
      const otherThreadId = 'thread-memory-v2-other'
      await harness.db.insertInto('agent_threads').values([
        { id: threadId, workspace_id: workspace.id, user_id: user.id, title: 'Memory v2', created_at: now, updated_at: now },
        { id: otherThreadId, workspace_id: workspace.id, user_id: user.id, title: 'Memory v2 other', created_at: now, updated_at: now },
      ]).execute()

      const semantic = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId: null,
        kind: 'preference',
        scopeType: 'workspace',
        memoryType: 'semantic',
        key: 'workspace.preference.defaultLedgerMember',
        value: '默认记账成员是 成员 1',
        confidence: 0.92,
      })
      const candidate = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId: null,
        kind: 'business_fact',
        scopeType: 'workspace',
        memoryType: 'semantic',
        status: 'candidate',
        key: 'workspace.fact.defaultApprover',
        value: '默认审批人是 李雷',
        confidence: 0.82,
      })
      const diagnostic = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId: null,
        kind: 'diagnostic',
        scopeType: 'procedural',
        memoryType: 'episodic',
        key: 'agent.evaluator.finding.shareholder_count',
        value: '目标要求 1 个股东，当前草稿为 5 个。',
        confidence: 0.7,
      })
      const episode = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId: null,
        kind: 'episode',
        scopeType: 'workspace',
        memoryType: 'episodic',
        key: 'workspace.episode.executedLedger',
        value: '已通过 Agent 执行账本动作：成员 1 入账 680。',
        confidence: 0.75,
      })
      const working = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId,
        kind: 'fact',
        scopeType: 'thread',
        memoryType: 'working',
        lane: 'working',
        status: 'active',
        injectable: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        key: 'thread.working.lastMentionedMember',
        value: '本轮提到的成员是 成员 2。',
        confidence: 0.7,
      })
      const otherThreadWorking = await rememberAgentMemory({
        db: harness.db,
        workspace,
        user,
        threadId: otherThreadId,
        kind: 'fact',
        scopeType: 'thread',
        memoryType: 'working',
        lane: 'working',
        status: 'active',
        injectable: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        key: 'thread.working.other',
        value: '本轮提到的成员是 成员 3。',
        confidence: 0.7,
      })

      expect(candidate.memory?.injectable).toBe(0)
      expect(diagnostic.memory?.lane).toBe('diagnostic')
      expect(diagnostic.memory?.injectable).toBe(0)
      expect(episode.memory?.status).toBe('archived')
      expect(episode.memory?.injectable).toBe(0)

      const promptRecall = await retrieveAgentMemories({
        db: harness.db,
        workspace,
        user,
        query: '默认记账成员 成员 1 本轮提到 成员 2 默认审批人 股东数量',
        forPrompt: true,
        threadId,
        limit: 10,
      })
      const promptIds = promptRecall.map((item) => item.memory.id)
      expect(promptIds).toContain(semantic.memory!.id)
      expect(promptIds).toContain(working.memory!.id)
      expect(promptIds).not.toContain(candidate.memory!.id)
      expect(promptIds).not.toContain(diagnostic.memory!.id)
      expect(promptIds).not.toContain(episode.memory!.id)
      expect(promptIds).not.toContain(otherThreadWorking.memory!.id)

      const governedSearch = await retrieveAgentMemories({
        db: harness.db,
        workspace,
        user,
        query: '默认审批人 股东 草稿 成员 入账',
        includeCandidates: true,
        includeArchived: true,
        includeDiagnostics: true,
        includeNonInjectable: true,
        limit: 20,
      })
      const governedIds = governedSearch.map((item) => item.memory.id)
      expect(governedIds).toContain(candidate.memory!.id)
      expect(governedIds).toContain(diagnostic.memory!.id)
      expect(governedIds).toContain(episode.memory!.id)
      expect((await client.post(`/api/v1/agent/memories/${diagnostic.memory!.id}/promote`)).statusCode).toBe(403)
      expect((await client.post(`/api/v1/agent/memories/${episode.memory!.id}/promote`)).statusCode).toBe(403)
      const promotedCandidate = await client.post(`/api/v1/agent/memories/${candidate.memory!.id}/promote`)
      expect(promotedCandidate.statusCode).toBe(200)
      expect(promotedCandidate.json.memory.status).toBe('promoted')
      expect(promotedCandidate.json.memory.injectable).toBe(true)

      const legacyRows = [
        {
          id: 'legacy-diagnostic',
          kind: 'workflow',
          scope_type: 'procedural',
          memory_type: 'procedural',
          lane: 'procedural',
          status: 'promoted',
          key: 'agent.evaluator.finding.legacy',
          value: 'Evaluator 发现目标未满足：目标要求 1 个股东，当前草稿为 5 个。',
          injectable: 1,
        },
        {
          id: 'legacy-goal',
          kind: 'episode',
          scope_type: 'workspace',
          memory_type: 'episodic',
          lane: 'episodic',
          status: 'active',
          key: 'agent.goal.completed.legacy',
          value: 'Agent 已完成目标：完整用户目标原文。',
          injectable: 1,
        },
        {
          id: 'legacy-recent-entity',
          kind: 'fact',
          scope_type: 'workspace',
          memory_type: 'episodic',
          lane: 'episodic',
          status: 'active',
          key: 'workspace.recent_related_entity.member1',
          value: '最近一次 Agent 账本动作关联对象是 成员 1。',
          injectable: 1,
        },
        {
          id: 'legacy-episode',
          kind: 'episode',
          scope_type: 'workspace',
          memory_type: 'episodic',
          lane: 'episodic',
          status: 'active',
          key: 'workspace.episode.legacy',
          value: '已通过 Agent 更新草稿：星河 50 期启动测算。',
          injectable: 1,
        },
      ]
      await harness.db.insertInto('agent_memories').values(legacyRows.map((row) => ({
        ...row,
        workspace_id: workspace.id,
        user_id: user.id,
        thread_id: null,
        confidence: 0.7,
        evidence_score: 0,
        sensitivity: 'normal',
        normalized_hash: null,
        source_message_id: null,
        source_run_id: null,
        source_kind: null,
        evidence_json: null,
        last_used_at: null,
        last_verified_at: null,
        promoted_at: null,
        expires_at: null,
        superseded_by: null,
        metadata_json: null,
        created_at: now,
        updated_at: now,
        archived_at: null,
      }))).execute()
      await runMigrations(harness.db)
      const cleanedRows = await harness.db
        .selectFrom('agent_memories')
        .selectAll()
        .where('id', 'in', legacyRows.map((row) => row.id))
        .execute()
      const byId = new Map(cleanedRows.map((row) => [row.id, row]))
      expect(byId.get('legacy-diagnostic')?.lane).toBe('diagnostic')
      expect(byId.get('legacy-diagnostic')?.kind).toBe('diagnostic')
      expect(byId.get('legacy-diagnostic')?.status).toBe('archived')
      expect(byId.get('legacy-diagnostic')?.injectable).toBe(0)
      expect(byId.get('legacy-goal')?.status).toBe('archived')
      expect(byId.get('legacy-goal')?.injectable).toBe(0)
      expect(byId.get('legacy-recent-entity')?.status).toBe('expired')
      expect(byId.get('legacy-recent-entity')?.injectable).toBe(0)
      expect(byId.get('legacy-episode')?.status).toBe('archived')
      expect(byId.get('legacy-episode')?.injectable).toBe(0)
    } finally {
      await closeHarness(harness)
    }
  })

  it('injects tenant-scoped memory into a new agent thread for real provider planning', async () => {
    const secretValue = ['sk', 'providersecretvalue123456'].join('-')
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expectProviderTools(body, ['memory_remember'])
        return fakeToolResponse('memory_remember', {
          value: '默认记账成员是 成员 A',
          kind: 'preference',
          key: 'user.preference.defaultLedgerMember',
        })
      },
      (body) => {
        const prompt = body.messages.map((message: any) => message.content).join('\n')
        expect(prompt).not.toContain(secretValue)
        expect(prompt).toContain('[redacted-api-key]')
        expectProviderTools(body, ['memory_remember'])
        return fakeToolResponse('memory_remember', {
          value: `DeepSeek API key 是 ${secretValue}`,
          kind: 'preference',
        })
      },
      (body) => {
        const prompt = body.messages.map((message: any) => message.content).join('\n')
        expect(prompt).toContain('默认记账成员是 成员 A')
        expect(prompt).toContain('tenantScopedMemory')
        expect(prompt).not.toContain(secretValue)
        expectProviderTools(body, ['ledger_create_member_income'])
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_memory_ledger',
                type: 'function',
                function: {
                  name: 'ledger_create_member_income',
                  arguments: JSON.stringify({
                    monthLabel: '3月',
                    memberName: '成员 A',
                    offlineUnits: 1,
                    onlineUnits: 0,
                  }),
                },
              }],
            },
          }],
        }
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-memory-provider', { llmProvider: 'doubao', openaiCompatibleProvider: 'doubao', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-memory-provider@example.com')

      const remembered = await client.post('/api/v1/agent/messages', {
        message: '记住：默认记账成员是 成员 A',
      })
      expect(remembered.statusCode).toBe(200)

      const secretRemember = await client.post('/api/v1/agent/messages', {
        threadId: remembered.json.threadId,
        message: `记住：DeepSeek API key 是 ${secretValue}`,
      })
      expect(secretRemember.statusCode).toBe(200)
      expect((await client.get('/api/v1/agent/memories')).json.memories).toHaveLength(1)

      const plannedFromNewThread = await client.post('/api/v1/agent/messages', {
        message: '把 3 月默认成员线下 1 张入账',
      })
      expect(plannedFromNewThread.statusCode).toBe(200)
      expect(plannedFromNewThread.json.threadId).not.toBe(remembered.json.threadId)
      expect(plannedFromNewThread.json.planner).toBe('openai_compatible_tool_calls')
      expect(plannedFromNewThread.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(plannedFromNewThread.json.actionRequests[0].targetLabel).toContain('成员 A')
      const memoryEvent = plannedFromNewThread.json.runEvents.find((event: any) => event.type === 'memory_injected')
      expect(memoryEvent?.data.memoryCount).toBe(1)
      expect(memoryEvent?.data.memoryIds).toHaveLength(1)
      const memoryCenterAfterRecall = await client.get('/api/v1/agent/memories')
      expect(memoryCenterAfterRecall.json.recallSignals.some((signal: any) => signal.memoryId === memoryEvent.data.memoryIds[0])).toBe(true)
      const recalledEvents = await harness.db
        .selectFrom('agent_memory_events')
        .selectAll()
        .where('run_id', '=', plannedFromNewThread.json.runId)
        .where('event_type', 'in', ['recalled', 'injected'])
        .execute()
      expect(recalledEvents.length).toBeGreaterThanOrEqual(2)
      await closeHarness(harness)
    })
  })

  it('plans team member add and delete through dedicated editable Agent confirmations', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expectProviderTools(body, ['team_member_add'])
        return fakeToolResponse('team_member_add', {
          memberName: '成员 G',
          commissionRate: 0.3,
          baseUnitsPerEvent: 18,
        })
      },
      (body) => {
        expectProviderTools(body, ['team_member_delete'])
        return fakeToolResponse('team_member_delete', { memberName: '成员 G' })
      },
      (body) => {
        expectProviderTools(body, ['team_member_delete'])
        return fakeToolResponse('team_member_delete', { memberName: '文臣' })
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-team-member-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-team-member-tools@example.com')

      const added = await client.post('/api/v1/agent/messages', { message: '新增成员，名字叫 成员 G，提成 30%，基准场均 18 张' })
      expect(added.statusCode).toBe(200)
      expect(added.json.planner).toBe('openai_compatible_tool_calls')
      expect(added.json.actionRequests).toHaveLength(1)
      const addAction = added.json.actionRequests[0]
      expect(addAction.kind).toBe('workspace.update_draft')
      expect(addAction.title).toContain('新增')
      expect(addAction.navigation.route.mainTab).toBe('inputs')
      expect(addAction.navigation.route.secondaryTab).toBe('revenue')
      expect(addAction.payload.config.teamMembers).toHaveLength(8)
      expect(addAction.payload.config.teamMembers.some((member: any) => member.name === '成员 G')).toBe(true)

      const editedAddPayload = {
        ...addAction.payload,
        config: {
          ...addAction.payload.config,
          teamMembers: addAction.payload.config.teamMembers.map((member: any) =>
            member.name === '成员 G' ? { ...member, commissionRate: 0.31 } : member,
          ),
        },
      }
      const editedAdd = await client.patch(`/api/v1/agent/action-requests/${addAction.id}`, {
        summary: '编辑后：新增成员 G，提成改为 31%。',
        payload: editedAddPayload,
      })
      expect(editedAdd.statusCode).toBe(200)
      expect(editedAdd.json.actionRequest.payload.config.teamMembers.find((member: any) => member.name === '成员 G').commissionRate).toBe(0.31)

      const confirmedAdd = await client.post(`/api/v1/agent/action-requests/${addAction.id}/confirm`)
      expect(confirmedAdd.statusCode).toBe(200)
      let draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.teamMembers).toHaveLength(8)
      expect(draft.config.teamMembers.find((member: any) => member.name === '成员 G').commissionRate).toBe(0.31)

      const deleted = await client.post('/api/v1/agent/messages', { threadId: added.json.threadId, message: '删除成员 G' })
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json.actionRequests).toHaveLength(1)
      const deleteAction = deleted.json.actionRequests[0]
      expect(deleteAction.kind).toBe('workspace.update_draft')
      expect(deleteAction.title).toContain('删除')
      expect(deleteAction.riskLevel).toBe('high')
      expect(deleteAction.payload.config.teamMembers).toHaveLength(7)
      expect(deleteAction.payload.config.teamMembers.some((member: any) => member.name === '成员 G')).toBe(false)
      const confirmedDelete = await client.post(`/api/v1/agent/action-requests/${deleteAction.id}/confirm`)
      expect(confirmedDelete.statusCode).toBe(200)
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.teamMembers).toHaveLength(7)
      expect(draft.config.teamMembers.some((member: any) => member.name === '成员 G')).toBe(false)

      const oneMemberConfig = {
        ...draft.config,
        teamMembers: [draft.config.teamMembers[0]],
      }
      const collapsedDraft = await client.patch('/api/v1/workspace/draft', {
        revision: draft.revision,
        workspaceName: draft.workspaceName,
        config: oneMemberConfig,
      })
      expect(collapsedDraft.statusCode).toBe(200)
      const lastMemberDelete = await client.post('/api/v1/agent/messages', { threadId: added.json.threadId, message: '删除成员 文臣' })
      expect(lastMemberDelete.statusCode).toBe(200)
      expect(lastMemberDelete.json.actionRequests).toHaveLength(0)
      expect(lastMemberDelete.json.messages.at(-1).content).toContain('不能删除最后一个成员')

      await closeHarness(harness)
    })
  })

  it('plans shareholder and cost structure add/delete through dedicated Agent confirmations', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expectProviderTools(body, ['shareholder_add'])
        return fakeToolResponse('shareholder_add', {
          newShareholderName: '股东 C',
          investmentAmount: 10000,
          dividendRate: 0.1,
        })
      },
      (body) => {
        expectProviderTools(body, ['workspace_patch_config'])
        return fakeToolResponse('workspace_patch_config', {
          patches: [{ path: 'shareholders[2].investmentAmount', value: 20000, label: '股东 C 投资额' }],
        })
      },
      (body) => {
        expectProviderTools(body, ['shareholder_delete'])
        return fakeToolResponse('shareholder_delete', { shareholderName: '股东 C' })
      },
      (body) => {
        expectProviderTools(body, ['shareholder_delete'])
        return fakeToolResponse('shareholder_delete', { shareholderName: '股东 A' })
      },
      (body) => {
        expectProviderTools(body, ['cost_item_add'])
        return fakeToolResponse('cost_item_add', {
          costCategory: 'monthlyFixed',
          newCostItemName: '房租',
          amount: 1200,
        })
      },
      (body) => {
        expectProviderTools(body, ['cost_item_delete'])
        return fakeToolResponse('cost_item_delete', { costCategory: 'monthlyFixed', costItemName: '房租' })
      },
      (body) => {
        expectProviderTools(body, ['stage_cost_type_add'])
        return fakeToolResponse('stage_cost_type_add', {
          costTypeName: '摄影',
          costMode: 'perEvent',
          amount: 300,
          count: 1,
        })
      },
      (body) => {
        expectProviderTools(body, ['stage_cost_type_delete'])
        return fakeToolResponse('stage_cost_type_delete', { newStageCostItemName: '摄影' })
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-shareholder-cost-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-shareholder-cost-tools@example.com')

      async function confirm(action: any) {
        const response = await client.post(`/api/v1/agent/action-requests/${action.id}/confirm`)
        expect(response.statusCode).toBe(200)
        return response.json
      }

      const addedShareholder = await client.post('/api/v1/agent/messages', { message: '新增股东，名字叫 股东 C，投资 10000，分红比例 10%' })
      expect(addedShareholder.statusCode).toBe(200)
      expect(addedShareholder.json.actionRequests[0].title).toContain('新增股东')
      expect(addedShareholder.json.actionRequests[0].navigation.route.secondaryTab).toBe('capital')
      await confirm(addedShareholder.json.actionRequests[0])
      let draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.shareholders).toHaveLength(3)
      expect(draft.config.shareholders.find((shareholder: any) => shareholder.name === '股东 C').investmentAmount).toBe(10000)

      const editedShareholder = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '把股东 C 投资额改成 20000 并保存' })
      expect(editedShareholder.statusCode).toBe(200)
      expect(editedShareholder.json.actionRequests[0].kind).toBe('workspace.update_draft')
      await confirm(editedShareholder.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.shareholders.find((shareholder: any) => shareholder.name === '股东 C').investmentAmount).toBe(20000)

      const deletedShareholder = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '删除股东 C' })
      expect(deletedShareholder.statusCode).toBe(200)
      expect(deletedShareholder.json.actionRequests[0].title).toContain('删除股东')
      expect(deletedShareholder.json.actionRequests[0].riskLevel).toBe('high')
      await confirm(deletedShareholder.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.shareholders.some((shareholder: any) => shareholder.name === '股东 C')).toBe(false)

      const oneShareholderDraft = await client.patch('/api/v1/workspace/draft', {
        revision: draft.revision,
        workspaceName: draft.workspaceName,
        config: { ...draft.config, shareholders: [draft.config.shareholders[0]] },
      })
      expect(oneShareholderDraft.statusCode).toBe(200)
      const lastShareholderDelete = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '删除股东 A' })
      expect(lastShareholderDelete.statusCode).toBe(200)
      expect(lastShareholderDelete.json.actionRequests).toHaveLength(0)
      expect(lastShareholderDelete.json.messages.at(-1).content).toContain('不能删除最后一个股东')

      draft = (await client.get('/api/v1/workspace/draft')).json
      const restoredShareholders = createProductDefaultModel().shareholders
      const restored = await client.patch('/api/v1/workspace/draft', {
        revision: draft.revision,
        workspaceName: draft.workspaceName,
        config: { ...draft.config, shareholders: restoredShareholders },
      })
      expect(restored.statusCode).toBe(200)

      const addedCost = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '新增每月固定成本房租 1200' })
      expect(addedCost.statusCode).toBe(200)
      expect(addedCost.json.actionRequests[0].title).toContain('新增基础成本项')
      expect(addedCost.json.actionRequests[0].navigation.route.secondaryTab).toBe('cost')
      await confirm(addedCost.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.monthlyFixedCosts.find((item: any) => item.name === '房租').amount).toBe(1200)

      const deletedCost = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '删除每月固定成本房租' })
      expect(deletedCost.statusCode).toBe(200)
      expect(deletedCost.json.actionRequests[0].title).toContain('删除基础成本项')
      await confirm(deletedCost.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.monthlyFixedCosts.some((item: any) => item.name === '房租')).toBe(false)

      const addedStageCost = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '新增成本类型摄影，按场计费，默认 300 元 1 场' })
      expect(addedStageCost.statusCode).toBe(200)
      expect(addedStageCost.json.actionRequests[0].title).toContain('新增专项成本类型')
      await confirm(addedStageCost.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      const photography = draft.config.stageCostItems.find((item: any) => item.name === '摄影')
      expect(photography.mode).toBe('perEvent')
      expect(draft.config.months.every((month: any) => month.specialCosts.some((cost: any) => cost.itemId === photography.id))).toBe(true)

      const deletedStageCost = await client.post('/api/v1/agent/messages', { threadId: addedShareholder.json.threadId, message: '删除成本类型摄影' })
      expect(deletedStageCost.statusCode).toBe(200)
      expect(deletedStageCost.json.actionRequests[0].title).toContain('删除专项成本类型')
      await confirm(deletedStageCost.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.stageCostItems.some((item: any) => item.name === '摄影')).toBe(false)
      expect(draft.config.months.every((month: any) => month.specialCosts.every((cost: any) => cost.itemId !== photography.id))).toBe(true)

      await closeHarness(harness)
    })
  }, 10_000)

  it('plans employee add/delete and workspace rename through model-selected tools', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      (body) => {
        expectProviderTools(body, ['employee_add'])
        return fakeToolResponse('employee_add', {
          newEmployeeName: '场务 C',
          role: '场务',
          monthlyBasePay: 3200,
          perEventCost: 180,
        })
      },
      (body) => {
        expectProviderTools(body, ['workspace_rename'])
        return fakeToolResponse('workspace_rename', { workspaceName: 'Agent 运营工作区' })
      },
      (body) => {
        expectProviderTools(body, ['employee_delete'])
        return fakeToolResponse('employee_delete', { employeeName: '场务 C' })
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-employee-rename-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-employee-rename-tools@example.com')

      async function confirm(action: any) {
        const response = await client.post(`/api/v1/agent/action-requests/${action.id}/confirm`)
        expect(response.statusCode).toBe(200)
        expect(response.json.actionRequest.status).toBe('executed')
        return response.json
      }

      const added = await client.post('/api/v1/agent/messages', { message: '新增员工，名字叫 场务 C，月薪 3200，每场 180' })
      expect(added.statusCode).toBe(200)
      expect(added.json.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(added.json.actionRequests[0].title).toContain('新增员工')
      expect(added.json.actionRequests[0].navigation.route.secondaryTab).toBe('cost')
      await confirm(added.json.actionRequests[0])
      let draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.employees.find((employee: any) => employee.name === '场务 C')?.monthlyBasePay).toBe(3200)

      const renamed = await client.post('/api/v1/agent/messages', { threadId: added.json.threadId, message: '把工作区改名为 Agent 运营工作区' })
      expect(renamed.statusCode).toBe(200)
      expect(renamed.json.actionRequests[0].kind).toBe('workspace.rename')
      expect(renamed.json.actionRequests[0].payload.workspaceName).toBe('Agent 运营工作区')
      await confirm(renamed.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).toBe('Agent 运营工作区')

      const deleted = await client.post('/api/v1/agent/messages', { threadId: added.json.threadId, message: '删除员工 场务 C' })
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json.actionRequests[0].title).toContain('删除员工')
      expect(deleted.json.actionRequests[0].riskLevel).toBe('high')
      await confirm(deleted.json.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.employees.some((employee: any) => employee.name === '场务 C')).toBe(false)

      await closeHarness(harness)
    })
  }, 10_000)

  it('plans a comprehensive operating model through one high-level editable confirmation', async () => {
    const months = [
      { monthIndex: 1, events: 0, salesMultiplier: 0, onlineSalesFactor: 0.35 },
      { monthIndex: 2, events: 4, salesMultiplier: 0.45, onlineSalesFactor: 0.35 },
      { monthIndex: 3, events: 6, salesMultiplier: 0.45, onlineSalesFactor: 0.35 },
      { monthIndex: 4, events: 8, salesMultiplier: 1, onlineSalesFactor: 0.35 },
      { monthIndex: 5, events: 8, salesMultiplier: 1, onlineSalesFactor: 0.35 },
      { monthIndex: 6, events: 8, salesMultiplier: 1, onlineSalesFactor: 0.35, extraIncome: 100000 },
      { monthIndex: 7, events: 10, salesMultiplier: 1.15, onlineSalesFactor: 0.35 },
      { monthIndex: 8, events: 10, salesMultiplier: 1.15, onlineSalesFactor: 0.35 },
      { monthIndex: 9, events: 10, salesMultiplier: 1.15, onlineSalesFactor: 0.35 },
      { monthIndex: 10, events: 12, salesMultiplier: 1.265, onlineSalesFactor: 0.35 },
      { monthIndex: 11, events: 12, salesMultiplier: 1.265, onlineSalesFactor: 0.35 },
      { monthIndex: 12, events: 12, salesMultiplier: 1.265, onlineSalesFactor: 0.35, extraIncome: 220000 },
    ]
    const operatingPlan = {
      workspaceName: '星河 50 期启动测算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68, polaroidLossRate: 0.06, revenueFeeRate: 0.03 },
      reservedDividendRate: 0.05,
      shareholders: [
        { name: '股东 A', investmentAmount: 300000, dividendRate: 0.35 },
        { name: '股东 B', investmentAmount: 200000, dividendRate: 0.25 },
        { name: '股东 C', investmentAmount: 150000, dividendRate: 0.2 },
        { name: '股东 D', investmentAmount: 100000, dividendRate: 0.15 },
      ],
      startupCosts: [
        { name: '场地押金和装修', amount: 180000 },
        { name: '设备灯光音响直播设备', amount: 120000 },
        { name: '服装和首批物料', amount: 80000 },
        { name: '招募拍摄宣发', amount: 60000 },
        { name: '法务注册合同财务', amount: 25000 },
        { name: '备用现金', amount: 85000 },
      ],
      memberSegments: [
        { label: '核心成员', namePrefix: '成员', count: 10, monthlyBasePay: 2500, commissionRate: 0.12, perEventTravelCost: 35, offlineUnitsPerEvent: 18, onlineUnitsPerEvent: 6 },
        { label: '普通成员', namePrefix: '成员', count: 25, monthlyBasePay: 1200, commissionRate: 0.1, perEventTravelCost: 35, offlineUnitsPerEvent: 8, onlineUnitsPerEvent: 3 },
        { label: '练习成员', namePrefix: '成员', count: 15, monthlyBasePayAfterMonth: 800, firstBasePayFreeMonths: 3, commissionRate: 0.08, perEventTravelCost: 35, offlineUnitsPerEvent: 3, onlineUnitsPerEvent: 1 },
      ],
      monthlyFixedCosts: [
        { name: '排练室和办公场地', amount: 45000 },
        { name: '运营办公室杂费', amount: 8000 },
        { name: '财务法务行政', amount: 6000 },
        { name: '平台工具云服务剪辑工具', amount: 5000 },
        { name: '保险和基础福利', amount: 12000 },
      ],
      employees: [
        { role: '运营负责人', count: 1, monthlyBasePay: 18000 },
        { role: '经纪统筹', count: 2, monthlyBasePay: 12000 },
        { role: '编舞老师', count: 2, monthlyBasePay: 10000 },
        { role: '摄影剪辑', count: 2, monthlyBasePay: 9000 },
        { role: '直播运营', count: 2, monthlyBasePay: 8500 },
        { role: '行政财务', count: 1, monthlyBasePay: 8000 },
        { role: '现场执行兼职', count: 1, perEventCost: 2000 },
      ],
      perEventCosts: [
        { name: '场地执行成本', amount: 6000 },
        { name: '摄影摄像', amount: 2500 },
        { name: '妆造', amount: 4000 },
        { name: '直播推流', amount: 1800 },
        { name: '安保和检票', amount: 1200 },
      ],
      perUnitCosts: [{ name: '物料消耗', amount: 6 }],
      monthlyMarketing: [
        { monthIndex: 1, amount: 50000 },
        { monthIndex: 2, amount: 40000 },
        { monthIndex: 3, amount: 30000 },
        { monthIndex: 4, amount: 25000 },
        { monthIndex: 5, amount: 25000 },
        { monthIndex: 6, amount: 25000 },
        { monthIndex: 7, amount: 35000 },
        { monthIndex: 8, amount: 35000 },
        { monthIndex: 9, amount: 35000 },
        { monthIndex: 10, amount: 35000 },
        { monthIndex: 11, amount: 35000 },
        { monthIndex: 12, amount: 35000 },
      ],
      specialEvents: [
        { monthIndex: 6, name: '中型活动', extraCost: 60000, extraIncome: 100000 },
        { monthIndex: 12, name: '周年活动', extraCost: 120000, extraIncome: 220000 },
      ],
      months,
      assumptions: ['未明确的杂项费用已按当前字段留空，不新增隐藏成本。'],
    }

    await withFakeOpenAICompatibleProvider((body) => {
      const toolNames = new Set(body.tools.map((tool: any) => tool.function.name))
      expect(toolNames.has('workspace_configure_operating_model')).toBe(true)
      return fakeToolResponse('workspace_configure_operating_model', { plan: operatingPlan })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-operating-model-tool', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-operating-model-tool@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '按这份投资、50 个成员、员工、成本和 12 个月节奏生成经营模型，所有写入先给确认卡。',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(1)
      expect(planned.json.planSteps.length).toBeGreaterThanOrEqual(2)
      const action = planned.json.actionRequests[0]
      expect(action.kind).toBe('workspace.update_draft')
      expect(action.riskLevel).toBe('high')
      expect(action.title).toContain('完整经营模型')
      expect(action.navigation.route).toMatchObject({ mainTab: 'inputs', secondaryTab: 'capital' })
      expect(action.details.some((detail: any) => detail.label === '最亏月份')).toBe(true)
      expect(action.payload.workspaceName).toBe('星河 50 期启动测算')
      expect(action.payload.config.shareholders).toHaveLength(5)
      expect(action.payload.config.teamMembers).toHaveLength(50)
      expect(action.payload.config.teamMembers.at(49).name).toBe('成员 50')
      expect(action.payload.config.employees).toHaveLength(11)
      expect(action.payload.config.months.map((month: any) => month.events)).toEqual(months.map((month) => month.events))
      expect(action.payload.assumptions.some((item: string) => item.includes('阶段性保底'))).toBe(true)

      const confirmed = await client.post(`/api/v1/agent/action-requests/${action.id}/confirm`)
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json.actionRequest.status).toBe('executed')
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).toBe('星河 50 期启动测算')
      expect(draft.config.planning).toMatchObject({ startMonth: 3, horizonMonths: 12 })
      expect(draft.config.teamMembers).toHaveLength(50)
      expect(draft.config.months).toHaveLength(12)
      const base = projectModel(draft.config).scenarios.find((scenario) => scenario.key === 'base')
      expect(base?.grossSales).toBeGreaterThan(0)
      expect(base?.totalCost).toBeGreaterThan(0)
      expect(base?.months.find((month) => month.monthIndex === 6)?.grossSales).toBeGreaterThan(0)

      const autoPlanned = await client.post('/api/v1/agent/messages', {
        threadId: planned.json.threadId,
        message: '再次按同一份经营模型生成草稿，这次开启最高自动化。',
        automationLevel: 'high',
      })
      expect(autoPlanned.statusCode).toBe(200)
      expect(autoPlanned.json.automationLevel).toBe('high')
      expect(autoPlanned.json.actionRequests).toHaveLength(1)
      expect(autoPlanned.json.actionRequests[0].status).toBe('pending')
      expect(autoPlanned.json.planSteps.find((step: any) => step.actionRequestId === autoPlanned.json.actionRequests[0].id)?.status).toBe('ready')
      expect(autoPlanned.json.runEvents.some((event: any) => event.type === 'action_auto_executed')).toBe(false)
      const autoDraft = (await client.get('/api/v1/workspace/draft')).json
      expect(autoDraft.workspaceName).toBe('星河 50 期启动测算')
      expect(autoDraft.config.teamMembers).toHaveLength(50)

      await closeHarness(harness)
    })
  })

  it('recovers a long operating-model tool call when a preceding rename streamed successfully', async () => {
    const months = Array.from({ length: 12 }, (_, index) => ({
      monthIndex: index + 1,
      events: index === 0 ? 0 : index < 3 ? 4 : 8,
      salesMultiplier: index === 0 ? 0 : index < 3 ? 0.45 : 1,
      onlineSalesFactor: 0.35,
    }))
    const operatingPlan = {
      workspaceName: '星河 50 期启动测算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68, polaroidLossRate: 0.06 },
      shareholders: [
        { name: '股东 A', investmentAmount: 300000, dividendRate: 0.35 },
        { name: '股东 B', investmentAmount: 200000, dividendRate: 0.25 },
      ],
      memberSegments: [
        { label: '核心成员', namePrefix: '成员', count: 10, monthlyBasePay: 2500, commissionRate: 0.12, perEventTravelCost: 35, offlineUnitsPerEvent: 18, onlineUnitsPerEvent: 6 },
        { label: '普通成员', namePrefix: '成员', count: 25, monthlyBasePay: 1200, commissionRate: 0.1, perEventTravelCost: 35, offlineUnitsPerEvent: 8, onlineUnitsPerEvent: 3 },
        { label: '练习成员', namePrefix: '成员', count: 15, monthlyBasePayAfterMonth: 800, firstBasePayFreeMonths: 3, commissionRate: 0.08, perEventTravelCost: 35, offlineUnitsPerEvent: 3, onlineUnitsPerEvent: 1 },
      ],
      employees: [
        { role: '运营负责人', count: 1, monthlyBasePay: 18000 },
        { role: '现场执行兼职', count: 1, perEventCost: 2000 },
      ],
      monthlyFixedCosts: [{ name: '排练室和办公场地', amount: 45000 }],
      perEventCosts: [{ name: '场地执行成本', amount: 6000 }],
      perUnitCosts: [{ name: '物料消耗', amount: 6 }],
      months,
    }

    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      planningCalls += 1
      if (planningCalls === 1) {
        return {
          __stream: [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'call_rename',
                    type: 'function',
                    function: {
                      name: 'workspace_rename',
                      arguments: '{"workspaceName":"星河 50 期启动测算"}',
                    },
                  }],
                },
              }],
            },
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 1,
                    id: 'call_operating_model',
                    type: 'function',
                    function: {
                      name: 'workspace_configure_operating_model',
                      arguments: '{"plan":{"workspaceName":"星河 50 期启动测算"',
                    },
                  }],
                },
              }],
            },
          ],
        }
      }
      expect(body.tools.map((tool: any) => tool.function.name)).toContain('workspace_configure_operating_model')
      return fakeToolResponse('workspace_configure_operating_model', { plan: operatingPlan })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-operating-model-retry-after-rename', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-operating-model-retry-after-rename@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '先把项目改名为星河 50 期启动测算，然后生成 50 个成员和 12 个月经营模型。',
        automationLevel: 'high',
      })
      expect(planned.statusCode).toBe(200)
      expect(planningCalls).toBeGreaterThanOrEqual(2)
      expect(planned.json.actionRequests.map((action: any) => action.kind)).toEqual(['workspace.update_draft'])
      expect(planned.json.actionRequests[0].status).toBe('pending')
      expect(planned.json.actionRequests[0].payload.source).toBe('workspace_configure_operating_model')
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'provider_retrying' &&
        event.data?.retryTool === 'workspace_configure_operating_model',
      )).toBe(true)
      expect(planned.json.evaluations?.[0]?.status ?? planned.json.goals?.[0]?.status).not.toBe('failed')
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).not.toBe('星河 50 期启动测算')
      expect(draft.config.teamMembers).not.toHaveLength(50)
      await closeHarness(harness)
    }, {
      capabilities: ['draft'],
      requiredActionCapabilities: ['draft'],
      goalFacts: {
        workspaceName: '星河 50 期启动测算',
        expectedMemberCount: 50,
        expectedShareholderCount: 2,
        expectedHorizonMonths: 12,
        expectedStartMonth: 3,
        requiresForecastSummary: true,
        forbiddenActions: ['publish_release'],
      },
    })
  }, 10_000)

  it('repairs bounded prefix/suffix pollution in streamed tool-call arguments before creating cards', async () => {
    await withFakeOpenAICompatibleProvider(() => ({
      __stream: [
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_0_workspace_rename',
                type: 'function',
                function: {
                  name: 'workspace_rename',
                  arguments: '.functions.workspace_rename:0 {"workspaceName":"流式修复工作区"}x',
                },
              }],
            },
          }],
        },
      ],
    }), async (baseUrl) => {
      const harness = await buildHarness('agent-stream-argument-repair', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-stream-argument-repair@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把工作区改名为“流式修复工作区”。',
        automationLevel: 'high',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.actionRequests).toHaveLength(1)
      expect(planned.json.actionRequests[0].kind).toBe('workspace.rename')
      expect(planned.json.actionRequests[0].status).toBe('executed')
      expect(planned.json.runEvents.some((event: any) => event.type === 'provider_tool_call_repaired')).toBe(true)
      expect(planned.json.runEvents.some((event: any) => event.type === 'action_auto_executed')).toBe(true)
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).toBe('流式修复工作区')
      await closeHarness(harness)
    }, { capabilities: ['draft'], requiredActionCapabilities: ['draft'] })
  })

  it('fails closed instead of returning 500 when non-stream tool-call arguments remain malformed after retry', async () => {
    let calls = 0
    await withFakeOpenAICompatibleProvider(() => {
      calls += 1
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_broken_operating_model',
              type: 'function',
              function: {
                name: 'workspace_configure_operating_model',
                arguments: '{"plan":{"workspaceName":"损坏的复杂模型"',
              },
            }],
          },
        }],
      }
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-non-stream-tool-parse-fail-closed', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-non-stream-tool-parse-fail-closed@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '生成一个 50 个成员、12 个月预测的复杂经营模型。',
        automationLevel: 'high',
      })
      expect(response.statusCode).toBe(200)
      expect(calls).toBeGreaterThanOrEqual(2)
      expect(response.json.actionRequests).toHaveLength(0)
      expect(response.json.planSteps.some((step: any) =>
        step.status === 'failed' &&
        String(step.title).includes('工具调用未形成可执行参数'),
      )).toBe(true)
      await closeHarness(harness)
    }, {
      capabilities: ['draft'],
      requiredActionCapabilities: ['draft'],
      goalFacts: {
        workspaceName: '星河 50 期启动测算',
        expectedMemberCount: 50,
        expectedShareholderCount: 5,
        expectedHorizonMonths: 12,
        expectedStartMonth: 3,
        requiresForecastSummary: true,
        forbiddenActions: ['publish_release'],
      },
    })
  })

  it('deduplicates a redundant workspace rename when the operating-model action owns the same name', async () => {
    const operatingPlan = {
      workspaceName: '星河 50 期启动测算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68 },
      shareholders: [{ name: '股东 A', investmentAmount: 300000, dividendRate: 1 }],
      memberSegments: [{ label: '成员', namePrefix: '成员', count: 50, monthlyBasePay: 1000, commissionRate: 0.1, offlineUnitsPerEvent: 5, onlineUnitsPerEvent: 2 }],
      employees: [{ role: '运营', count: 1, monthlyBasePay: 10000 }],
      monthlyFixedCosts: [{ name: '房租', amount: 10000 }],
      perEventCosts: [{ name: '场地', amount: 1000 }],
      perUnitCosts: [{ name: '物料', amount: 6 }],
      months: Array.from({ length: 12 }, (_, index) => ({
        monthIndex: index + 1,
        events: index === 0 ? 0 : 4,
        salesMultiplier: index === 0 ? 0 : 1,
        onlineSalesFactor: 0.35,
      })),
    }

    await withFakeOpenAICompatibleProvider(() => fakeToolResponses([
      { name: 'workspace_rename', args: { workspaceName: '星河 50 期启动测算' } },
      { name: 'workspace_configure_operating_model', args: { plan: operatingPlan } },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-operating-model-dedup-rename', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-operating-model-dedup-rename@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '先改名为星河 50 期启动测算，再生成完整经营模型。',
        automationLevel: 'high',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.actionRequests).toHaveLength(1)
      expect(planned.json.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(planned.json.actionRequests[0].status).toBe('pending')
      expect(planned.json.actionRequests[0].payload.workspaceName).toBe('星河 50 期启动测算')
      expect(planned.json.runEvents.some((event: any) =>
        event.type === 'action_auto_execution_failed',
      )).toBe(false)
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).not.toBe('星河 50 期启动测算')
      expect(draft.config.teamMembers).not.toHaveLength(50)
      await closeHarness(harness)
    }, { capabilities: ['draft'], requiredActionCapabilities: ['draft'] })
  })

  it('does not complete a complex operating-model goal after only renaming the workspace', async () => {
    const operatingPlan = {
      workspaceName: '星河 50 期启动测算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68 },
      shareholders: [
        { name: '股东 A', investmentAmount: 300000, dividendRate: 0.35 },
        { name: '股东 B', investmentAmount: 200000, dividendRate: 0.25 },
        { name: '股东 C', investmentAmount: 150000, dividendRate: 0.2 },
        { name: '股东 D', investmentAmount: 100000, dividendRate: 0.15 },
        { name: '员工激励池', investmentAmount: 0, dividendRate: 0.05 },
      ],
      memberSegments: [
        { label: '核心成员', namePrefix: '成员', count: 10, monthlyBasePay: 2500, commissionRate: 0.12, perEventTravelCost: 35, offlineUnitsPerEvent: 18, onlineUnitsPerEvent: 6 },
        { label: '普通成员', namePrefix: '成员', count: 25, monthlyBasePay: 1200, commissionRate: 0.1, perEventTravelCost: 35, offlineUnitsPerEvent: 8, onlineUnitsPerEvent: 3 },
        { label: '练习成员', namePrefix: '成员', count: 15, monthlyBasePayAfterMonth: 800, firstBasePayFreeMonths: 3, commissionRate: 0.08, perEventTravelCost: 35, offlineUnitsPerEvent: 3, onlineUnitsPerEvent: 1 },
      ],
      employees: [{ role: '运营负责人', count: 1, monthlyBasePay: 18000 }],
      monthlyFixedCosts: [{ name: '排练室和办公场地', amount: 45000 }],
      perEventCosts: [{ name: '场地执行成本', amount: 6000 }],
      perUnitCosts: [{ name: '物料消耗', amount: 6 }],
      months: Array.from({ length: 12 }, (_, index) => ({
        monthIndex: index + 1,
        events: index === 0 ? 0 : index < 3 ? 4 : 8,
        salesMultiplier: index === 0 ? 0 : index < 3 ? 0.45 : 1,
        onlineSalesFactor: 0.35,
      })),
    }

    let planningCalls = 0
    await withFakeOpenAICompatibleProvider(() => {
      planningCalls += 1
      if (planningCalls === 1) return fakeToolResponse('workspace_rename', { workspaceName: '星河 50 期启动测算' })
      return fakeToolResponse('workspace_configure_operating_model', { plan: operatingPlan })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-complex-goal-facts-rename-only', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-complex-goal-facts-rename-only@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: [
          '项目名称：星河 50 期启动测算',
          '周期：从 2026 年 3 月开始，预测 12 个月。',
          '团队规模：按 50 个成员来做。',
          '投资和股东：股东 A 投资 300000，占分红 35%，股东 B 投资 200000，占分红 25%，股东 C 投资 150000，占分红 20%，股东 D 投资 100000，占分红 15%，预留员工激励池 5%。',
          '请生成 12 个月预测结果，回答总收入、总成本、总利润、期末现金、回本月份。先不要发布正式版本。',
        ].join('，'),
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(planningCalls).toBe(2)
      expect(state.statusCode).toBe(200)
      expect(state.json.evaluations.map((evaluation: any) => evaluation.status)).toContain('needs_confirmation')
      const confirmationEvaluation = state.json.evaluations.find((evaluation: any) => evaluation.status === 'needs_confirmation')
      expect(confirmationEvaluation?.satisfiedCriteria).toContain('goal.expected_member_count')
      expect(confirmationEvaluation?.satisfiedCriteria).toContain('goal.no_publish_requested')
      const action = state.json.actionRequests.find((item: any) => item.payload?.source === 'workspace_configure_operating_model')
      expect(action.payload.workspaceName).toBe('星河 50 期启动测算')
      expect(action.payload.config.teamMembers).toHaveLength(50)
      expect(action.payload.config.shareholders).toHaveLength(5)
      expect(action.payload.config.planning).toMatchObject({ startMonth: 3, horizonMonths: 12 })
      await closeHarness(harness)
    }, {
      capabilities: ['draft'],
      requiredActionCapabilities: ['draft'],
      goalFacts: {
        workspaceName: '星河 50 期启动测算',
        expectedMemberCount: 50,
        expectedShareholderCount: 5,
        expectedHorizonMonths: 12,
        expectedStartMonth: 3,
        requiresForecastSummary: true,
        forbiddenActions: ['publish_release'],
      },
    })
  })

  it('fills operating-model workspace name from the original goal when the model omits or mangles it in long arguments', async () => {
    const operatingPlan = {
      workspaceName: '星河50期启动测算',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 88, onlineUnitPrice: 68 },
      shareholders: [{ name: '股东 A', investmentAmount: 100000, dividendRate: 1 }],
      memberSegments: [{ label: '成员', namePrefix: '成员', count: 50, monthlyBasePay: 1000, commissionRate: 0.1, offlineUnitsPerEvent: 5, onlineUnitsPerEvent: 2 }],
      employees: [{ role: '运营', count: 1, monthlyBasePay: 10000 }],
      monthlyFixedCosts: [{ name: '房租', amount: 10000 }],
      perEventCosts: [{ name: '场地', amount: 1000 }],
      perUnitCosts: [{ name: '物料', amount: 6 }],
      months: Array.from({ length: 12 }, (_, index) => ({
        monthIndex: index + 1,
        events: index === 0 ? 0 : 4,
        salesMultiplier: index === 0 ? 0 : 1,
        onlineSalesFactor: 0.35,
      })),
    }

    await withFakeOpenAICompatibleProvider(() =>
      fakeToolResponse('workspace_configure_operating_model', { plan: operatingPlan }),
    async (baseUrl) => {
      const harness = await buildHarness('agent-operating-model-goal-name-fill', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-operating-model-goal-name-fill@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '项目=星河 50 期启动测算；请生成并保存 50 个成员、12 个月的完整经营模型。',
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.actionRequests[0].payload.workspaceName).toBe('星河 50 期启动测算')
      expect(response.json.actionRequests[0].status).toBe('pending')
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).not.toBe('星河 50 期启动测算')
      expect(draft.config.teamMembers).not.toHaveLength(50)
      await closeHarness(harness)
    }, {
      capabilities: ['draft'],
      requiredActionCapabilities: ['draft'],
      goalFacts: { workspaceName: '星河 50 期启动测算' },
    })
  })

  it('iterates through Agentic OS harness until readiness and final response checks verify the repaired operating model', async () => {
    const months = Array.from({ length: 12 }, (_, index) => ({
      monthIndex: index + 1,
      events: 4,
      salesMultiplier: 1,
      onlineSalesFactor: 0.2,
    }))
    const emptyPlan = {
      workspaceName: '空预测模型',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 0, onlineUnitPrice: 0 },
      shareholders: [{ name: '空股东', investmentAmount: 0, dividendRate: 0 }],
      memberSegments: [{ label: '空成员', namePrefix: '空成员', count: 1, monthlyBasePay: 0, commissionRate: 0, offlineUnitsPerEvent: 0, onlineUnitsPerEvent: 0 }],
      employees: [{ role: '空岗位', count: 1, monthlyBasePay: 0, perEventCost: 0 }],
      monthlyFixedCosts: [{ name: '空固定成本', amount: 0 }],
      perEventCosts: [{ name: '空每场成本', amount: 0 }],
      perUnitCosts: [{ name: '空每张成本', amount: 0 }],
      months: months.map((month) => ({ ...month, events: 0, salesMultiplier: 0, onlineSalesFactor: 0 })),
    }
    const repairedPlan = {
      workspaceName: '修复后经营模型',
      planning: { startMonth: 3, horizonMonths: 12 },
      operating: { offlineUnitPrice: 100, onlineUnitPrice: 50, polaroidLossRate: 0.05 },
      shareholders: [
        { name: '股东 A', investmentAmount: 120000, dividendRate: 0.6 },
        { name: '股东 B', investmentAmount: 80000, dividendRate: 0.4 },
      ],
      memberSegments: [{ label: '核心成员', namePrefix: '成员', count: 2, monthlyBasePay: 1000, commissionRate: 0.1, perEventTravelCost: 20, offlineUnitsPerEvent: 10, onlineUnitsPerEvent: 2 }],
      employees: [{ role: '运营', count: 1, monthlyBasePay: 5000, perEventCost: 0 }],
      monthlyFixedCosts: [{ name: '房租', amount: 1000 }],
      perEventCosts: [{ name: '场务', amount: 300 }],
      perUnitCosts: [{ name: '物料', amount: 3 }],
      months,
    }

    let planningCalls = 0
    await withFakeOpenAICompatibleProvider((body) => {
      const toolNames = new Set(body.tools.map((tool: any) => tool.function.name))
      expect(toolNames.has('workspace_configure_operating_model')).toBe(true)
      planningCalls += 1
      return fakeToolResponse('workspace_configure_operating_model', { plan: planningCalls === 1 ? emptyPlan : repairedPlan })
    }, async (baseUrl) => {
      const harness = await buildHarness('agentic-os-loop', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agentic-os-loop@example.com')

      const response = await client.post('/api/v1/agent/messages', {
        message: '构建 12 个月经营模型。如果预测结果为空，你必须继续修复，直到 evaluator 确认草稿有有效收入或成本。',
        automationLevel: 'high',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json.planner).toBe('openai_compatible_tool_calls')
      expect(planningCalls).toBe(2)
      expect(response.json.actionRequests).toHaveLength(2)
      expect(response.json.actionRequests.every((action: any) => action.status === 'pending')).toBe(true)
      expect(response.json.planSteps.map((step: any) => step.sequence)).toEqual([1, 2, 3, 4])

      const state = await client.get(`/api/v1/agent/threads/${response.json.threadId}`)
      expect(state.statusCode).toBe(200)
      expect(state.json.goals).toHaveLength(1)
      expect(state.json.goals[0].status).toBe('waiting_for_confirmation')
      expect(state.json.evaluations.map((evaluation: any) => evaluation.status)).toEqual(['continue', 'needs_confirmation'])
      expect(state.json.evaluations[0].unsatisfiedCriteria.some((finding: any) => finding.id === 'graph.operating_model_inputs_planned')).toBe(true)
      expect(state.json.runEvents.filter((event: any) => event.type === 'goal_iteration_started')).toHaveLength(2)
      expect(state.json.runEvents.some((event: any) => event.type === 'confirmation_ready')).toBe(true)
      expect(response.json.actionRequests.at(-1).payload.workspaceName).toBe('修复后经营模型')
      expect(response.json.actionRequests.at(-1).payload.config.teamMembers).toHaveLength(2)
      const draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.workspaceName).not.toBe('修复后经营模型')
      const base = projectModel(draft.config).scenarios.find((scenario) => scenario.key === 'base')
      expect(base?.grossSales).toBeGreaterThan(0)
      expect(base?.totalCost).toBeGreaterThan(0)

      await closeHarness(harness)
    }, { observationContinuationResponse: false })
  })

  it('plans generic income, generic expense, and per-person member/employee expenses', async () => {
    const provider = mutableScriptedProvider(fakeAssistantTextResponse('已完成本轮记账。'))
    await withFakeOpenAICompatibleProvider(provider.handler, async (baseUrl) => {
      const harness = await buildHarness('agent-generic-ledger-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-generic-ledger-tools@example.com')

      async function sendAndConfirm(message: string, toolArgs: Record<string, unknown>) {
        provider.setStep(() => fakeToolResponse('ledger_create_entry', toolArgs))
        const planned = await client.post('/api/v1/agent/messages', { message })
        expect(planned.statusCode).toBe(200)
        expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
        const confirmed = await client.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
        expect(confirmed.statusCode).toBe(200)
        expect(confirmed.json.actionRequest.status).toBe('executed')
        return { planned: planned.json, confirmed: confirmed.json }
      }

      const otherIncome = await sendAndConfirm('3 月记一笔其他收入 500，场地方退款', {
        monthLabel: '3月',
        direction: 'revenue',
        subjectKey: 'cost.other.refund',
        amount: 500,
        date: '2026-03-08',
        counterparty: '场地方退款',
        description: '其他收入测试',
      })
      expect(otherIncome.planned.actionRequests[0].payload.direction).toBe('income')
      expect(otherIncome.confirmed.result.amount).toBe(500)

      const genericExpense = await sendAndConfirm('3 月记一笔普通支出 300，排练费', {
        monthLabel: '3月',
        direction: 'expense',
        subjectKey: 'cost.training.rehearsal',
        amount: 300,
        occurredAt: '2026-03-09',
        description: '排练普通支出',
      })
      expect(genericExpense.planned.actionRequests[0].payload.direction).toBe('expense')

      const memberExpense = await sendAndConfirm('3 月给成员 A 底薪入账 1000', {
        monthLabel: '3月',
        direction: 'expense',
        subjectKey: 'cost.member.base_pay',
        amount: 1000,
        relatedEntityType: 'teamMember',
        relatedEntityName: '成员 A',
      })
      expect(memberExpense.planned.actionRequests[0].payload.relatedEntityType).toBe('teamMember')
      expect(memberExpense.confirmed.result.relatedEntityName).toBe('成员 A')

      const employeeExpense = await sendAndConfirm('3 月给员工 A 月薪入账 2500', {
        monthLabel: '3月',
        direction: 'expense',
        subjectKey: 'cost.employee.base_pay',
        amount: 2500,
        relatedEntityType: 'employee',
        relatedEntityName: '员工 A',
      })
      expect(employeeExpense.planned.actionRequests[0].payload.relatedEntityType).toBe('employee')
      expect(employeeExpense.confirmed.result.relatedEntityName).toBe('员工 A')

      const periodId = otherIncome.planned.navigationEvents[0].route.selectedPeriodId
      const entries = (await client.get(`/api/v1/ledger/entries?periodId=${periodId}`)).json
      expect(entries.filter((entry: any) => entry.entryOrigin === 'manual')).toHaveLength(4)
      await closeHarness(harness)
    })
  }, 20_000)

  it('expands batch planned ledger tools into multiple editable confirmation cards', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponses([
      { name: 'ledger_create_planned_member_income_batch', args: { monthLabel: '3月' } },
      { name: 'ledger_create_planned_related_expense_batch', args: { monthLabel: '3月', subjectKey: 'cost.employee.per_event' } },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-batch-ledger-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-batch-ledger-tools@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月所有成员计划收入一键入账，并把 3 月员工场次支出按计划一键入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.actionRequests.length).toBeGreaterThan(3)
      expect(planned.json.actionRequests.every((action: any) => action.kind === 'ledger.create_entry')).toBe(true)
      expect(planned.json.planSteps).toHaveLength(planned.json.actionRequests.length)
      expect(planned.json.actionRequests.some((action: any) => action.title.includes('成员收入'))).toBe(true)
      expect(planned.json.actionRequests.some((action: any) => action.payload.relatedEntityType === 'employee')).toBe(true)

      const edited = await client.patch(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}`, {
        summary: '编辑后：批量第一笔确认卡仍可修改金额。',
        details: [{ label: '入账金额', value: '88' }],
        payload: {
          ...planned.json.actionRequests[0].payload,
          amount: 88,
          allocations: [{ ...planned.json.actionRequests[0].payload.allocations[0], amount: 88 }],
        },
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json.planSteps[0].description).toContain('批量第一笔')

      await closeHarness(harness)
    }, { capabilities: ['ledger'], requiredActionCapabilities: ['ledger'] })
  })

  it('plans ledger update, precise void, and restore from model-selected locators', async () => {
    let entryId = ''
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('ledger_update_entry', { monthLabel: '3月', entryId, newAmount: 456, description: 'Agent 修改历史分录' }),
      () => fakeToolResponse('ledger_void_entry', { monthLabel: '3月', entryId }),
      () => fakeToolResponse('ledger_restore_entry', { monthLabel: '3月', entryId }),
      () => fakeToolResponse('ledger_void_entry', { monthLabel: '4月', entryId }),
      () => fakeToolResponse('ledger_restore_entry', { monthLabel: '3月', entryId }),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-ledger-edit-void-restore', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-ledger-edit-void-restore@example.com')
      const period = (await client.get('/api/v1/ledger/periods')).json.find((item: any) => item.monthLabel === '3月')
      const subjects = (await client.get(`/api/v1/ledger/periods/${period.id}/subjects`)).json
      const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))
      const created = await client.post('/api/v1/ledger/entries', {
        ledgerPeriodId: period.id,
        direction: 'expense',
        amount: 123,
        occurredAt: '2026-03-11T12:00:00.000Z',
        description: '待修改排练费',
        allocations: [{ ...subjectMap['cost.training.rehearsal'], amount: 123 }],
      })
      expect(created.statusCode).toBe(200)
      entryId = created.json.id

      async function sendAndConfirm(message: string) {
        const planned = await client.post('/api/v1/agent/messages', { message })
        expect(planned.statusCode).toBe(200)
        const confirmed = await client.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
        expect(confirmed.statusCode).toBe(200)
        expect(confirmed.json.actionRequest.status).toBe('executed')
        return { planned: planned.json, confirmed: confirmed.json }
      }

      const updated = await sendAndConfirm(`修改 entry:${created.json.id} 金额为 456`)
      expect(updated.planned.actionRequests[0].kind).toBe('ledger.update_entry')
      expect(updated.confirmed.result.amount).toBe(456)
      expect(updated.confirmed.result.description).toBe('Agent 修改历史分录')

      const voided = await sendAndConfirm(`精确作废 entry:${created.json.id}`)
      expect(voided.planned.actionRequests[0].kind).toBe('ledger.void_entry')
      expect((await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json.find((entry: any) => entry.id === created.json.id).status).toBe('voided')

      const restored = await sendAndConfirm(`恢复 entry:${created.json.id}`)
      expect(restored.planned.actionRequests[0].kind).toBe('ledger.restore_entry')
      expect((await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json.find((entry: any) => entry.id === created.json.id).status).toBe('posted')

      const wrongMonthVoided = await sendAndConfirm(`错月作废 entry:${created.json.id}`)
      expect(wrongMonthVoided.planned.actionRequests[0].kind).toBe('ledger.void_entry')
      expect(wrongMonthVoided.planned.actionRequests[0].targetLabel).toContain('3月')
      expect((await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json.find((entry: any) => entry.id === created.json.id).status).toBe('voided')

      const restoredAfterWrongMonth = await sendAndConfirm(`恢复 entry:${created.json.id}`)
      expect(restoredAfterWrongMonth.planned.actionRequests[0].kind).toBe('ledger.restore_entry')
      expect((await client.get(`/api/v1/ledger/entries?periodId=${period.id}`)).json.find((entry: any) => entry.id === created.json.id).status).toBe('posted')

      await closeHarness(harness)
    })
  }, 20_000)

  it('promotes a selected snapshot to a new release through an Agent confirmation', async () => {
    await withFakeOpenAICompatibleProvider(() => fakeToolResponse('workspace_promote_version', { versionNo: 1 }), async (baseUrl) => {
      const harness = await buildHarness('agent-promote-snapshot', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-promote-snapshot@example.com')
      let draft = (await client.get('/api/v1/workspace/draft')).json
      draft.config.operating.offlineUnitPrice = 123
      await client.patch('/api/v1/workspace/draft', { revision: draft.revision, workspaceName: draft.workspaceName, config: draft.config })
      const snapshot = await client.post('/api/v1/workspace/versions', { kind: 'snapshot', name: '可发布快照' })
      expect(snapshot.json.versionNo).toBe(1)
      draft = (await client.get('/api/v1/workspace/draft')).json
      draft.config.operating.offlineUnitPrice = 456
      await client.patch('/api/v1/workspace/draft', { revision: draft.revision, workspaceName: draft.workspaceName, config: draft.config })

      const planned = await client.post('/api/v1/agent/messages', { message: '把快照 1 发布为正式版' })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.actionRequests[0].kind).toBe('workspace.promote_version')
      expect(planned.json.actionRequests[0].navigation.panel).toBe('workspace')
      const confirmed = await client.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json.actionRequest.status).toBe('executed')
      expect(confirmed.json.result.version.kind).toBe('release')

      const versions = (await client.get('/api/v1/workspace/versions')).json
      const promotedRelease = versions.find((version: any) => version.versionNo === 2)
      expect(promotedRelease.kind).toBe('release')
      const publicDraft = (await client.get('/api/v1/workspace/draft')).json
      expect(publicDraft.config.operating.offlineUnitPrice).toBe(123)

      await closeHarness(harness)
    })
  })

  it('answers variance deep questions and ledger history filters with visible navigation filters', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('data_query_workspace', {
          question: '3 月排练费差异为什么这么大',
          scope: 'variance_detail',
          monthLabel: '3月',
          subjectKey: 'cost.training.rehearsal',
          keyword: '排练',
      }),
      () => fakeToolResponse('data_query_workspace', {
        question: '筛选 3 月 2026-03-12 已作废 排练',
        scope: 'ledger_history',
        monthLabel: '3月',
        entryStatus: 'voided',
        dateMode: 'day',
        day: '2026-03-12',
        keyword: '排练',
      }),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-data-deep-filter', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-data-deep-filter@example.com')
      const period = (await client.get('/api/v1/ledger/periods')).json.find((item: any) => item.monthLabel === '3月')
      const subjects = (await client.get(`/api/v1/ledger/periods/${period.id}/subjects`)).json
      const subjectMap = Object.fromEntries(subjects.map((item: any) => [item.subjectKey, item]))
      const created = await client.post('/api/v1/ledger/entries', {
        ledgerPeriodId: period.id,
        direction: 'expense',
        amount: 777,
        occurredAt: '2026-03-12T12:00:00.000Z',
        description: '排练异常支出',
        allocations: [{ ...subjectMap['cost.training.rehearsal'], amount: 777 }],
      })
      expect(created.statusCode).toBe(200)
      await client.post(`/api/v1/ledger/entries/${created.json.id}/void`)

      const variance = await client.post('/api/v1/agent/messages', { message: '3 月排练费差异为什么这么大？' })
      expect(variance.statusCode).toBe(200)
      expect(variance.json.actionRequests).toHaveLength(0)
      expect(variance.json.navigationEvents[0].route.mainTab).toBe('variance')
      expect(variance.json.messages.at(-1).content).toContain('排练')

      const history = await client.post('/api/v1/agent/messages', { threadId: variance.json.threadId, message: '账本历史筛选 3 月 2026-03-12 已作废 排练' })
      expect(history.statusCode).toBe(200)
      expect(history.json.actionRequests).toHaveLength(0)
      expect(history.json.navigationEvents[0].route.mainTab).toBe('bookkeeping')
      expect(history.json.navigationEvents[0].ledgerFilters).toEqual(expect.objectContaining({
        status: 'voided',
        dateMode: 'day',
        day: '2026-03-12',
        keyword: '排练',
      }))
      expect(history.json.messages.at(-1).content).toContain('命中 1 笔')

      await closeHarness(harness)
    })
  }, 15_000)

  it('validates a broad Agent OS capability matrix through backend APIs', async () => {
    const provider = mutableScriptedProvider(fakeToolResponse('ui_navigate', { mainTab: 'dashboard', secondaryTab: 'overview' }))
    await withFakeOpenAICompatibleProvider(provider.handler, async (baseUrl) => {
      const harness = await buildHarness('agent-capability-matrix', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-capability-matrix@example.com')

      async function send(message: string, step: FakeProviderScriptStep, threadId?: string) {
        provider.setStep(step)
        const response = await client.post('/api/v1/agent/messages', { ...(threadId ? { threadId } : {}), message })
        expect(response.statusCode).toBe(200)
        expect(response.json.planner).toBe('openai_compatible_tool_calls')
        return response.json
      }

      async function confirm(action: any) {
        const response = await client.post(`/api/v1/agent/action-requests/${action.id}/confirm`)
        expect(response.statusCode).toBe(200)
        expect(response.json.actionRequest.status).toBe('executed')
        return response.json
      }

      const remembered = await send('记住：默认记账成员是 成员 A', () => fakeToolResponse('memory_remember', {
        value: '默认记账成员是 成员 A',
        kind: 'preference',
        key: 'user.preference.defaultLedgerMember',
      }))
      const memories = await client.get('/api/v1/agent/memories')
      expect(memories.json.memories).toHaveLength(1)
      expect(memories.json.memories[0].value).toContain('成员 A')

      const defaultMemberLedger = await send('把 3 月默认成员线下 1 张入账', (body) => {
        const prompt = body.messages.map((message: any) => message.content).join('\n')
        expect(prompt).toContain('默认记账成员是 成员 A')
        expect(prompt).toContain('tenantScopedMemory')
        return fakeToolResponse('ledger_create_member_income', {
          monthLabel: '3月',
          memberName: '成员 A',
          offlineUnits: 1,
          onlineUnits: 0,
        })
      })
      expect(defaultMemberLedger.threadId).not.toBe(remembered.threadId)
      expect(defaultMemberLedger.actionRequests[0].targetLabel).toContain('成员 A')
      const defaultMemberResult = await confirm(defaultMemberLedger.actionRequests[0])
      expect(defaultMemberResult.result.amount).toBe(88)

      const forecast = await send('如果 4 月线上系数变成 0.3，利润会怎样', () => fakeToolResponse('workspace_update_online_factor', {
        monthLabel: '4月',
        onlineSalesFactor: 0.3,
        mode: 'forecast',
      }))
      expect(forecast.actionRequests).toHaveLength(0)
      expect(forecast.navigationEvents[0].route.mainTab).toBe('inputs')
      expect(forecast.messages.at(-1).content).toContain('未修改草稿')

      const dataQuestion = await send('3 月计划收入和计划成本是多少？', () => fakeToolResponse('data_query_workspace', {
        question: '3 月计划收入和计划成本是多少',
        scope: 'period_summary',
        monthLabel: '3月',
        metrics: ['plannedRevenue', 'plannedCost', 'plannedProfit'],
      }))
      expect(dataQuestion.actionRequests).toHaveLength(0)
      expect(dataQuestion.messages.at(-1).content).toContain('3月计划收入')
      expect(dataQuestion.messages.at(-1).content).toContain('计划成本')

      const writeFactor = await send('把 4 月线上系数改成 0.3 并保存', () => fakeToolResponse('workspace_update_online_factor', {
        monthLabel: '4月',
        onlineSalesFactor: 0.3,
        mode: 'write',
      }))
      expect(writeFactor.actionRequests[0].kind).toBe('workspace.update_draft')
      await confirm(writeFactor.actionRequests[0])
      let draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.months.find((month: any) => month.label === '4月').onlineSalesFactor).toBe(0.3)

      const patchPrice111 = await send('把线下单价改成 111 并保存', () => fakeToolResponse('workspace_patch_config', {
        patches: [{ path: 'operating.offlineUnitPrice', value: 111, label: '线下单价' }],
      }))
      expect(patchPrice111.actionRequests[0].kind).toBe('workspace.update_draft')
      await confirm(patchPrice111.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(111)

      const addMember = await send('新增一个成员，名字叫 成员 G', () => fakeToolResponse('team_member_add', { newMemberName: '成员 G' }))
      expect(addMember.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(addMember.actionRequests[0].title).toContain('新增')
      await confirm(addMember.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.teamMembers.some((member: any) => member.name === '成员 G')).toBe(true)

      const deleteMember = await send('删除成员 G', () => fakeToolResponse('team_member_delete', { memberName: '成员 G' }))
      expect(deleteMember.actionRequests[0].kind).toBe('workspace.update_draft')
      expect(deleteMember.actionRequests[0].title).toContain('删除')
      await confirm(deleteMember.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.teamMembers.some((member: any) => member.name === '成员 G')).toBe(false)

      const editableLedger = await send('把 3 月成员 B 线下 1 张、线上 0 张入账', () => fakeToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 B',
        offlineUnits: 1,
        onlineUnits: 0,
      }))
      const editedPayload = {
        ...editableLedger.actionRequests[0].payload,
        amount: 222,
        allocations: editableLedger.actionRequests[0].payload.allocations.map((allocation: any) => ({
          ...allocation,
          amount: 222,
        })),
      }
      const edited = await client.patch(`/api/v1/agent/action-requests/${editableLedger.actionRequests[0].id}`, {
        summary: '编辑后：3 月成员 B 入账 222 元。',
        details: [{ label: '入账金额', value: '222' }],
        payload: editedPayload,
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json.planSteps[0].description).toContain('222')
      const editedResult = await confirm(editableLedger.actionRequests[0])
      expect(editedResult.result.amount).toBe(222)

      const lock = await send('锁定 3 月账期', () => fakeToolResponse('ledger_set_period_lock', { monthLabel: '3月', locked: true }))
      expect(lock.actionRequests[0].kind).toBe('ledger.lock_period')
      await confirm(lock.actionRequests[0])
      let march = (await client.get('/api/v1/ledger/periods')).json.find((period: any) => period.monthLabel === '3月')
      expect(march.status).toBe('locked')

      const unlock = await send('解锁 3 月账期', () => fakeToolResponse('ledger_set_period_lock', { monthLabel: '3月', locked: false }))
      expect(unlock.actionRequests[0].kind).toBe('ledger.unlock_period')
      await confirm(unlock.actionRequests[0])
      march = (await client.get('/api/v1/ledger/periods')).json.find((period: any) => period.monthLabel === '3月')
      expect(march.status).toBe('open')

      const snapshot = await send('保存当前草稿快照', () => fakeToolResponse('workspace_save_snapshot'))
      expect(snapshot.actionRequests[0].kind).toBe('workspace.save_snapshot')
      const snapshotResult = await confirm(snapshot.actionRequests[0])
      expect(snapshotResult.result.kind).toBe('snapshot')
      expect(snapshotResult.result.version_no).toBe(1)

      const patchPrice222 = await send('把线下单价改成 222 并保存', () => fakeToolResponse('workspace_patch_config', {
        patches: [{ path: 'operating.offlineUnitPrice', value: 222, label: '线下单价' }],
      }))
      await confirm(patchPrice222.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(222)

      const publishShare = await send('发布当前版本并创建分享链接', () => fakeToolResponse('workspace_publish_release', { createShare: true }))
      expect(publishShare.actionRequests[0].kind).toBe('workspace.publish_release')
      const published = await confirm(publishShare.actionRequests[0])
      expect(published.result.version.kind).toBe('release')
      expect(published.result.share.share_token).toBeTruthy()

      const revokeShare = await send('撤销发布版 2 的分享链接', () => fakeToolResponse('share_revoke', { versionNo: 2 }))
      expect(revokeShare.actionRequests[0].kind).toBe('share.revoke')
      await confirm(revokeShare.actionRequests[0])
      const releaseV2 = (await client.get('/api/v1/workspace/versions')).json.find((version: any) => version.versionNo === 2)
      expect(releaseV2.activeShare).toBeNull()

      const rollback = await send('恢复到版本 1', () => fakeToolResponse('workspace_rollback_version', { versionNo: 1 }))
      expect(rollback.actionRequests[0].kind).toBe('workspace.rollback_version')
      await confirm(rollback.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(111)

      const deleteSnapshot = await send('删除快照 1', () => fakeToolResponse('workspace_delete_version', { versionNo: 1 }))
      expect(deleteSnapshot.actionRequests[0].kind).toBe('workspace.delete_version')
      await confirm(deleteSnapshot.actionRequests[0])
      expect((await client.get('/api/v1/workspace/versions')).json.some((version: any) => version.versionNo === 1)).toBe(false)

      const reset = await send('重置当前草稿', () => fakeToolResponse('workspace_reset_draft'))
      expect(reset.actionRequests[0].kind).toBe('workspace.reset_draft')
      await confirm(reset.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(88)

      const forbiddenAccount = await send('帮我注销账号', () => fakeToolResponse('account_forbidden'))
      expect(forbiddenAccount.actionRequests).toHaveLength(0)
      expect(forbiddenAccount.messages.at(-1).content).toContain('不能由 Agent 自动执行')

      const executedAgentActions = await harness.db
        .selectFrom('audit_logs')
        .selectAll()
        .where('action', '=', 'agent.action_executed')
        .execute()
      expect(executedAgentActions.length).toBeGreaterThanOrEqual(12)

      await closeHarness(harness)
    })
  }, 25_000)

  it('keeps agent read-only forecasts non-mutating and refuses account actions', async () => {
    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('workspace_update_online_factor', {
        monthLabel: '4月',
        newFactor: 0.3,
        mode: 'forecast',
      }),
      () => fakeToolResponse('account_forbidden'),
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-read', fakeProviderSettings(baseUrl))
      const client = new Client(harness.app)
      await registerUser(client, 'agent-read@example.com')

      const forecast = await client.post('/api/v1/agent/messages', {
        message: '如果 4 月线上系数变成 0.3，利润会怎样',
      })
      expect(forecast.statusCode).toBe(200)
      expect(forecast.json.planner).toBe('openai_compatible_tool_calls')
      expect(forecast.json.navigationEvents[0].route.mainTab).toBe('inputs')
      expect(forecast.json.actionRequests).toHaveLength(0)
      expect(forecast.json.messages.at(-1).content).toContain('未修改草稿')

      const account = await client.post('/api/v1/agent/messages', {
        threadId: forecast.json.threadId,
        message: '帮我注销账号',
      })
      expect(account.statusCode).toBe(200)
      expect(account.json.actionRequests).toHaveLength(0)
      expect(account.json.messages.at(-1).content).toContain('不能由 Agent 自动执行')
      await closeHarness(harness)
    })
  })

  it('exports and imports workspace bundles through REST and Agent confirmation cards', async () => {
    const importConfig = createProductDefaultModel()
    importConfig.operating.offlineUnitPrice = 321
    const importBundle = {
      schemaVersion: 10,
      workspaceName: '导入工作区',
      currentConfig: importConfig,
      snapshots: [],
      lastSavedAt: null,
    }

    await withFakeOpenAICompatibleProvider(scriptedProvider([
      () => fakeToolResponse('workspace_export_bundle'),
      (body) => {
        const prompt = String(body.messages?.map((message: any) => message.content).join('\n') ?? '')
        expect(prompt).toContain('WorkspaceBundle JSON artifact parsed by server')
        expect(prompt).not.toContain('"offlineUnitPrice":321')
        return fakeToolResponse('workspace_import_bundle', { useProvidedBundle: true })
      },
    ]), async (baseUrl) => {
      const harness = await buildHarness('agent-bundle-tools', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-bundle-tools@example.com')

      const bundle = await client.get('/api/v1/workspace/bundle')
      expect(bundle.statusCode).toBe(200)
      expect(bundle.json.workspaceName).toBe('默认工作区')
      expect(bundle.json.currentConfig.operating.offlineUnitPrice).toBe(88)

      const restImport = await client.post('/api/v1/workspace/bundle/import', { bundle: importBundle })
      expect(restImport.statusCode).toBe(200)
      expect(restImport.json.workspaceName).toBe('导入工作区')
      expect(restImport.json.config.operating.offlineUnitPrice).toBe(321)

      const resetConfig = createProductDefaultModel()
      const draft = await client.get('/api/v1/workspace/draft')
      await client.patch('/api/v1/workspace/draft', {
        revision: draft.json.revision,
        workspaceName: '默认工作区',
        config: resetConfig,
      })

      const exported = await client.post('/api/v1/agent/messages', { message: '导出当前工作区 JSON' })
      expect(exported.statusCode).toBe(200)
      expect(exported.json.planner).toBe('openai_compatible_tool_calls')
      expect(exported.json.actionRequests).toHaveLength(0)
      expect(exported.json.navigationEvents[0].panel).toBe('workspace')
      expect(exported.json.messages.at(-1).content).toContain('未修改业务数据')

      const plannedImport = await client.post('/api/v1/agent/messages', {
        threadId: exported.json.threadId,
        message: `导入我提供的工作区 bundle：${JSON.stringify(importBundle)}`,
      })
      expect(plannedImport.statusCode).toBe(200)
      expect(plannedImport.json.actionRequests[0].kind).toBe('workspace.import_bundle')
      expect(plannedImport.json.actionRequests[0].targetLabel).toBe('导入工作区')

      const confirmed = await client.post(`/api/v1/agent/action-requests/${plannedImport.json.actionRequests[0].id}/confirm`)
      expect(confirmed.statusCode).toBe(200)
      expect(confirmed.json.actionRequest.status).toBe('executed')
      expect(confirmed.json.result.workspaceName).toBe('导入工作区')
      expect(confirmed.json.result.config.operating.offlineUnitPrice).toBe(321)

      await closeHarness(harness)
    })
  })

  it('declares Agent writable coverage for manually editable model surfaces', () => {
    const config = createProductDefaultModel()
    const catalog = buildAgentWritableConfigCatalog(config)
    const paths = new Set(catalog.map((field) => field.path))
    const patterns = new Set(agentWritableConfigPatterns(config))

    for (const path of [
      'planning.startMonth',
      'planning.horizonMonths',
      'operating.offlineUnitPrice',
      'operating.onlineUnitPrice',
      'operating.polaroidLossRate',
      'timelineTemplate.events',
      'timelineTemplate.salesMultiplier',
      'timelineTemplate.onlineSalesFactor',
      'timelineTemplate.rehearsalCount',
      'timelineTemplate.rehearsalCost',
      'timelineTemplate.teacherCount',
      'timelineTemplate.teacherCost',
      'shareholders[0].name',
      'shareholders[0].investmentAmount',
      'shareholders[0].dividendRate',
      'teamMembers[0].name',
      'teamMembers[0].employmentType',
      'teamMembers[0].commissionRate',
      'teamMembers[0].monthlyBasePay',
      'teamMembers[0].perEventTravelCost',
      'teamMembers[0].departureMonthIndex',
      'teamMembers[0].unitsPerEvent.base',
      'employees[0].name',
      'employees[0].role',
      'employees[0].monthlyBasePay',
      'employees[0].perEventCost',
      'stageCostItems[0].name',
      'stageCostItems[0].mode',
      'timelineTemplate.specialCosts[0].amount',
      'timelineTemplate.specialCosts[0].count',
      'months[0].events',
      'months[0].salesMultiplier',
      'months[0].onlineSalesFactor',
      'months[0].rehearsalCount',
      'months[0].rehearsalCost',
      'months[0].teacherCount',
      'months[0].teacherCost',
      'months[0].specialCosts[0].amount',
      'months[0].specialCosts[0].count',
    ]) {
      expect(paths.has(path), path).toBe(true)
    }

    for (const pattern of [
      'operating.monthlyFixedCosts[n].amount',
      'operating.monthlyFixedCosts.add',
      'operating.monthlyFixedCosts.delete',
      'operating.perEventCosts[n].amount',
      'operating.perEventCosts.add',
      'operating.perEventCosts.delete',
      'operating.perUnitCosts[n].amount',
      'operating.perUnitCosts.add',
      'operating.perUnitCosts.delete',
      'shareholders.add',
      'shareholders.delete',
      'teamMembers.add',
      'teamMembers.delete',
      'teamMembers[n].unitsPerEvent.optimistic',
      'employees.add',
      'employees.delete',
      'workspace.name',
      'stageCostItems.add',
      'stageCostItems.delete',
      'months[n].specialCosts[m].count',
    ]) {
      expect(patterns.has(pattern), pattern).toBe(true)
    }

    const toolNames = new Set(AGENT_TOOL_CATALOG.map((tool) => tool.function.name))
    for (const name of [
      'team_member_add',
      'team_member_delete',
      'employee_add',
      'employee_delete',
      'shareholder_add',
      'shareholder_delete',
      'cost_item_add',
      'cost_item_delete',
      'stage_cost_type_add',
      'stage_cost_type_delete',
      'ledger_create_entry',
      'ledger_create_planned_member_income_batch',
      'ledger_create_planned_related_expense_batch',
      'ledger_update_entry',
      'ledger_restore_entry',
      'workspace_rename',
      'workspace_promote_version',
      'data_query_workspace',
      'memory_remember',
    ]) {
      expect(toolNames.has(name), name).toBe(true)
    }

    const supported = AGENT_MANUAL_CAPABILITY_COVERAGE.filter((item) => item.status === 'supported').map((item) => item.capability)
    expect(supported).toEqual(expect.arrayContaining([
      'capital_planning',
      'revenue_engine',
      'team_members',
      'cost_structure',
      'employees',
      'bookkeeping_entries',
      'bookkeeping_history_filters',
      'variance_deep_questions',
      'versions_and_shares',
    ]))
    expect(AGENT_MANUAL_CAPABILITY_COVERAGE.find((item) => item.capability === 'account_actions')?.status).toBe('manual_only')
  })
})
