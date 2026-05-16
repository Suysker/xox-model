import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { createApp } from '../src/server.js'
import { createDatabase } from '../src/db/database.js'
import type { Database } from '../src/db/schema.js'
import type { Settings } from '../src/core/settings.js'
import { AGENT_MANUAL_CAPABILITY_COVERAGE, agentWritableConfigPatterns, buildAgentWritableConfigCatalog } from '../src/agent/tool-coverage.js'
import { createProductDefaultModel } from '@xox/domain'
import { recoverRunningAgentRuns } from '../src/modules/agent.js'

type JsonResponse = {
  statusCode: number
  json: any
}

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
  }
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

async function withFakeOpenAICompatibleProvider(handler: (body: any) => unknown | Promise<unknown>, run: (baseUrl: string) => Promise<void>) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = JSON.parse(await readRequestBody(request))
    const payload = await handler(body)
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

  patch(url: string, payload?: unknown) {
    return this.request('PATCH', url, payload)
  }

  delete(url: string) {
    return this.request('DELETE', url)
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
  return {
    choices: [{
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
  }
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
  input: { message: string; partialOutput?: boolean; suffix: string },
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

  it('creates agent navigation events, confirmation cards, and executes confirmed ledger writes', async () => {
    const harness = await buildHarness('agent-ledger')
    const client = new Client(harness.app)
    await registerUser(client, 'agent-ledger@example.com')

    const planned = await client.post('/api/v1/agent/messages', {
      message: '把 3 月成员 A 线下 10 张、线上 2 张入账',
    })
    expect(planned.statusCode).toBe(200)
    expect(planned.json.navigationEvents[0].route.mainTab).toBe('bookkeeping')
    expect(planned.json.planSteps).toHaveLength(1)
    expect(planned.json.planSteps[0].status).toBe('ready')
    expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
    expect(planned.json.actionRequests[0].status).toBe('pending')
    expect(planned.json.actionRequests[0].details).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: '发生日', value: expect.stringMatching(/-03-01$/) })]),
    )

    const confirmed = await client.post(`/api/v1/agent/action-requests/${planned.json.actionRequests[0].id}/confirm`)
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json.actionRequest.status).toBe('executed')
    expect(confirmed.json.result.amount).toBe(1056)

    const periodId = planned.json.navigationEvents[0].route.selectedPeriodId
    const entries = (await client.get(`/api/v1/ledger/entries?periodId=${periodId}`)).json
    const memberEntry = entries.find((entry: any) => entry.relatedEntityId === 'member-a' && entry.amount === 1056)
    expect(memberEntry).toBeTruthy()
    expect(memberEntry.occurredAt).toContain('-03-01T')
    const audit = await harness.db.selectFrom('audit_logs').select('action').where('action', '=', 'agent.action_executed').execute()
    expect(audit).toHaveLength(1)
    await closeHarness(harness)
  })

  it('plans multiple agent steps and lets users edit pending action payloads before execution', async () => {
    const harness = await buildHarness('agent-multi-edit')
    const client = new Client(harness.app)
    await registerUser(client, 'agent-multi-edit@example.com')

    const planned = await client.post('/api/v1/agent/messages', {
      message: '把 3 月成员 B 线下 1 张、线上 1 张入账；把 4 月线上系数改成 0.3 并保存',
    })
    expect(planned.statusCode).toBe(200)
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

    const confirmedLedger = await client.post(`/api/v1/agent/action-requests/${ledgerAction.id}/confirm`)
    expect(confirmedLedger.statusCode).toBe(200)
    expect(confirmedLedger.json.result.amount).toBe(264)
    expect(confirmedLedger.json.planSteps[0].status).toBe('executed')

    const draftAction = planned.json.actionRequests[1]
    const confirmedDraft = await client.post(`/api/v1/agent/action-requests/${draftAction.id}/confirm`)
    expect(confirmedDraft.statusCode).toBe(200)
    const draft = (await client.get('/api/v1/workspace/draft')).json
    expect(draft.config.months.find((month: any) => month.label === '4月').onlineSalesFactor).toBe(0.3)
    await closeHarness(harness)
  })

  it('keeps allowed steps when a multi-step message also contains a forbidden account action', async () => {
    const harness = await buildHarness('agent-mixed-account-step')
    const client = new Client(harness.app)
    await registerUser(client, 'agent-mixed-account-step@example.com')

    const planned = await client.post('/api/v1/agent/messages', {
      message: '把 3 月成员 A 线下 1 张入账；帮我注销账号',
    })
    expect(planned.statusCode).toBe(200)
    expect(planned.json.planSteps).toHaveLength(2)
    expect(planned.json.actionRequests).toHaveLength(1)
    expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
    expect(planned.json.planSteps.map((step: any) => step.status)).toEqual(['ready', 'info'])
    expect(planned.json.messages.at(-1).content).toContain('2 个步骤')
    expect(planned.json.messages.at(-1).content).toContain('账号登录、退出、注销')

    const restored = await client.get(`/api/v1/agent/threads/${planned.json.threadId}`)
    expect(restored.statusCode).toBe(200)
    expect(restored.json.planSteps).toHaveLength(2)
    expect(restored.json.actionRequests[0].status).toBe('pending')
    await closeHarness(harness)
  })

  it('enforces Agent tool policy for edited payload ownership and derived ledger entries', async () => {
    const harness = await buildHarness('agent-tool-policy')
    const firstClient = new Client(harness.app)
    const secondClient = new Client(harness.app)
    const firstUser = await registerUser(firstClient, 'agent-tool-policy-a@example.com')
    await registerUser(secondClient, 'agent-tool-policy-b@example.com')

    const planned = await firstClient.post('/api/v1/agent/messages', {
      message: '把 3 月成员 A 线下 1 张、线上 0 张入账',
    })
    expect(planned.statusCode).toBe(200)
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

  it('uses OpenAI-compatible tool calls as the primary model planning protocol', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.tool_choice).toBe('auto')
      expect(body.tools.some((tool: any) => tool.function.name === 'ledger_create_member_income')).toBe(true)
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
      await closeHarness(harness)
    })
  })

  it('does not fall back to regex rules when a configured model returns no tool calls', async () => {
    let callCount = 0
    await withFakeOpenAICompatibleProvider(() => {
      callCount += 1
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: '我可以帮你记账，但这不是 tool call。',
          },
        }],
      }
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-no-tool-call-no-rules', {
        llmProvider: 'openai-compatible',
        openaiCompatibleProvider: 'test-compatible',
        openaiCompatibleBaseUrl: baseUrl,
        openaiCompatibleApiKey: 'test-key',
      })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-no-tool-call-no-rules@example.com')

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(callCount).toBe(1)
      expect(planned.json.planner).toBe('openai_compatible_tool_calls')
      expect(planned.json.actionRequests).toHaveLength(0)
      expect(planned.json.planSteps[0].status).toBe('failed')
      expect(planned.json.messages.at(-1).content).toContain('没有返回可执行 tool_call')
      const entries = await client.get(`/api/v1/ledger/entries?periodId=${(await client.get('/api/v1/ledger/periods')).json[0].id}`)
      expect(entries.json).toHaveLength(0)
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
    expect(planned.json.messages.at(-1).content).toContain('没有返回可执行 tool_call')
    await closeHarness(harness)
  })

  it('answers read-only data questions only through a model-selected data tool call', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
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
        openaiCompatibleProvider: 'test-compatible',
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
      await closeHarness(harness)
    })
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

      const runningState = await client.get(`/api/v1/agent/threads/${started.json.threadId}`)
      expect(runningState.statusCode).toBe(200)
      expect(runningState.json.runs[0].status).toBe('running')
      expect(runningState.json.messages.map((message: any) => message.role)).toEqual(['user'])

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

      const threads = await client.get('/api/v1/agent/threads')
      expect(threads.json.threads[0].latestRunStatus).toBe('completed')
      expect(threads.json.threads[0].planner).toBe('openai_compatible_tool_calls')
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
    await withFakeOpenAICompatibleProvider((body) => {
      expect(body.tools.some((tool: any) => tool.function.name === 'ledger_create_member_income')).toBe(true)
      expect(body.messages.some((message: any) => typeof message.content === 'string' && message.content.includes('只通过 tool_calls 表达意图'))).toBe(true)
      const prompt = body.messages.map((message: any) => message.content).join('\n')
      if (prompt.includes('如果 4 月线上系数变成 0.3')) {
        return fakeOpenAIChatToolResponse('workspace_update_online_factor', {
          monthLabel: '4月',
          onlineSalesFactor: 0.3,
          mode: 'forecast',
        })
      }
      return fakeOpenAIChatToolResponse('ledger_create_member_income', {
        monthLabel: '3月',
        memberName: '成员 A',
        offlineUnits: 1,
        onlineUnits: 0,
      })
    }, async (baseUrl) => {
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

      const planned = await client.post('/api/v1/agent/messages', {
        message: '把 3 月成员 A 线下 1 张入账',
      })
      expect(planned.statusCode).toBe(200)
      expect(planned.json.planner).toBe('openai_agents')
      expect(planned.json.actionRequests[0].kind).toBe('ledger.create_entry')
      expect(planned.json.actionRequests[0].payload.amount).toBe(88)
      await closeHarness(harness)
    })
  })

  it('persists agent thread history and restores messages, runs, plan steps, and pending actions', async () => {
    const harness = await buildHarness('agent-thread-history')
    const firstClient = new Client(harness.app)
    const secondClient = new Client(harness.app)
    await registerUser(firstClient, 'agent-thread-history-a@example.com')
    await registerUser(secondClient, 'agent-thread-history-b@example.com')

    const planned = await firstClient.post('/api/v1/agent/messages', {
      message: '把 3 月成员 A 线下 1 张入账',
    })
    expect(planned.statusCode).toBe(200)
    expect(planned.json.planner).toBe('rules')
    expect(planned.json.actionRequests).toHaveLength(1)

    const threads = await firstClient.get('/api/v1/agent/threads')
    expect(threads.statusCode).toBe(200)
    expect(threads.json.threads).toHaveLength(1)
    expect(threads.json.threads[0].id).toBe(planned.json.threadId)
    expect(threads.json.threads[0].title).toContain('把 3 月成员 A')
    expect(threads.json.threads[0].latestRunStatus).toBe('completed')
    expect(threads.json.threads[0].planner).toBe('rules')
    expect(threads.json.threads[0].pendingActionCount).toBe(1)

    const restored = await firstClient.get(`/api/v1/agent/threads/${planned.json.threadId}`)
    expect(restored.statusCode).toBe(200)
    expect(restored.json.messages.map((message: any) => message.role)).toEqual(['user', 'assistant'])
    expect(restored.json.runs[0].status).toBe('completed')
    expect(restored.json.runs[0].planner).toBe('rules')
    expect(restored.json.planSteps).toHaveLength(1)
    expect(restored.json.planSteps[0].actionRequestId).toBe(planned.json.actionRequests[0].id)
    expect(restored.json.actionRequests[0].status).toBe('pending')
    expect(restored.json.navigationEvents[0].route.mainTab).toBe('bookkeeping')

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
    expect(restoredAfterConfirm.json.messages.at(-1).content).toContain('已执行')
    const threadsAfterConfirm = await firstClient.get('/api/v1/agent/threads')
    expect(threadsAfterConfirm.json.threads[0].pendingActionCount).toBe(0)
    await closeHarness(harness)
  })

  it('keeps agent memory scoped by user and workspace and compacts long thread context', async () => {
    const harness = await buildHarness('agent-memory')
    const firstClient = new Client(harness.app)
    const secondClient = new Client(harness.app)
    const firstUser = await registerUser(firstClient, 'agent-memory-a@example.com')
    await registerUser(secondClient, 'agent-memory-b@example.com')

    const remembered = await firstClient.post('/api/v1/agent/messages', {
      message: '记住：默认记账成员是 成员 A',
    })
    expect(remembered.statusCode).toBe(200)
    const threadId = remembered.json.threadId
    const firstMemories = await firstClient.get('/api/v1/agent/memories')
    expect(firstMemories.json.memories).toHaveLength(1)
    expect(firstMemories.json.memories[0].value).toContain('成员 A')
    expect((await secondClient.get('/api/v1/agent/memories')).json.memories).toHaveLength(0)
    expect((await secondClient.delete(`/api/v1/agent/memories/${firstMemories.json.memories[0].id}`)).statusCode).toBe(403)

    const secretValue = ['sk', 'memorysecretvalue123456'].join('-')
    const secretRemember = await firstClient.post('/api/v1/agent/messages', {
      threadId,
      message: `记住：DeepSeek API key 是 ${secretValue}`,
    })
    expect(secretRemember.statusCode).toBe(200)
    const memoriesAfterSecret = await firstClient.get('/api/v1/agent/memories')
    expect(memoriesAfterSecret.json.memories).toHaveLength(1)
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

    expect((await firstClient.delete(`/api/v1/agent/memories/${firstMemories.json.memories[0].id}`)).statusCode).toBe(200)
    expect((await firstClient.get('/api/v1/agent/memories')).json.memories).toHaveLength(0)
    await closeHarness(harness)
  })

  it('injects tenant-scoped memory into a new agent thread for real provider planning', async () => {
    let callCount = 0
    const secretValue = ['sk', 'providersecretvalue123456'].join('-')
    await withFakeOpenAICompatibleProvider((body) => {
      callCount += 1
      const prompt = body.messages.map((message: any) => message.content).join('\n')
      if (callCount === 1) {
        expect(prompt).toContain('记住')
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_memory_nav',
                type: 'function',
                function: {
                  name: 'ui_navigate',
                  arguments: JSON.stringify({ mainTab: 'dashboard', secondaryTab: 'overview' }),
                },
              }],
            },
          }],
        }
      }

      if (callCount === 2) {
        expect(prompt).not.toContain(secretValue)
        expect(prompt).toContain('[redacted-api-key]')
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_secret_nav',
                type: 'function',
                function: {
                  name: 'ui_navigate',
                  arguments: JSON.stringify({ mainTab: 'dashboard', secondaryTab: 'overview' }),
                },
              }],
            },
          }],
        }
      }

      expect(prompt).toContain('默认记账成员是 成员 A')
      expect(prompt).toContain('tenantScopedMemory')
      expect(prompt).not.toContain(secretValue)
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
    }, async (baseUrl) => {
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
      await closeHarness(harness)
    })
  })

  it('validates a broad Agent OS capability matrix through backend APIs', async () => {
    await withFakeOpenAICompatibleProvider((body) => {
      const prompt = body.messages.map((message: any) => message.content).join('\n')
      const instruction = prompt.split('用户指令：').at(-1) ?? prompt

      if (instruction.includes('记住：默认记账成员是 成员 A')) {
        return fakeToolResponse('ui_navigate', { mainTab: 'dashboard', secondaryTab: 'overview' })
      }
      if (instruction.includes('默认成员线下 1 张')) {
        expect(prompt).toContain('默认记账成员是 成员 A')
        expect(prompt).toContain('tenantScopedMemory')
        return fakeToolResponse('ledger_create_member_income', {
          monthLabel: '3月',
          memberName: '成员 A',
          offlineUnits: 1,
          onlineUnits: 0,
        })
      }
      if (instruction.includes('如果 4 月线上系数变成 0.3')) {
        return fakeToolResponse('workspace_update_online_factor', {
          monthLabel: '4月',
          onlineSalesFactor: 0.3,
          mode: 'forecast',
        })
      }
      if (instruction.includes('3 月计划收入和计划成本')) {
        return fakeToolResponse('data_query_workspace', {
          question: '3 月计划收入和计划成本是多少',
          scope: 'period_summary',
          monthLabel: '3月',
          metrics: ['plannedRevenue', 'plannedCost', 'plannedProfit'],
        })
      }
      if (instruction.includes('把 4 月线上系数改成 0.3 并保存')) {
        return fakeToolResponse('workspace_update_online_factor', {
          monthLabel: '4月',
          onlineSalesFactor: 0.3,
          mode: 'write',
        })
      }
      if (instruction.includes('线下单价改成 111')) {
        return fakeToolResponse('workspace_patch_config', {
          patches: [{ path: 'operating.offlineUnitPrice', value: 111, label: '线下单价' }],
        })
      }
      if (instruction.includes('成员 B 线下 1 张')) {
        return fakeToolResponse('ledger_create_member_income', {
          monthLabel: '3月',
          memberName: '成员 B',
          offlineUnits: 1,
          onlineUnits: 0,
        })
      }
      if (instruction.includes('锁定 3 月账期')) {
        return fakeToolResponse('ledger_set_period_lock', { monthLabel: '3月', locked: true })
      }
      if (instruction.includes('解锁 3 月账期')) {
        return fakeToolResponse('ledger_set_period_lock', { monthLabel: '3月', locked: false })
      }
      if (instruction.includes('保存当前草稿快照')) {
        return fakeToolResponse('workspace_save_snapshot')
      }
      if (instruction.includes('线下单价改成 222')) {
        return fakeToolResponse('workspace_patch_config', {
          patches: [{ path: 'operating.offlineUnitPrice', value: 222, label: '线下单价' }],
        })
      }
      if (instruction.includes('发布当前版本并创建分享链接')) {
        return fakeToolResponse('workspace_publish_release', { createShare: true })
      }
      if (instruction.includes('撤销发布版 2 的分享链接')) {
        return fakeToolResponse('share_revoke', { versionNo: 2 })
      }
      if (instruction.includes('恢复到版本 1')) {
        return fakeToolResponse('workspace_rollback_version', { versionNo: 1 })
      }
      if (instruction.includes('删除快照 1')) {
        return fakeToolResponse('workspace_delete_version', { versionNo: 1 })
      }
      if (instruction.includes('重置当前草稿')) {
        return fakeToolResponse('workspace_reset_draft')
      }
      if (instruction.includes('帮我注销账号')) {
        return fakeToolResponse('account_forbidden')
      }

      return fakeToolResponse('ui_navigate', { mainTab: 'dashboard', secondaryTab: 'overview' })
    }, async (baseUrl) => {
      const harness = await buildHarness('agent-capability-matrix', { llmProvider: 'openai-compatible', openaiCompatibleProvider: 'test-compatible', openaiCompatibleBaseUrl: baseUrl, openaiCompatibleApiKey: 'test-key' })
      const client = new Client(harness.app)
      await registerUser(client, 'agent-capability-matrix@example.com')

      async function send(message: string, threadId?: string) {
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

      const remembered = await send('记住：默认记账成员是 成员 A')
      const memories = await client.get('/api/v1/agent/memories')
      expect(memories.json.memories).toHaveLength(1)
      expect(memories.json.memories[0].value).toContain('成员 A')

      const defaultMemberLedger = await send('把 3 月默认成员线下 1 张入账')
      expect(defaultMemberLedger.threadId).not.toBe(remembered.threadId)
      expect(defaultMemberLedger.actionRequests[0].targetLabel).toContain('成员 A')
      const defaultMemberResult = await confirm(defaultMemberLedger.actionRequests[0])
      expect(defaultMemberResult.result.amount).toBe(88)

      const forecast = await send('如果 4 月线上系数变成 0.3，利润会怎样')
      expect(forecast.actionRequests).toHaveLength(0)
      expect(forecast.navigationEvents[0].route.mainTab).toBe('inputs')
      expect(forecast.messages.at(-1).content).toContain('未修改草稿')

      const dataQuestion = await send('3 月计划收入和计划成本是多少？')
      expect(dataQuestion.actionRequests).toHaveLength(0)
      expect(dataQuestion.messages.at(-1).content).toContain('3月计划收入')
      expect(dataQuestion.messages.at(-1).content).toContain('计划成本')

      const writeFactor = await send('把 4 月线上系数改成 0.3 并保存')
      expect(writeFactor.actionRequests[0].kind).toBe('workspace.update_draft')
      await confirm(writeFactor.actionRequests[0])
      let draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.months.find((month: any) => month.label === '4月').onlineSalesFactor).toBe(0.3)

      const patchPrice111 = await send('把线下单价改成 111 并保存')
      expect(patchPrice111.actionRequests[0].kind).toBe('workspace.update_draft')
      await confirm(patchPrice111.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(111)

      const editableLedger = await send('把 3 月成员 B 线下 1 张、线上 0 张入账')
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

      const lock = await send('锁定 3 月账期')
      expect(lock.actionRequests[0].kind).toBe('ledger.lock_period')
      await confirm(lock.actionRequests[0])
      let march = (await client.get('/api/v1/ledger/periods')).json.find((period: any) => period.monthLabel === '3月')
      expect(march.status).toBe('locked')

      const unlock = await send('解锁 3 月账期')
      expect(unlock.actionRequests[0].kind).toBe('ledger.unlock_period')
      await confirm(unlock.actionRequests[0])
      march = (await client.get('/api/v1/ledger/periods')).json.find((period: any) => period.monthLabel === '3月')
      expect(march.status).toBe('open')

      const snapshot = await send('保存当前草稿快照')
      expect(snapshot.actionRequests[0].kind).toBe('workspace.save_snapshot')
      const snapshotResult = await confirm(snapshot.actionRequests[0])
      expect(snapshotResult.result.kind).toBe('snapshot')
      expect(snapshotResult.result.version_no).toBe(1)

      const patchPrice222 = await send('把线下单价改成 222 并保存')
      await confirm(patchPrice222.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(222)

      const publishShare = await send('发布当前版本并创建分享链接')
      expect(publishShare.actionRequests[0].kind).toBe('workspace.publish_release')
      const published = await confirm(publishShare.actionRequests[0])
      expect(published.result.version.kind).toBe('release')
      expect(published.result.share.share_token).toBeTruthy()

      const revokeShare = await send('撤销发布版 2 的分享链接')
      expect(revokeShare.actionRequests[0].kind).toBe('share.revoke')
      await confirm(revokeShare.actionRequests[0])
      const releaseV2 = (await client.get('/api/v1/workspace/versions')).json.find((version: any) => version.versionNo === 2)
      expect(releaseV2.activeShare).toBeNull()

      const rollback = await send('恢复到版本 1')
      expect(rollback.actionRequests[0].kind).toBe('workspace.rollback_version')
      await confirm(rollback.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(111)

      const deleteSnapshot = await send('删除快照 1')
      expect(deleteSnapshot.actionRequests[0].kind).toBe('workspace.delete_version')
      await confirm(deleteSnapshot.actionRequests[0])
      expect((await client.get('/api/v1/workspace/versions')).json.some((version: any) => version.versionNo === 1)).toBe(false)

      const reset = await send('重置当前草稿')
      expect(reset.actionRequests[0].kind).toBe('workspace.reset_draft')
      await confirm(reset.actionRequests[0])
      draft = (await client.get('/api/v1/workspace/draft')).json
      expect(draft.config.operating.offlineUnitPrice).toBe(88)

      const forbiddenAccount = await send('帮我注销账号')
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
  })

  it('keeps agent read-only forecasts non-mutating and refuses account actions', async () => {
    const harness = await buildHarness('agent-read')
    const client = new Client(harness.app)
    await registerUser(client, 'agent-read@example.com')

    const forecast = await client.post('/api/v1/agent/messages', {
      message: '如果 4 月线上系数变成 0.3，利润会怎样',
    })
    expect(forecast.statusCode).toBe(200)
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

    await withFakeOpenAICompatibleProvider((body) => {
      const prompt = String(body.messages?.map((message: any) => message.content).join('\n') ?? '')
      const instruction = prompt.split('用户指令：').at(-1) ?? prompt
      if (instruction.includes('导出')) return fakeToolResponse('workspace_export_bundle')
      if (instruction.includes('导入')) {
        expect(prompt).toContain('WorkspaceBundle JSON artifact parsed by server')
        expect(prompt).not.toContain('"offlineUnitPrice":321')
        return fakeToolResponse('workspace_import_bundle', { useProvidedBundle: true })
      }
      return fakeToolResponse('ui_navigate', { mainTab: 'dashboard', secondaryTab: 'overview' })
    }, async (baseUrl) => {
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
      'operating.perEventCosts[n].amount',
      'operating.perUnitCosts[n].amount',
      'teamMembers[n].unitsPerEvent.optimistic',
      'months[n].specialCosts[m].count',
    ]) {
      expect(patterns.has(pattern), pattern).toBe(true)
    }

    const supported = AGENT_MANUAL_CAPABILITY_COVERAGE.filter((item) => item.status === 'supported').map((item) => item.capability)
    expect(supported).toEqual(expect.arrayContaining([
      'capital_planning',
      'revenue_engine',
      'team_members',
      'cost_structure',
      'employees',
      'bookkeeping_entries',
      'versions_and_shares',
    ]))
    expect(AGENT_MANUAL_CAPABILITY_COVERAGE.find((item) => item.capability === 'account_actions')?.status).toBe('manual_only')
  })
})
