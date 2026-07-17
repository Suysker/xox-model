import { createHash, randomBytes } from 'node:crypto'
import type {
  AgentSandboxExecutionInput,
  AgentSandboxExecutionResult,
} from '@agentic-os/contracts'
import { projectModel, type ModelConfig, type ScenarioResult } from '@xox/domain'
import type {
  SandboxArtifactKind,
  SandboxCapabilityProfile,
  SandboxDataScope,
  SandboxFileKind,
  SandboxRunCodeInput,
} from '@xox/contracts'
import type { Kysely } from 'kysely'
import type { Database, Row } from '../db/schema.js'
import { draftContext, getWorkspaceDraft } from '../modules/workspace.js'
import { listEntries, listPeriods } from '../modules/ledger.js'
import type { CurrentUser } from '../modules/auth.js'
import {
  type RuntimeToolStep,
} from './host-profile/xox-runtime-items.js'
import type { AgentTurnContext } from './host-profile/xox-runtime-items.js'
import type {
  SandboxDataBundle,
  SandboxDataScope as AgenticSandboxDataScope,
  SandboxToolDocument,
  SandboxToolSdkEntry,
  SandboxManifest,
} from '@agentic-os/sandbox'
import {
  createAgenticOsProductionSandboxPort,
  normalizeSandboxDataScope,
  SandboxBroker,
} from '@agentic-os/sandbox'
import { AGENT_TOOL_REGISTRY, toolCallToRuntimeStep, type AgentToolRegistryEntry, type AgentToolRiskLevel } from './tool-catalog.js'
import { createXoxSandboxStorage, type XoxSandboxInputDescriptor } from './sandbox-storage.js'

type SandboxExpectedOutput = NonNullable<SandboxRunCodeInput['expectedOutputs']>[number]

type SandboxServiceContext = {
  db: Kysely<Database>
  workspace: Row<'workspaces'>
  user: CurrentUser
  threadId: string
  runId: string
}

type SandboxManifestContext = {
  workspace: { id: string; owner_id: string }
  user: { id: string }
  threadId: string
  runId: string
}

const DEFAULT_SANDBOX_ARTIFACT_KINDS: SandboxArtifactKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'txt',
  'md',
  'pdf',
  'docx',
]

const DEFAULT_CAPABILITIES: SandboxCapabilityProfile = {
  filesystem: 'input_readonly_output_tmp',
  shell: false,
  packageInstall: false,
  internalApi: false,
  productionDatabase: false,
  objectStorage: 'selected_upload_readonly',
  providerSecrets: false,
  userSessionTokens: false,
  businessWrites: false,
  memoryWrites: false,
  accountActions: false,
}

export const SANDBOX_FILE_KINDS: readonly SandboxFileKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'xls',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'htm',
  'txt',
  'md',
  'pdf',
  'docx',
  'doc',
]

export const SANDBOX_ARTIFACT_KINDS: readonly SandboxArtifactKind[] = [
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'html',
  'txt',
  'md',
  'pdf',
  'docx',
]

export type SandboxFileFamily =
  | 'spreadsheet'
  | 'structured_text'
  | 'web_document'
  | 'image'
  | 'pdf'
  | 'word_document'

export type SandboxFileAdapter = {
  kind: SandboxFileKind
  family: SandboxFileFamily
  extensions: string[]
  mimeTypes: string[]
  legacyBinary?: boolean
  outputAllowed: boolean
}

export type SandboxUploadedFile = {
  name: string
  sizeBytes: number
  mimeType?: string | null
  bytes?: Uint8Array
}

export type SandboxFilePreview = {
  kind: SandboxFileKind
  family: SandboxFileFamily
  status: 'accepted' | 'blocked'
  reason?: string
  warnings: string[]
  normalized: {
    rows?: unknown[]
    textPreview?: string
    metadata?: Record<string, unknown>
  }
}

const MAX_INPUT_FILE_BYTES = 25 * 1024 * 1024
const MAX_TEXT_PREVIEW_CHARS = 4000
const MAX_PREVIEW_ROWS = 20

const adapters: SandboxFileAdapter[] = [
  { kind: 'csv', family: 'spreadsheet', extensions: ['.csv'], mimeTypes: ['text/csv', 'application/csv', 'text/plain'], outputAllowed: true },
  { kind: 'tsv', family: 'spreadsheet', extensions: ['.tsv'], mimeTypes: ['text/tab-separated-values', 'text/plain'], outputAllowed: true },
  { kind: 'xlsx', family: 'spreadsheet', extensions: ['.xlsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], outputAllowed: true },
  { kind: 'xls', family: 'spreadsheet', extensions: ['.xls'], mimeTypes: ['application/vnd.ms-excel'], legacyBinary: true, outputAllowed: false },
  { kind: 'json', family: 'structured_text', extensions: ['.json'], mimeTypes: ['application/json', 'text/json', 'text/plain'], outputAllowed: true },
  { kind: 'jsonl', family: 'structured_text', extensions: ['.jsonl', '.ndjson'], mimeTypes: ['application/x-ndjson', 'application/jsonl', 'text/plain'], outputAllowed: true },
  { kind: 'txt', family: 'structured_text', extensions: ['.txt'], mimeTypes: ['text/plain'], outputAllowed: true },
  { kind: 'md', family: 'structured_text', extensions: ['.md', '.markdown'], mimeTypes: ['text/markdown', 'text/plain'], outputAllowed: true },
  { kind: 'html', family: 'web_document', extensions: ['.html'], mimeTypes: ['text/html'], outputAllowed: true },
  { kind: 'htm', family: 'web_document', extensions: ['.htm'], mimeTypes: ['text/html'], outputAllowed: false },
  { kind: 'png', family: 'image', extensions: ['.png'], mimeTypes: ['image/png'], outputAllowed: true },
  { kind: 'jpg', family: 'image', extensions: ['.jpg'], mimeTypes: ['image/jpeg'], outputAllowed: true },
  { kind: 'jpeg', family: 'image', extensions: ['.jpeg'], mimeTypes: ['image/jpeg'], outputAllowed: true },
  { kind: 'webp', family: 'image', extensions: ['.webp'], mimeTypes: ['image/webp'], outputAllowed: true },
  { kind: 'pdf', family: 'pdf', extensions: ['.pdf'], mimeTypes: ['application/pdf'], outputAllowed: true },
  { kind: 'docx', family: 'word_document', extensions: ['.docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], outputAllowed: true },
  { kind: 'doc', family: 'word_document', extensions: ['.doc'], mimeTypes: ['application/msword'], legacyBinary: true, outputAllowed: false },
]

export function sandboxFileAdapterForKind(kind: SandboxFileKind) {
  return adapters.find((adapter) => adapter.kind === kind) ?? null
}

export function sandboxFileAdapters() {
  return adapters.slice()
}

export function normalizeSandboxFileKind(value: unknown): SandboxFileKind | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/^\./, '').toLowerCase()
  return (SANDBOX_FILE_KINDS as readonly string[]).includes(normalized)
    ? normalized as SandboxFileKind
    : null
}

export function normalizeSandboxFileKinds(value: unknown): SandboxFileKind[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kinds: SandboxFileKind[] = []
  for (const raw of rawValues) {
    const kind = normalizeSandboxFileKind(raw)
    if (kind && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

export function normalizeSandboxArtifactKinds(value: unknown): SandboxArtifactKind[] {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const kinds: SandboxArtifactKind[] = []
  for (const raw of rawValues) {
    if (typeof raw !== 'string') continue
    const normalized = raw.trim().replace(/^\./, '').toLowerCase()
    if ((SANDBOX_ARTIFACT_KINDS as readonly string[]).includes(normalized) && !kinds.includes(normalized as SandboxArtifactKind)) {
      kinds.push(normalized as SandboxArtifactKind)
    }
  }
  return kinds
}

function extensionOf(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

function bytesPrefix(bytes: Uint8Array, length: number) {
  return Array.from(bytes.slice(0, length)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function asciiPreview(bytes: Uint8Array) {
  return Buffer.from(bytes).toString('latin1').slice(0, 12000)
}

function magicMatchesKind(kind: SandboxFileKind, bytes?: Uint8Array) {
  if (!bytes || bytes.length === 0) return true
  const prefix4 = bytesPrefix(bytes, 4)
  const prefix8 = bytesPrefix(bytes, 8)
  if (kind === 'png') return prefix8 === '89504e470d0a1a0a'
  if (kind === 'jpg' || kind === 'jpeg') return prefix4.startsWith('ffd8ff')
  if (kind === 'webp') return asciiPreview(bytes).startsWith('RIFF') && asciiPreview(bytes).slice(8, 12) === 'WEBP'
  if (kind === 'pdf') return Buffer.from(bytes.slice(0, 5)).toString('ascii') === '%PDF-'
  if (kind === 'xlsx' || kind === 'docx') return prefix4 === '504b0304' || prefix4 === '504b0506' || prefix4 === '504b0708'
  if (kind === 'xls' || kind === 'doc') return prefix8.startsWith('d0cf11e0a1b11ae1')
  return true
}

function mimeMatches(adapter: SandboxFileAdapter, mimeType?: string | null) {
  if (!mimeType) return true
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return normalized.length === 0 || adapter.mimeTypes.includes(normalized)
}

function decodeText(bytes?: Uint8Array) {
  if (!bytes) return ''
  return Buffer.from(bytes).toString('utf8').replace(/\u0000/g, '')
}

function parseDelimitedRows(text: string, delimiter: string) {
  return text.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_PREVIEW_ROWS)
    .map((line) => line.split(delimiter).map((cell) => cell.trim()))
}

function sanitizeHtml(text: string) {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, MAX_TEXT_PREVIEW_CHARS)
}

function activeContentReason(kind: SandboxFileKind, text: string) {
  if ((kind === 'html' || kind === 'htm') && (/<script\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript:/i.test(text))) {
    return 'html_active_content'
  }
  if (kind === 'pdf' && (/\/JavaScript\b/i.test(text) || /\/Launch\b/i.test(text) || /\/EmbeddedFile\b/i.test(text))) {
    return 'pdf_active_content'
  }
  if ((kind === 'docx' || kind === 'xlsx' || kind === 'doc' || kind === 'xls') && /vbaProject/i.test(text)) {
    return 'office_macro'
  }
  return null
}

function normalizedPreview(kind: SandboxFileKind, text: string) {
  if (kind === 'csv') return { rows: parseDelimitedRows(text, ',') }
  if (kind === 'tsv') return { rows: parseDelimitedRows(text, '\t') }
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(text)
      return { metadata: { rootType: Array.isArray(parsed) ? 'array' : typeof parsed }, textPreview: JSON.stringify(parsed, null, 2).slice(0, MAX_TEXT_PREVIEW_CHARS) }
    } catch {
      return { textPreview: text.slice(0, MAX_TEXT_PREVIEW_CHARS) }
    }
  }
  if (kind === 'jsonl') return { rows: text.split(/\r?\n/).filter(Boolean).slice(0, MAX_PREVIEW_ROWS).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return line
    }
  }) }
  if (kind === 'html' || kind === 'htm') return { textPreview: sanitizeHtml(text) }
  if (kind === 'txt' || kind === 'md') return { textPreview: text.slice(0, MAX_TEXT_PREVIEW_CHARS) }
  return { metadata: { binaryPreview: true } }
}

export function inspectSandboxUploadedFile(file: SandboxUploadedFile): SandboxFilePreview {
  const kind = normalizeSandboxFileKind(extensionOf(file.name))
  if (!kind) {
    return {
      kind: 'txt',
      family: 'structured_text',
      status: 'blocked',
      reason: 'unsupported_extension',
      warnings: [],
      normalized: { metadata: { fileName: file.name } },
    }
  }
  const adapter = sandboxFileAdapterForKind(kind)
  if (!adapter) {
    return {
      kind,
      family: 'structured_text',
      status: 'blocked',
      reason: 'missing_adapter',
      warnings: [],
      normalized: { metadata: { fileName: file.name } },
    }
  }
  const warnings = adapter.legacyBinary ? ['legacy_binary_requires_hardened_conversion'] : []
  const extension = extensionOf(file.name)
  const text = file.bytes ? (adapter.family === 'image' ? '' : decodeText(file.bytes) || asciiPreview(file.bytes)) : ''
  const activeReason = activeContentReason(kind, text || (file.bytes ? asciiPreview(file.bytes) : ''))
  const blockedReason = file.sizeBytes > MAX_INPUT_FILE_BYTES
    ? 'file_too_large'
    : !adapter.extensions.includes(extension)
      ? 'extension_mismatch'
      : !mimeMatches(adapter, file.mimeType)
        ? 'mime_mismatch'
        : !magicMatchesKind(kind, file.bytes)
          ? 'magic_mismatch'
          : activeReason

  return {
    kind,
    family: adapter.family,
    status: blockedReason ? 'blocked' : 'accepted',
    ...(blockedReason ? { reason: blockedReason } : {}),
    warnings,
    normalized: {
      ...normalizedPreview(kind, text),
      metadata: {
        ...(normalizedPreview(kind, text).metadata ?? {}),
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType ?? null,
        legacyBinary: Boolean(adapter.legacyBinary),
      },
    },
  }
}

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : []
}

function serializeToolManifestDocument(input: { title: string; tools: SandboxToolSdkEntry[] }) {
  return [
    `# ${input.title}`,
    '',
    'These tools are scoped to this sandbox session. Function names, arguments and result contracts mirror the provider tool registry.',
    '',
    ...input.tools.map((tool) => [
      `## ${tool.name}`,
      '',
      `- capability: ${tool.capability}`,
      `- riskLevel: ${tool.riskLevel}`,
      `- confirmationMode: ${tool.confirmationMode}`,
      `- navigationTarget: ${tool.navigationTarget ?? 'none'}`,
      `- parameters: ${tool.parameterNames.length > 0 ? tool.parameterNames.join(', ') : 'none'}`,
      `- summary: ${tool.summary}`,
      '',
    ].join('\n')),
  ].join('\n')
}

function toolSchemaParameterNames(schema: AgentToolRegistryEntry['tool']['function']['parameters']): string[] {
  const properties = schema.properties
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties)
    : []
}

function buildSandboxToolSdk(): { tools: SandboxToolSdkEntry[]; documents: SandboxToolDocument[] } {
  const tools = AGENT_TOOL_REGISTRY.map((entry): SandboxToolSdkEntry => ({
    name: entry.name,
    capability: entry.capability,
    riskLevel: entry.riskLevel,
    confirmationMode: entry.confirmationMode,
    navigationTarget: entry.navigationTarget,
    parameterNames: toolSchemaParameterNames(entry.tool.function.parameters),
    summary: entry.tool.function.description,
  }))
  const manifestText = serializeToolManifestDocument({ title: 'xox-model Agent Tool Manifest', tools })
  return {
    tools,
    documents: [
      { path: 'tools/agent-tool-manifest.md', text: manifestText },
      { path: 'tools/effective-tool-manifest.md', text: manifestText },
      {
        path: 'tools/sandbox-sdk.md',
        text: [
          '# agentic_os_sandbox SDK',
          '',
          'Prefer agentic_os_sandbox.load_structured()/load_rows() in Python, or loadStructured()/loadRows() from ./agentic_os_sandbox.mjs in JavaScript, to consume the manifest-scoped dataRequest bundle.',
          'Emit structured output with agentic_os_sandbox.emit(...) or emit(...); do not guess raw mounted file paths or depend on raw output path environment variables.',
          'Business tool bridge functions exist only for controlled advanced cases; they are not a substitute for top-level provider tool calls when a business fact or action should be visible in the agent transcript.',
          'Write tool bridge calls record nested Tool Runtime requests and may produce one aggregate approval; they never bypass Agentic OS confirmation, validation, or audit.',
        ].join('\n'),
      },
    ],
  }
}

function asSandboxDataScope(value: unknown): SandboxDataScope {
  return value === 'time_series_records' ||
    value === 'tabular_records' ||
    value === 'entity_records' ||
    value === 'uploaded_file' ||
    value === 'custom_bundle'
    ? value
    : 'summary_records'
}

function normalizeSandboxInput(step: RuntimeToolStep): SandboxRunCodeInput {
  const dataRequest = step.dataRequest && typeof step.dataRequest === 'object'
    ? step.dataRequest as Record<string, unknown>
    : {}
  const language = step.language === 'javascript' ? 'javascript' : 'python'
  const code = typeof step.code === 'string' ? step.code : ''
  const purpose = typeof step.purpose === 'string' && step.purpose.trim()
    ? step.purpose.trim()
    : typeof step.question === 'string' && step.question.trim()
      ? step.question.trim()
      : '运行受控沙箱任务'
  return {
    purpose,
    language,
    code,
    dataRequest: {
      scope: asSandboxDataScope(dataRequest.scope ?? step.scope),
      fields: asStringArray(dataRequest.fields ?? step.fields),
      monthLabels: asStringArray(dataRequest.monthLabels ?? step.monthLabels),
      fileIds: asStringArray(dataRequest.fileIds ?? step.fileIds),
      fileKinds: normalizeSandboxFileKinds(dataRequest.fileKinds ?? step.fileKinds),
      ...(typeof dataRequest.rowLimit === 'number' || typeof step.rowLimit === 'number'
        ? { rowLimit: Math.max(1, Math.min(5000, Math.round(Number(dataRequest.rowLimit ?? step.rowLimit)))) }
        : {}),
    },
    expectedOutputs: Array.isArray(step.expectedOutputs)
      ? step.expectedOutputs.filter((item): item is SandboxExpectedOutput =>
        item === 'json' ||
        item === 'table' ||
        item === 'chart' ||
        item === 'csv' ||
        item === 'spreadsheet' ||
        item === 'document' ||
        item === 'image' ||
        item === 'markdown')
      : [],
  }
}

async function currentProjection(ctx: SandboxServiceContext) {
  const draft = await getWorkspaceDraft(ctx.db, ctx.workspace)
  const { config } = draftContext(draft)
  return { config, projection: projectModel(config) }
}

function sandboxMonthRows(baseScenario: ScenarioResult | null, monthLabels: Set<string>, rowLimit: number) {
  return (baseScenario?.months ?? [])
    .filter((month) => monthLabels.size === 0 || monthLabels.has(month.label))
    .slice(0, rowLimit)
    .map((month) => ({
      monthIndex: month.monthIndex,
      monthLabel: month.label,
      grossSales: month.grossSales,
      plannedRevenue: month.grossSales,
      totalCost: month.totalCost,
      plannedCost: month.totalCost,
      monthlyProfit: month.monthlyProfit,
      plannedProfit: month.monthlyProfit,
      cumulativeCash: month.cumulativeCash,
      cash: month.cumulativeCash,
    }))
}

function sandboxShareholderRows(config: ModelConfig) {
  return config.shareholders.map((shareholder, index) => ({
    index: index + 1,
    id: shareholder.id,
    name: shareholder.name,
    investmentAmount: shareholder.investmentAmount,
    dividendRate: shareholder.dividendRate,
  }))
}

function buildProjectionStructuredBundle(args: {
  scope: SandboxDataScope
  workspaceName: string
  config: ModelConfig
  baseScenario: ScenarioResult | null
  monthLabels?: Set<string>
  rowLimit?: number
}) {
  const monthLabels = args.monthLabels ?? new Set<string>()
  const rowLimit = args.rowLimit ?? 500
  const months = sandboxMonthRows(args.baseScenario, monthLabels, rowLimit)
  const shareholders = sandboxShareholderRows(args.config)
  const grossSales = months.reduce((sum, month) => sum + month.grossSales, 0)
  const totalCost = months.reduce((sum, month) => sum + month.totalCost, 0)
  const totalProfit = grossSales - totalCost
  const totalInvestment = shareholders.reduce((sum, shareholder) => sum + shareholder.investmentAmount, 0)
  const fullProjection = monthLabels.size === 0
  const endingCash = months.at(-1)?.cumulativeCash ?? 0
  const netCashAfterInvestment = fullProjection
    ? args.baseScenario?.netCashAfterInvestment ?? endingCash
    : endingCash
  return {
    scope: args.scope,
    workspaceName: args.workspaceName,
    monthCount: months.length,
    grossSales,
    totalCost,
    totalProfit,
    totalInvestment: args.baseScenario?.totalInvestment ?? totalInvestment,
    netCashAfterInvestment,
    roi: fullProjection && args.baseScenario ? args.baseScenario.roi : totalInvestment > 0 ? netCashAfterInvestment / totalInvestment : 0,
    endingCash,
    paybackMonthLabel: fullProjection ? args.baseScenario?.paybackMonthLabel ?? null : null,
    months,
    rows: months,
    shareholders,
    firstShareholder: shareholders[0] ?? null,
  }
}

async function buildSandboxDataBundle(ctx: SandboxServiceContext, input: SandboxRunCodeInput): Promise<SandboxDataBundle> {
  const { config, projection } = await currentProjection(ctx)
  const baseScenario = projection.scenarios.find((scenario) => scenario.key === 'base') ?? projection.scenarios[0] ?? null
  const scope = input.dataRequest.scope
  const fields = input.dataRequest.fields ?? []
  const monthLabels = new Set(input.dataRequest.monthLabels ?? [])
  const rowLimit = input.dataRequest.rowLimit ?? 500

  let rows: unknown[] | undefined
  let structured: unknown
  let fileCount: number | undefined
  let fileKinds: SandboxFileKind[] | undefined
  let files: XoxSandboxInputDescriptor[] | undefined

  if (scope === 'time_series_records') {
    structured = buildProjectionStructuredBundle({
      scope,
      workspaceName: ctx.workspace.name,
      config,
      baseScenario,
      monthLabels,
      rowLimit,
    })
    rows = (structured as { rows: unknown[] }).rows
  } else if (scope === 'entity_records') {
    structured = {
      teamMembers: config.teamMembers.map((member, index) => ({
        index: index + 1,
        id: member.id,
        name: member.name,
        monthlyBasePay: member.monthlyBasePay,
        commissionRate: member.commissionRate,
      })),
      shareholders: config.shareholders.map((shareholder, index) => ({
        index: index + 1,
        id: shareholder.id,
        name: shareholder.name,
        investmentAmount: shareholder.investmentAmount,
        dividendRate: shareholder.dividendRate,
      })),
      employees: config.employees.map((employee, index) => ({
        index: index + 1,
        id: employee.id,
        name: employee.name,
        role: employee.role,
        monthlyBasePay: employee.monthlyBasePay,
        perEventCost: employee.perEventCost,
      })),
    }
    rows = [
      ...config.teamMembers,
      ...config.shareholders,
      ...config.employees,
    ].slice(0, rowLimit)
  } else if (scope === 'tabular_records') {
    const periods = await listPeriods(ctx.db, ctx.workspace)
    const targetPeriods = periods.filter((period) => monthLabels.size === 0 || monthLabels.has(period.monthLabel))
    rows = []
    for (const period of targetPeriods) {
      const entries = await listEntries(ctx.db, ctx.workspace, period.id)
      rows.push(...entries.map((entry) => ({ monthLabel: period.monthLabel, ...entry })))
      if (rows.length >= rowLimit) break
    }
    rows = rows.slice(0, rowLimit)
    structured = { scope, rows }
  } else if (scope === 'uploaded_file' || scope === 'custom_bundle') {
    const fileIds = input.dataRequest.fileIds ?? []
    files = await createXoxSandboxStorage(ctx.db).describeInputFiles({
      tenantId: ctx.workspace.owner_id,
      workspaceId: ctx.workspace.id,
      fileIds,
      ...(input.dataRequest.fileKinds !== undefined
        ? { expectedKinds: input.dataRequest.fileKinds }
        : {}),
    })
    fileKinds = files.map((file) => file.kind)
    fileCount = files.length
    structured = {
      scope,
      files: files.map((file) => ({
        fileId: file.fileId,
        kind: file.kind,
        originVersion: file.originVersion,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
      })),
      note: '文件内容由 File Adapter Registry 解析后进入 manifest-scoped 沙箱。',
    }
  } else {
    structured = buildProjectionStructuredBundle({
      scope,
      workspaceName: ctx.workspace.name,
      config,
      baseScenario,
      monthLabels: new Set(),
      rowLimit,
    })
    rows = [structured]
  }

  const bundle = {
    scope,
    fields,
    rows,
    fileCount,
    fileKinds,
    files,
    structured,
  }
  return {
    bundleId: `bundle_${shortHash(`${ctx.runId}:${scope}:${JSON.stringify(bundle)}`)}`,
    scope,
    fields: fields.length > 0 ? fields : Object.keys((structured ?? rows?.[0] ?? {}) as Record<string, unknown>).slice(0, 20),
    structured,
    ...(rows ? { rows, rowCount: rows.length } : {}),
    ...(fileCount !== undefined ? { fileCount } : {}),
    ...(fileKinds !== undefined ? { fileKinds } : {}),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    redactions: 0,
    contentHash: hashJson(bundle),
  }
}

function outputKindsForExpectedOutputs(expectedOutputs: SandboxRunCodeInput['expectedOutputs']) {
  const requested = new Set(expectedOutputs ?? [])
  const kinds: SandboxArtifactKind[] = []
  if (requested.has('csv')) kinds.push('csv')
  if (requested.has('spreadsheet')) kinds.push('xlsx')
  if (requested.has('document')) kinds.push('pdf', 'docx')
  if (requested.has('image') || requested.has('chart')) kinds.push('png')
  if (requested.has('markdown')) kinds.push('md')
  if (requested.has('json') || requested.has('table')) kinds.push('json')
  return kinds.length > 0 ? kinds : ['json', 'csv', 'xlsx', 'png', 'txt', 'md']
}

function buildManifest(ctx: SandboxManifestContext, input: SandboxRunCodeInput, bundle: SandboxDataBundle, toolCallId: string): SandboxManifest {
  const allowedArtifactKinds = normalizeSandboxArtifactKinds(outputKindsForExpectedOutputs(input.expectedOutputs))
  const manifestSeed = `${ctx.workspace.id}:${ctx.runId}:${toolCallId}:${bundle.bundleId}:${bundle.contentHash}`
  const inputBundleKind: AgenticSandboxDataScope = normalizeSandboxDataScope(bundle.scope)
  return {
    schemaVersion: 1,
    manifestId: `manifest_${shortHash(manifestSeed)}`,
    nonce: randomBytes(16).toString('hex'),
    identity: {
      tenantId: ctx.workspace.owner_id,
      workspaceId: ctx.workspace.id,
      threadId: ctx.threadId,
      runId: ctx.runId,
      toolCallId,
      userIdHash: shortHash(ctx.user.id),
    },
    inputBundle: {
      bundleId: bundle.bundleId,
      kind: inputBundleKind,
      schemaVersion: 'xox.sandbox.bundle.v1',
      mountPath: '/input',
      readonly: true,
      fields: bundle.fields,
      ...(bundle.rowCount !== undefined ? { rowCount: bundle.rowCount } : {}),
      ...(bundle.fileCount !== undefined ? { fileCount: bundle.fileCount } : {}),
      ...(bundle.fileKinds && bundle.fileKinds.length > 0 ? { fileKinds: bundle.fileKinds } : {}),
      redactions: bundle.redactions,
      contentHash: bundle.contentHash,
    },
    runtime: {
      language: input.language,
      entrypoint: 'single_script',
      timeoutMs: 10_000,
      computeMs: 5_000,
      memoryMb: 256,
      processLimit: 1,
      openFileLimit: 64,
      stdoutLimitBytes: 32_768,
      stderrLimitBytes: 32_768,
    },
    capabilities: DEFAULT_CAPABILITIES,
    network: {
      mode: 'disabled',
      allowlist: [],
    },
    outputPolicy: {
      writableMountPath: '/output',
      maxArtifactCount: 5,
      maxArtifactBytes: 10 * 1024 * 1024,
      allowedArtifactKinds: allowedArtifactKinds.length > 0 ? allowedArtifactKinds : DEFAULT_SANDBOX_ARTIFACT_KINDS,
      expiresInSeconds: 24 * 60 * 60,
    },
  }
}

export function xoxProductionSandboxManifests(): SandboxManifest[] {
  const bundle: SandboxDataBundle = {
    bundleId: 'xox_sandbox_startup_bundle',
    scope: 'summary_records',
    fields: [],
    structured: {},
    redactions: 0,
    contentHash: hashJson({ scope: 'summary_records', structured: {} }),
  }
  const context: SandboxManifestContext = {
    workspace: { id: 'xox_sandbox_startup_workspace', owner_id: 'xox_sandbox_startup_tenant' },
    user: { id: 'xox_sandbox_startup_user' },
    threadId: 'xox_sandbox_startup_thread',
    runId: 'xox_sandbox_startup_run',
  }
  return (['python', 'javascript'] as const).map((language) => buildManifest(context, {
    purpose: `Verify ${language} production sandbox readiness`,
    language,
    code: language === 'python' ? 'print("ready")' : 'console.log("ready")',
    dataRequest: { scope: 'summary_records' },
    expectedOutputs: ['json'],
  }, bundle, `xox_sandbox_startup_${language}`))
}

function sandboxStepFromOsInput(input: AgentSandboxExecutionInput): RuntimeToolStep {
  return {
    ...input.input,
    providerToolCallId: input.toolCall.toolCallId,
    providerToolName: input.tool.name,
    ...(input.toolCall.sourceIndex !== undefined ? { providerToolCallIndex: input.toolCall.sourceIndex } : {}),
    providerToolArguments: input.input,
    intent: input.tool.name === 'sandbox_run_code' ? 'sandbox.run_code' : input.tool.name,
  }
}

export async function executeXoxSandboxForAgenticOs(
  ctx: AgentTurnContext,
  input: AgentSandboxExecutionInput,
  broker: SandboxBroker,
): Promise<AgentSandboxExecutionResult> {
  const step = sandboxStepFromOsInput(input)
  const toolInput = normalizeSandboxInput(step)
  const toolCallId = step.providerToolCallId ?? `sandbox_${shortHash(`${ctx.runId}:${toolInput.purpose}`)}`
  try {
    const bundle = await buildSandboxDataBundle(ctx, toolInput)
    const manifest = buildManifest(ctx, toolInput, bundle, toolCallId)
    const productionPort = createAgenticOsProductionSandboxPort({
      broker,
      prepareExecution: async () => ({
        manifest,
        toolInput,
        bundle,
        toolSdk: buildSandboxToolSdk(),
      }),
    })
    return productionPort.executeSandbox(input)
  } catch (error) {
    const reason = error instanceof Error && error.message === 'sandbox_input_file_resolution_failed'
      ? error.message
      : 'sandbox_preparation_failed'
    return {
      content: { status: 'failed', reason },
      manifestScoped: true,
      executionMode: 'not_executed',
      status: 'failed',
      effectDisposition: 'none',
    }
  }
}

export const sandboxInternalsForTests = {
  normalizeSandboxInput,
  buildProjectionStructuredBundle,
  buildSandboxDataBundle,
  buildManifest,
  buildSandboxToolSdk,
}
