import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { sql, type Kysely } from 'kysely'
import { createApp } from '../src/server.js'
import { createDatabase } from '../src/db/database.js'
import type { Database } from '../src/db/schema.js'
import type { Settings } from '../src/core/settings.js'

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
    llmProvider: 'deepseek',
    deepseekBaseUrl: 'https://api.deepseek.com',
    deepseekModel: 'deepseek-v4-pro',
    deepseekApiKey: null,
  }
}

async function buildHarness(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `xox-api-${name}-`))
  const settings = testSettings(join(dir, 'test.db'))
  const db = createDatabase(settings)
  const app = await createApp({ settings, db })
  return { app, db }
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
})
