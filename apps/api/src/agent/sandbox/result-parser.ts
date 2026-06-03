import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { SandboxArtifactKind, SandboxManifest, SandboxObservation } from '@xox/contracts'
import type { SandboxArtifactDescriptor, SandboxDataBundle } from './backend.js'
import { redactSecretLikeContent } from '../memory-safety.js'

type ParsedSandboxOutput = {
  result: SandboxObservation['result']
  structuredOutput: unknown
  artifacts: SandboxArtifactDescriptor[]
  manifestConsumed: boolean
  manifestConsumption?: NonNullable<SandboxObservation['manifestConsumption']>
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(value: unknown, key: string) {
  const item = record(value)?.[key]
  return typeof item === 'string' ? item : null
}

function validateManifestConsumption(input: {
  structuredOutput: unknown
  manifest: SandboxManifest
  bundle: SandboxDataBundle
}) {
  const observedInput = record(input.structuredOutput)?.observedInput
  const manifestId = stringField(observedInput, 'manifestId')
  const bundleId = stringField(observedInput, 'bundleId')
  const contentHash = stringField(observedInput, 'contentHash')
  const nonce = stringField(observedInput, 'nonce')
  if (!manifestId || !bundleId || !contentHash || !nonce) {
    return { manifestConsumed: false }
  }
  const nonceMatched = nonce === input.manifest.nonce
  const manifestConsumption = {
    manifestId,
    bundleId,
    contentHash,
    nonceMatched,
  }
  return {
    manifestConsumed:
      manifestId === input.manifest.manifestId &&
      bundleId === input.bundle.bundleId &&
      contentHash === input.bundle.contentHash &&
      nonceMatched,
    manifestConsumption,
  }
}

function resultFromStructuredOutput(value: unknown, fallbackSummary: string): SandboxObservation['result'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { summary: fallbackSummary, structured: value }
  }
  const record = value as Record<string, unknown>
  const structured = Object.hasOwn(record, 'structured') ? record.structured : value
  const summary = typeof record.summary === 'string' && record.summary.trim()
    ? record.summary.trim()
    : fallbackSummary
  const tables = Array.isArray(record.tables)
    ? record.tables.filter((table): table is { name: string; rows: unknown[] } =>
      Boolean(table && typeof table === 'object' && typeof (table as Record<string, unknown>).name === 'string' && Array.isArray((table as Record<string, unknown>).rows)))
    : undefined
  return {
    summary,
    structured,
    ...(tables && tables.length > 0 ? { tables } : {}),
    proposedPatches: [],
  }
}

function artifactKindFromName(name: string): SandboxArtifactKind | null {
  const extension = extname(name).replace('.', '').toLowerCase()
  if (
    extension === 'csv' ||
    extension === 'tsv' ||
    extension === 'json' ||
    extension === 'jsonl' ||
    extension === 'xlsx' ||
    extension === 'png' ||
    extension === 'jpg' ||
    extension === 'jpeg' ||
    extension === 'webp' ||
    extension === 'html' ||
    extension === 'txt' ||
    extension === 'md' ||
    extension === 'pdf' ||
    extension === 'docx'
  ) {
    return extension
  }
  return null
}

export async function collectSandboxArtifacts(input: {
  outputDir: string
  allowedKinds: SandboxArtifactKind[]
  maxArtifactCount: number
  maxArtifactBytes: number
  sessionId: string
}): Promise<SandboxArtifactDescriptor[]> {
  const names = await readdir(input.outputDir).catch(() => [])
  const allowed = new Set(input.allowedKinds)
  const artifacts: SandboxArtifactDescriptor[] = []
  for (const name of names) {
    if (name === 'result.json') continue
    if (artifacts.length >= input.maxArtifactCount) break
    const kind = artifactKindFromName(name)
    if (!kind || !allowed.has(kind)) continue
    const absolutePath = join(input.outputDir, name)
    const info = await stat(absolutePath).catch(() => null)
    if (!info?.isFile()) continue
    if (info.size > input.maxArtifactBytes) continue
    artifacts.push({
      artifactId: `artifact_${shortHash(`${input.sessionId}:${name}:${info.size}`)}`,
      kind,
      name,
      sizeBytes: info.size,
    })
  }
  return artifacts
}

export async function parseSandboxOutput(input: {
  outputDir: string
  stdout: string
  status: SandboxObservation['status']
  purpose: string
  allowedKinds: SandboxArtifactKind[]
  maxArtifactCount: number
  maxArtifactBytes: number
  sessionId: string
  manifest: SandboxManifest
  bundle: SandboxDataBundle
}): Promise<ParsedSandboxOutput> {
  const resultPath = join(input.outputDir, 'result.json')
  const resultText = await readFile(resultPath, 'utf8').catch(() => null)
  const stdoutText = redactSecretLikeContent(input.stdout)
  const structuredOutput = resultText ? parseJson(resultText) : parseJson(stdoutText)
  const fallbackSummary = input.status === 'completed'
    ? `${input.purpose} 已完成。`
    : `${input.purpose} 未完成。`
  const result = structuredOutput === null
    ? {
      summary: stdoutText.trim().slice(0, 500) || fallbackSummary,
      structured: null,
      proposedPatches: [],
    }
    : resultFromStructuredOutput(structuredOutput, fallbackSummary)
  const artifacts = await collectSandboxArtifacts({
    outputDir: input.outputDir,
    allowedKinds: input.allowedKinds,
    maxArtifactCount: input.maxArtifactCount,
    maxArtifactBytes: input.maxArtifactBytes,
    sessionId: input.sessionId,
  })
  const consumption = validateManifestConsumption({
    structuredOutput,
    manifest: input.manifest,
    bundle: input.bundle,
  })
  return {
    result,
    structuredOutput,
    artifacts,
    manifestConsumed: consumption.manifestConsumed,
    ...(consumption.manifestConsumption ? { manifestConsumption: consumption.manifestConsumption } : {}),
  }
}
