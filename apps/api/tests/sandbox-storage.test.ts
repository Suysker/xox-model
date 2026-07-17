import { createHash } from 'node:crypto'
import DatabaseDriver from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrations.js'
import { createXoxSandboxStorage } from '../src/agent/sandbox-storage.js'

describe('xox sandbox storage adapters', () => {
  let db: Kysely<Database>

  beforeEach(async () => {
    const sqlite = new DatabaseDriver(':memory:')
    sqlite.pragma('foreign_keys = ON')
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
    await runMigrations(db)
    const now = new Date().toISOString()
    await db.insertInto('users').values({
      id: 'tenant_1',
      email: 'sandbox@example.com',
      display_name: 'Sandbox User',
      status: 'active',
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    }).execute()
    await db.insertInto('workspaces').values({
      id: 'workspace_1',
      owner_id: 'tenant_1',
      name: 'Sandbox Workspace',
      schema_version: 1,
      active_version_id: null,
      created_at: now,
      updated_at: now,
    }).execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('resolves immutable tenant-scoped input bytes and rejects scope drift', async () => {
    const storage = createXoxSandboxStorage(db)
    const bytes = Buffer.from('a,b\n1,2\n', 'utf8')
    const descriptor = await storage.putInputFile({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'input.csv',
      kind: 'csv',
      bytes,
    })
    const resolved = await storage.inputFileResolver.resolveFile({
      scope: {
        tenantId: 'tenant_1',
        workspaceId: 'workspace_1',
        runId: 'run_1',
        sandboxSessionId: 'sandbox_1',
      },
      fileId: descriptor.fileId,
      kind: descriptor.kind,
      expectedOriginVersion: descriptor.originVersion,
      expectedContentHash: descriptor.contentHash,
      expectedSizeBytes: descriptor.sizeBytes,
    })
    expect(Buffer.from(resolved.bytes)).toEqual(bytes)
    await expect(storage.inputFileResolver.resolveFile({
      scope: {
        tenantId: 'tenant_2',
        workspaceId: 'workspace_1',
        runId: 'run_1',
        sandboxSessionId: 'sandbox_1',
      },
      fileId: descriptor.fileId,
      kind: descriptor.kind,
      expectedOriginVersion: descriptor.originVersion,
      expectedContentHash: descriptor.contentHash,
      expectedSizeBytes: descriptor.sizeBytes,
    })).rejects.toThrow('sandbox_input_file_resolution_failed')
  })

  it('persists artifacts idempotently and retrieves exact authorized bytes', async () => {
    const storage = createXoxSandboxStorage(db)
    const bytes = Buffer.from('persisted report', 'utf8')
    const contentHash = createHash('sha256').update(bytes).digest('hex')
    const request = {
      scope: {
        tenantId: 'tenant_1',
        workspaceId: 'workspace_1',
        runId: 'run_1',
        sandboxSessionId: 'sandbox_1',
        toolCallId: 'tool_1',
      },
      idempotencyKey: 'sandbox-artifacts:test-idempotency-key',
      expiresInSeconds: 3_600,
      artifacts: [{
        kind: 'txt' as const,
        name: 'report.txt',
        sizeBytes: bytes.byteLength,
        contentHash,
        bytes,
      }],
    }
    const [first, second] = await Promise.all([
      storage.artifactPersistence.persistArtifacts(request),
      storage.artifactPersistence.persistArtifacts(request),
    ])
    expect(first.status).toBe('committed')
    expect(second).toEqual(first)
    if (first.status !== 'committed') throw new Error('artifact commit failed')
    const stored = await storage.readArtifact({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      artifactId: first.artifacts[0]!.artifactId,
    })
    expect(Buffer.from(stored!.bytes)).toEqual(bytes)
    expect(await storage.readArtifact({
      tenantId: 'tenant_2',
      workspaceId: 'workspace_1',
      artifactId: first.artifacts[0]!.artifactId,
    })).toBeNull()
    expect((await db.selectFrom('agent_sandbox_artifact_commits').selectAll().execute())).toHaveLength(1)
    expect((await db.selectFrom('agent_sandbox_objects')
      .selectAll()
      .where('object_type', '=', 'artifact')
      .execute())).toHaveLength(1)

    const scopeDrift = await storage.artifactPersistence.persistArtifacts({
      ...request,
      scope: {
        ...request.scope,
        runId: 'run_2',
      },
    })
    expect(scopeDrift.status).toBe('unknown')
  })
})
