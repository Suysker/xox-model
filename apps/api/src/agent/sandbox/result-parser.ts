import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { SandboxArtifactKind, SandboxObservation } from '@xox/contracts'
import type { SandboxArtifactDescriptor } from './backend.js'
import { redactSecretLikeContent } from '../memory-safety.js'

type ParsedSandboxOutput = {
  result: SandboxObservation['result']
  outputText: string
  extraction: SandboxObservation['extraction']
  artifacts: SandboxArtifactDescriptor[]
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

function parseJson(value: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(value) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid_json' }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

function tablesFromStructuredOutput(value: unknown): Array<{ name: string; rows: unknown[] }> | undefined {
  const item = record(value)
  if (!item || !Array.isArray(item.tables)) return undefined
  const tables = item.tables.filter((table): table is { name: string; rows: unknown[] } =>
    Boolean(table && typeof table === 'object' && typeof (table as Record<string, unknown>).name === 'string' && Array.isArray((table as Record<string, unknown>).rows)))
  return tables.length > 0 ? tables : undefined
}

function outputText(input: { stdout: string; stderr: string }) {
  return [input.stdout.trim(), input.stderr.trim()]
    .filter(Boolean)
    .join('\n')
}

function redactStructuredSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretLikeContent(value)
  if (Array.isArray(value)) return value.map((item) => redactStructuredSecrets(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactStructuredSecrets(item)]),
  )
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
  stderr: string
  status: SandboxObservation['status']
  purpose: string
  allowedKinds: SandboxArtifactKind[]
  maxArtifactCount: number
  maxArtifactBytes: number
  sessionId: string
}): Promise<ParsedSandboxOutput> {
  const resultPath = join(input.outputDir, 'result.json')
  const resultText = await readFile(resultPath, 'utf8').catch(() => null)
  const stdoutText = redactSecretLikeContent(input.stdout)
  const stderrText = redactSecretLikeContent(input.stderr)
  const modelOutputText = outputText({ stdout: stdoutText, stderr: stderrText })
  const artifacts = await collectSandboxArtifacts({
    outputDir: input.outputDir,
    allowedKinds: input.allowedKinds,
    maxArtifactCount: input.maxArtifactCount,
    maxArtifactBytes: input.maxArtifactBytes,
    sessionId: input.sessionId,
  })
  const rawParseSource = resultText ?? input.stdout
  const parsed = rawParseSource.trim().length > 0 ? parseJson(rawParseSource) : { ok: false as const, error: 'empty_output' }
  const parsedOutput = parsed.ok ? redactStructuredSecrets(parsed.value) : null
  const artifactSummary = artifacts.length > 0 ? `生成 ${artifacts.length} 个输出文件。` : ''
  const fallbackSummary = modelOutputText.trim().slice(0, 500) ||
    artifactSummary ||
    (input.status === 'completed' ? `${input.purpose} 已完成。` : `${input.purpose} 未完成。`)
  const result = !parsed.ok
    ? {
      summary: fallbackSummary,
      structured: modelOutputText.trim().length > 0 ? { outputText: modelOutputText } : null,
      proposedPatches: [],
    }
    : resultFromStructuredOutput(parsedOutput, fallbackSummary)
  const extractedTables = parsed.ok ? tablesFromStructuredOutput(parsedOutput) : undefined
  const extraction: SandboxObservation['extraction'] = parsed.ok
    ? {
      extractionStatus: 'parsed',
      parsedOutput,
      ...(extractedTables ? { tables: extractedTables } : {}),
      summary: result.summary,
    }
    : {
      extractionStatus: modelOutputText.trim().length > 0 || artifacts.length > 0 ? 'text_only' : 'empty',
      ...(modelOutputText.trim().length > 0 || artifactSummary ? { summary: fallbackSummary } : {}),
      ...(rawParseSource.trim().length > 0 ? { warnings: [`structured_extraction_failed: ${parsed.error}`] } : {}),
    }
  return {
    result,
    outputText: modelOutputText,
    extraction,
    artifacts,
  }
}
