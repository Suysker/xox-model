import { createHash, randomUUID } from 'node:crypto'
import type {
  SandboxArtifactPersistencePort,
  SandboxArtifactPersistenceResult,
  SandboxArtifactRef,
  SandboxFileKind,
  SandboxInputFileResolverPort,
} from '@agentic-os/sandbox'
import type { Kysely, Transaction } from 'kysely'
import type { Database, Row } from '../db/schema.js'

export type XoxSandboxInputDescriptor = {
  fileId: string
  kind: SandboxFileKind
  originVersion: string
  contentHash: string
  sizeBytes: number
}

export function createXoxSandboxStorage(db: Kysely<Database>) {
  const inputFileResolver: SandboxInputFileResolverPort = {
    resolveFile: async (input) => {
      const object = await db.selectFrom('agent_sandbox_objects')
        .selectAll()
        .where('id', '=', input.fileId)
        .where('tenant_id', '=', input.scope.tenantId)
        .where('workspace_id', '=', input.scope.workspaceId)
        .where('object_type', '=', 'input')
        .executeTakeFirst()
      if (
        object === undefined ||
        object.object_version !== input.expectedOriginVersion ||
        object.content_hash !== input.expectedContentHash ||
        object.size_bytes !== input.expectedSizeBytes ||
        (input.kind !== undefined && object.file_kind !== input.kind)
      ) {
        throw new Error('sandbox_input_file_resolution_failed')
      }
      return {
        originRef: `xox_input_${object.id}`,
        originVersion: object.object_version,
        bytes: Buffer.from(object.bytes),
        contentHash: object.content_hash,
        sizeBytes: object.size_bytes,
      }
    },
  }

  const artifactPersistence: SandboxArtifactPersistencePort = {
    persistArtifacts: async (input) => {
      const prepared = input.artifacts.map((artifact, index) => {
        const bytes = Buffer.from(artifact.bytes)
        const contentHash = sha256(bytes)
        if (bytes.byteLength !== artifact.sizeBytes || contentHash !== artifact.contentHash) return null
        return {
          bytes,
          ref: {
            artifactId: `artifact_${sha256(`${input.idempotencyKey}:${index}:${contentHash}`).slice(0, 32)}`,
            kind: artifact.kind,
            name: artifact.name,
            sizeBytes: bytes.byteLength,
            contentHash,
          } satisfies SandboxArtifactRef,
        }
      })
      if (prepared.some((artifact) => artifact === null)) return { status: 'failed' }
      const exact = prepared.filter((artifact) => artifact !== null)
      return db.transaction().execute(async (trx): Promise<SandboxArtifactPersistenceResult> => {
        const prior = await trx.selectFrom('agent_sandbox_artifact_commits')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst()
        if (prior !== undefined) {
          return committedArtifactResult(trx, prior, input, exact.map((artifact) => artifact.ref))
        }

        const now = new Date().toISOString()
        const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1_000).toISOString()
        for (const artifact of exact) {
          await trx.insertInto('agent_sandbox_objects').values({
            id: artifact.ref.artifactId,
            tenant_id: input.scope.tenantId,
            workspace_id: input.scope.workspaceId,
            object_type: 'artifact',
            object_version: `v1_${artifact.ref.contentHash}`,
            name: artifact.ref.name,
            file_kind: artifact.ref.kind,
            content_hash: artifact.ref.contentHash,
            size_bytes: artifact.ref.sizeBytes,
            bytes: artifact.bytes,
            expires_at: expiresAt,
            created_at: now,
          }).onConflict((conflict) => conflict.column('id').doNothing()).execute()
          const stored = await trx.selectFrom('agent_sandbox_objects')
            .selectAll()
            .where('id', '=', artifact.ref.artifactId)
            .executeTakeFirst()
          if (stored === undefined || !storedArtifactMatches(stored, input, artifact.ref, artifact.bytes)) {
            return unknownArtifactPersistence(input.idempotencyKey)
          }
        }
        await trx.insertInto('agent_sandbox_artifact_commits').values({
          idempotency_key: input.idempotencyKey,
          tenant_id: input.scope.tenantId,
          workspace_id: input.scope.workspaceId,
          run_id: input.scope.runId,
          sandbox_session_id: input.scope.sandboxSessionId,
          tool_call_id: input.scope.toolCallId,
          artifact_ids_json: JSON.stringify(exact.map((artifact) => artifact.ref.artifactId)),
          created_at: now,
        }).onConflict((conflict) => conflict.column('idempotency_key').doNothing()).execute()
        const committed = await trx.selectFrom('agent_sandbox_artifact_commits')
          .selectAll()
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst()
        if (committed === undefined) return unknownArtifactPersistence(input.idempotencyKey)
        return committedArtifactResult(trx, committed, input, exact.map((artifact) => artifact.ref))
      })
    },
  }

  return {
    inputFileResolver,
    artifactPersistence,
    putInputFile: (input: {
      tenantId: string
      workspaceId: string
      name: string
      kind: SandboxFileKind
      bytes: Uint8Array
    }) => putInputFile(db, input),
    describeInputFiles: (input: {
      tenantId: string
      workspaceId: string
      fileIds: readonly string[]
      expectedKinds?: readonly SandboxFileKind[]
    }) => describeInputFiles(db, input),
    readArtifact: (input: { tenantId: string; workspaceId: string; artifactId: string }) =>
      readArtifact(db, input),
  }
}

async function putInputFile(db: Kysely<Database>, input: {
  tenantId: string
  workspaceId: string
  name: string
  kind: SandboxFileKind
  bytes: Uint8Array
}): Promise<XoxSandboxInputDescriptor> {
  const bytes = Buffer.from(input.bytes)
  const contentHash = sha256(bytes)
  const fileId = `file_${randomUUID()}`
  const originVersion = `v1_${contentHash}`
  await db.insertInto('agent_sandbox_objects').values({
    id: fileId,
    tenant_id: input.tenantId,
    workspace_id: input.workspaceId,
    object_type: 'input',
    object_version: originVersion,
    name: input.name,
    file_kind: input.kind,
    content_hash: contentHash,
    size_bytes: bytes.byteLength,
    bytes,
    expires_at: null,
    created_at: new Date().toISOString(),
  }).execute()
  return { fileId, kind: input.kind, originVersion, contentHash, sizeBytes: bytes.byteLength }
}

async function describeInputFiles(db: Kysely<Database>, input: {
  tenantId: string
  workspaceId: string
  fileIds: readonly string[]
  expectedKinds?: readonly SandboxFileKind[]
}): Promise<XoxSandboxInputDescriptor[]> {
  if (input.fileIds.length === 0) return []
  const rows = await db.selectFrom('agent_sandbox_objects')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('workspace_id', '=', input.workspaceId)
    .where('object_type', '=', 'input')
    .where('id', 'in', [...input.fileIds])
    .execute()
  const byId = new Map(rows.map((row) => [row.id, row]))
  return input.fileIds.map((fileId, index) => {
    const row = byId.get(fileId)
    const expectedKind = input.expectedKinds?.[index]
    if (row === undefined || (expectedKind !== undefined && row.file_kind !== expectedKind)) {
      throw new Error('sandbox_input_file_resolution_failed')
    }
    return {
      fileId: row.id,
      kind: row.file_kind as SandboxFileKind,
      originVersion: row.object_version,
      contentHash: row.content_hash,
      sizeBytes: row.size_bytes,
    }
  })
}

async function readArtifact(db: Kysely<Database>, input: {
  tenantId: string
  workspaceId: string
  artifactId: string
}): Promise<{ ref: SandboxArtifactRef; bytes: Uint8Array } | null> {
  const row = await db.selectFrom('agent_sandbox_objects')
    .selectAll()
    .where('id', '=', input.artifactId)
    .where('tenant_id', '=', input.tenantId)
    .where('workspace_id', '=', input.workspaceId)
    .where('object_type', '=', 'artifact')
    .executeTakeFirst()
  if (row === undefined || (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())) return null
  return {
    ref: artifactRef(row),
    bytes: Buffer.from(row.bytes),
  }
}

async function committedArtifactRefs(
  trx: Kysely<Database> | Transaction<Database>,
  commit: Row<'agent_sandbox_artifact_commits'>,
): Promise<SandboxArtifactRef[]> {
  const ids = parseArtifactIds(commit.artifact_ids_json)
  if (ids.length === 0) return []
  const rows = await trx.selectFrom('agent_sandbox_objects')
    .selectAll()
    .where('tenant_id', '=', commit.tenant_id)
    .where('workspace_id', '=', commit.workspace_id)
    .where('object_type', '=', 'artifact')
    .where('id', 'in', ids)
    .execute()
  const byId = new Map(rows.map((row) => [row.id, row]))
  return ids.map((id) => {
    const row = byId.get(id)
    if (row === undefined) throw new Error('sandbox_artifact_commit_incomplete')
    return artifactRef(row)
  })
}

async function committedArtifactResult(
  trx: Kysely<Database> | Transaction<Database>,
  commit: Row<'agent_sandbox_artifact_commits'>,
  input: Parameters<SandboxArtifactPersistencePort['persistArtifacts']>[0],
  expected: readonly SandboxArtifactRef[],
): Promise<SandboxArtifactPersistenceResult> {
  let artifactIds: string[]
  try {
    artifactIds = parseArtifactIds(commit.artifact_ids_json)
  } catch {
    return unknownArtifactPersistence(input.idempotencyKey)
  }
  if (
    commit.tenant_id !== input.scope.tenantId ||
    commit.workspace_id !== input.scope.workspaceId ||
    commit.run_id !== input.scope.runId ||
    commit.sandbox_session_id !== input.scope.sandboxSessionId ||
    commit.tool_call_id !== input.scope.toolCallId ||
    artifactIds.length !== expected.length ||
    artifactIds.some((id, index) => id !== expected[index]?.artifactId)
  ) {
    return unknownArtifactPersistence(input.idempotencyKey)
  }
  try {
    const artifacts = await committedArtifactRefs(trx, commit)
    if (!artifactRefsMatch(artifacts, expected)) return unknownArtifactPersistence(input.idempotencyKey)
    return { status: 'committed', artifacts }
  } catch {
    return unknownArtifactPersistence(input.idempotencyKey)
  }
}

function storedArtifactMatches(
  row: Row<'agent_sandbox_objects'>,
  input: Parameters<SandboxArtifactPersistencePort['persistArtifacts']>[0],
  expected: SandboxArtifactRef,
  bytes: Buffer,
): boolean {
  return row.tenant_id === input.scope.tenantId &&
    row.workspace_id === input.scope.workspaceId &&
    row.object_type === 'artifact' &&
    row.object_version === `v1_${expected.contentHash}` &&
    row.name === expected.name &&
    row.file_kind === expected.kind &&
    row.content_hash === expected.contentHash &&
    row.size_bytes === expected.sizeBytes &&
    Buffer.from(row.bytes).equals(bytes)
}

function artifactRefsMatch(actual: readonly SandboxArtifactRef[], expected: readonly SandboxArtifactRef[]): boolean {
  return actual.length === expected.length && actual.every((artifact, index) => {
    const target = expected[index]
    return target !== undefined &&
      artifact.artifactId === target.artifactId &&
      artifact.kind === target.kind &&
      artifact.name === target.name &&
      artifact.sizeBytes === target.sizeBytes &&
      artifact.contentHash === target.contentHash
  })
}

function unknownArtifactPersistence(idempotencyKey: string): SandboxArtifactPersistenceResult {
  return {
    status: 'unknown',
    reconciliationRef: `artifact_reconcile_${sha256(idempotencyKey).slice(0, 32)}`,
  }
}

function artifactRef(row: Row<'agent_sandbox_objects'>): SandboxArtifactRef {
  return {
    artifactId: row.id,
    kind: row.file_kind as SandboxArtifactRef['kind'],
    name: row.name,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
  }
}

function parseArtifactIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('sandbox_artifact_commit_invalid')
  }
  return parsed
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}
