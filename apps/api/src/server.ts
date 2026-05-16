import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { z } from 'zod'
import type { Kysely } from 'kysely'
import { hydrateModelConfig } from '@xox/domain'
import { getSettings, type Settings } from './core/settings.js'
import { ApiError, sendError, unprocessable } from './core/http.js'
import { createDatabase } from './db/database.js'
import type { Database } from './db/schema.js'
import { runMigrations } from './db/migrations.js'
import {
  cancelAccount,
  loginUser,
  logoutCurrentSession,
  refreshCurrentSession,
  registerUser,
  requireCurrentUser,
} from './modules/auth.js'
import {
  deleteVersion,
  getWorkspaceDraft,
  getWorkspaceForUser,
  listVersions,
  exportWorkspaceBundle,
  importWorkspaceBundle,
  publishVersion,
  rollbackToVersion,
  saveDraft,
  serializeDraft,
  serializeVersion,
} from './modules/workspace.js'
import { createVersionShare, getPublicSharePayload, revokeVersionShare, serializeShare } from './modules/share.js'
import {
  createActualEntry,
  listEntries,
  listPeriods,
  listSubjectsForPeriod,
  restoreEntry,
  setPeriodStatus,
  updateActualEntry,
  varianceForPeriod,
  voidEntry,
} from './modules/ledger.js'
import { registerAgentRoutes } from './modules/agent.js'

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
})

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
})

const draftSchema = z.object({
  revision: z.number().int(),
  workspaceName: z.string().min(1),
  config: z.unknown(),
})

const publishSchema = z.object({
  name: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  kind: z.enum(['snapshot', 'release']).default('release'),
})

const bundleImportSchema = z.object({
  bundle: z.object({
    schemaVersion: z.number().int(),
    workspaceName: z.string().min(1),
    currentConfig: z.object({
      teamMembers: z.array(z.unknown()),
      months: z.array(z.unknown()),
      operating: z.object({}).passthrough(),
      planning: z.object({}).passthrough(),
    }).passthrough(),
    snapshots: z.array(z.unknown()).default([]),
    lastSavedAt: z.string().nullable().optional(),
  }),
})

const allocationSchema = z.object({
  subjectKey: z.string(),
  subjectName: z.string(),
  subjectType: z.enum(['revenue', 'cost']),
  amount: z.number(),
})

const entrySchema = z.object({
  ledgerPeriodId: z.string(),
  direction: z.enum(['income', 'expense']),
  amount: z.number(),
  occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
  counterparty: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  relatedEntityType: z.enum(['teamMember', 'employee']).nullable().optional(),
  relatedEntityId: z.string().nullable().optional(),
  relatedEntityName: z.string().nullable().optional(),
  allocations: z.array(allocationSchema),
})

const updateEntrySchema = entrySchema.omit({ ledgerPeriodId: true, direction: true })

function parseBody<T>(schema: z.ZodType<T>, body: unknown) {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw unprocessable(parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return parsed.data
}

async function routeContext(db: Kysely<Database>, settings: Settings, request: Parameters<typeof requireCurrentUser>[2]) {
  const user = await requireCurrentUser(db, settings, request)
  const workspace = await getWorkspaceForUser(db, user)
  return { user, workspace }
}

export async function createApp(options?: { settings?: Settings; db?: Kysely<Database> }) {
  const settings = options?.settings ?? getSettings()
  const db = options?.db ?? createDatabase(settings)
  await runMigrations(db)

  const app = Fastify({ logger: false })
  await app.register(cookie)
  await app.register(cors, {
    origin: settings.corsOrigin,
    credentials: true,
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      void reply.status(error.statusCode).send({ detail: error.message })
      return
    }
    void reply.status(500).send({ detail: error instanceof Error ? error.message : String(error) })
  })

  app.addHook('onClose', async () => {
    await db.destroy()
  })

  app.get('/api/v1/health', async () => ({ status: 'ok' }))

  app.post('/api/v1/auth/register', async (request, reply) => {
    try {
      return await registerUser(db, settings, request, reply, parseBody(registerSchema, request.body))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/auth/login', async (request, reply) => {
    try {
      return await loginUser(db, settings, request, reply, parseBody(loginSchema, request.body))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/auth/me', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      return await refreshCurrentSession(db, settings, request, reply, user)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      await logoutCurrentSession(db, settings, request, reply)
      await import('./modules/audit.js').then(({ recordAudit }) =>
        recordAudit(db, { actorId: user.id, action: 'auth.logout', entityType: 'user', entityId: user.id }),
      )
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/auth/me', async (request, reply) => {
    try {
      const user = await requireCurrentUser(db, settings, request)
      await cancelAccount(db, settings, request, reply, user)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/workspace/draft', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      return serializeDraft(workspace, await getWorkspaceDraft(db, workspace))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.patch('/api/v1/workspace/draft', async (request, reply) => {
    try {
      const payload = parseBody(draftSchema, request.body)
      const { user, workspace } = await routeContext(db, settings, request)
      return await saveDraft(db, {
        workspace,
        actor: user,
        revision: payload.revision,
        workspaceName: payload.workspaceName,
        config: hydrateModelConfig(payload.config),
      })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/workspace/bundle', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      return await exportWorkspaceBundle(db, workspace)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/workspace/bundle/import', async (request, reply) => {
    try {
      const payload = parseBody(bundleImportSchema, request.body)
      const { user, workspace } = await routeContext(db, settings, request)
      return await importWorkspaceBundle(db, { workspace, actor: user, bundle: payload.bundle })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/workspace/versions', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      const versions = await listVersions(db, workspace)
      return Promise.all(versions.map((version) => serializeVersion(db, version)))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/workspace/versions', async (request, reply) => {
    try {
      const payload = parseBody(publishSchema, request.body)
      const { user, workspace } = await routeContext(db, settings, request)
      return await serializeVersion(db, await publishVersion(db, { workspace, actor: user, kind: payload.kind, name: payload.name, note: payload.note }))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/workspace/versions/:versionId/share', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { versionId } = request.params as { versionId: string }
      return serializeShare(await createVersionShare(db, { workspace, actor: user, versionId }))
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/workspace/versions/:versionId/share', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { versionId } = request.params as { versionId: string }
      await revokeVersionShare(db, { workspace, actor: user, versionId })
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/workspace/versions/:versionId/rollback', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { versionId } = request.params as { versionId: string }
      return await rollbackToVersion(db, { workspace, actor: user, versionId })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.delete('/api/v1/workspace/versions/:versionId', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      const { versionId } = request.params as { versionId: string }
      await deleteVersion(db, workspace, versionId)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/ledger/periods', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      return await listPeriods(db, workspace)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/ledger/periods/:periodId/subjects', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      const { periodId } = request.params as { periodId: string }
      return await listSubjectsForPeriod(db, workspace, periodId)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/ledger/entries', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      const { periodId } = request.query as { periodId?: string }
      if (!periodId) throw unprocessable('periodId is required')
      return await listEntries(db, workspace, periodId)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/ledger/entries', async (request, reply) => {
    try {
      const payload = parseBody(entrySchema, request.body)
      const { user, workspace } = await routeContext(db, settings, request)
      return await createActualEntry(db, { workspace, actor: user, ...payload })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.patch('/api/v1/ledger/entries/:entryId', async (request, reply) => {
    try {
      const payload = parseBody(updateEntrySchema, request.body)
      const { user, workspace } = await routeContext(db, settings, request)
      const { entryId } = request.params as { entryId: string }
      return await updateActualEntry(db, { workspace, actor: user, entryId, ...payload })
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/ledger/entries/:entryId/void', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { entryId } = request.params as { entryId: string }
      await voidEntry(db, workspace, entryId, user.id)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/ledger/entries/:entryId/restore', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { entryId } = request.params as { entryId: string }
      await restoreEntry(db, workspace, entryId, user.id)
      return { ok: true }
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/ledger/periods/:periodId/lock', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { periodId } = request.params as { periodId: string }
      return await setPeriodStatus(db, workspace, periodId, user.id, 'locked')
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.post('/api/v1/ledger/periods/:periodId/unlock', async (request, reply) => {
    try {
      const { user, workspace } = await routeContext(db, settings, request)
      const { periodId } = request.params as { periodId: string }
      return await setPeriodStatus(db, workspace, periodId, user.id, 'open')
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/variance/periods/:periodId', async (request, reply) => {
    try {
      const { workspace } = await routeContext(db, settings, request)
      const { periodId } = request.params as { periodId: string }
      return await varianceForPeriod(db, workspace, periodId)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/public/shares/:shareToken', async (request, reply) => {
    try {
      const { shareToken } = request.params as { shareToken: string }
      return await getPublicSharePayload(db, shareToken)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  registerAgentRoutes(app, db, settings)

  return app
}
