import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Kysely } from 'kysely'
import { createProductDefaultModel, projectModel } from '@xox/domain'
import type { Database, Row } from '../db/schema.js'
import { jsonString } from '../db/database.js'
import { conflict, unauthorized } from '../core/http.js'
import { hashPassword, issueSessionToken, newId, sha256, verifyPassword } from '../core/security.js'
import type { Settings } from '../core/settings.js'
import { utcNow } from '../core/time.js'
import { recordAudit } from './audit.js'

export type CurrentUser = Row<'users'>

function serializeUser(user: CurrentUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    status: user.status,
  }
}

function setSessionCookie(reply: FastifyReply, settings: Settings, token: string, expiresAt: string) {
  reply.setCookie(settings.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: new Date(expiresAt),
  })
}

function clearSessionCookie(reply: FastifyReply, settings: Settings) {
  reply.clearCookie(settings.sessionCookieName, { path: '/' })
}

async function createSessionCookie(
  db: Kysely<Database>,
  settings: Settings,
  reply: FastifyReply,
  user: CurrentUser,
  request: FastifyRequest,
) {
  const issued = issueSessionToken(settings.sessionTtlDays)
  const now = utcNow()
  await db
    .insertInto('user_sessions')
    .values({
      id: newId(),
      user_id: user.id,
      token_hash: issued.tokenHash,
      user_agent: request.headers['user-agent'] ?? null,
      ip_address: request.ip,
      expires_at: issued.expiresAt,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    })
    .execute()
  setSessionCookie(reply, settings, issued.token, issued.expiresAt)
}

export async function registerUser(
  db: Kysely<Database>,
  settings: Settings,
  request: FastifyRequest,
  reply: FastifyReply,
  payload: { email: string; password: string; displayName: string },
) {
  const email = payload.email.trim().toLowerCase()
  const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
  if (existing) {
    throw unauthorized('Email already exists')
  }

  const now = utcNow()
  const userId = newId()
  const workspaceId = newId()
  const config = createProductDefaultModel()
  const result = projectModel(config)

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('users')
      .values({
        id: userId,
        email,
        display_name: payload.displayName,
        status: 'active',
        cancelled_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await trx
      .insertInto('user_credentials')
      .values({
        user_id: userId,
        password_hash: await hashPassword(payload.password),
        created_at: now,
        updated_at: now,
      })
      .execute()
    await trx
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        owner_id: userId,
        name: '默认工作区',
        schema_version: 1,
        active_version_id: null,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await trx
      .insertInto('workspace_members')
      .values({
        id: newId(),
        workspace_id: workspaceId,
        user_id: userId,
        role: 'owner',
        created_at: now,
        updated_at: now,
      })
      .execute()
    await trx
      .insertInto('workspace_drafts')
      .values({
        workspace_id: workspaceId,
        revision: 1,
        config_json: jsonString(config),
        result_json: jsonString(result),
        last_autosaved_at: now,
        updated_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await recordAudit(trx, {
      workspaceId,
      actorId: userId,
      action: 'auth.register',
      entityType: 'user',
      entityId: userId,
    })
  })

  const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow()
  await createSessionCookie(db, settings, reply, user, request)
  return serializeUser(user)
}

export async function loginUser(
  db: Kysely<Database>,
  settings: Settings,
  request: FastifyRequest,
  reply: FastifyReply,
  payload: { email: string; password: string },
) {
  const user = await db.selectFrom('users').selectAll().where('email', '=', payload.email.trim().toLowerCase()).executeTakeFirst()
  if (!user || user.status !== 'active') {
    throw unauthorized('Invalid credentials')
  }

  const credential = await db
    .selectFrom('user_credentials')
    .selectAll()
    .where('user_id', '=', user.id)
    .executeTakeFirst()
  if (!credential || !(await verifyPassword(payload.password, credential.password_hash))) {
    throw unauthorized('Invalid credentials')
  }

  await createSessionCookie(db, settings, reply, user, request)
  await recordAudit(db, { actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id })
  return serializeUser(user)
}

export async function requireCurrentUser(db: Kysely<Database>, settings: Settings, request: FastifyRequest) {
  const token = request.cookies[settings.sessionCookieName]
  if (!token) {
    throw unauthorized()
  }

  const session = await db
    .selectFrom('user_sessions')
    .selectAll()
    .where('token_hash', '=', sha256(token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    throw unauthorized()
  }

  const user = await db.selectFrom('users').selectAll().where('id', '=', session.user_id).executeTakeFirst()
  if (!user || user.status !== 'active') {
    throw unauthorized()
  }

  return user
}

export async function refreshCurrentSession(
  db: Kysely<Database>,
  settings: Settings,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
) {
  const token = request.cookies[settings.sessionCookieName]
  if (!token) {
    throw unauthorized()
  }

  const expiresAt = new Date(Date.now() + settings.sessionTtlDays * 24 * 60 * 60 * 1000).toISOString()
  const now = utcNow()
  await db
    .updateTable('user_sessions')
    .set({ expires_at: expiresAt, updated_at: now })
    .where('token_hash', '=', sha256(token))
    .execute()
  setSessionCookie(reply, settings, token, expiresAt)
  await recordAudit(db, { actorId: user.id, action: 'auth.session_refreshed', entityType: 'user', entityId: user.id })
  return serializeUser(user)
}

export async function logoutCurrentSession(
  db: Kysely<Database>,
  settings: Settings,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = request.cookies[settings.sessionCookieName]
  if (!token) {
    throw unauthorized()
  }

  await db
    .updateTable('user_sessions')
    .set({ revoked_at: utcNow(), updated_at: utcNow() })
    .where('token_hash', '=', sha256(token))
    .execute()
  clearSessionCookie(reply, settings)
}

export async function cancelAccount(
  db: Kysely<Database>,
  settings: Settings,
  request: FastifyRequest,
  reply: FastifyReply,
  user: CurrentUser,
) {
  const now = utcNow()
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('users').set({ status: 'cancelled', cancelled_at: now, updated_at: now }).where('id', '=', user.id).execute()
    await trx.updateTable('user_sessions').set({ revoked_at: now, updated_at: now }).where('user_id', '=', user.id).execute()
    await recordAudit(trx, { actorId: user.id, action: 'auth.cancel_account', entityType: 'user', entityId: user.id })
  })
  clearSessionCookie(reply, settings)
}

export function ensureValidPasswordPayload(payload: { password?: string }) {
  if (!payload.password || payload.password.length < 8 || payload.password.length > 128) {
    throw conflict('Password must be 8-128 characters')
  }
}
